// SPDX-License-Identifier: Apache-2.0
/**
 * The logical space backup: a STAR, the blob bytes, and the registry entry, in private storage.
 *
 * 🚨 **A backup that has not been restored is a hope.** This module captures; `space-restore.ts`
 * restores; `space-backup-staging.test.ts` deletes a real space and restores it, comparing the
 * record CIDs, the blob bytes and the commit's set hash. The three artifacts are separate on
 * purpose because the protocol keeps them separate: `getRepo` carries records and the commit
 * and no policy, member list or blob; `listBlobs` and `getBlob` carry the bytes; the registry row
 * carries the policy and members the STAR deliberately omits.
 *
 * ⭐ **The record list is stored beside the STAR, not parsed out of it.** The STAR is the
 * protocol's own full-state format and is kept for fidelity, but replaying it needs the
 * branch's STAR reader, which this deployment does not carry. `listRecords` gives the same
 * records as JSON with their CIDs, which is what the restore actually replays and compares.
 * The STAR is the artifact a future protocol-native import would take.
 *
 * ⚠️ **Blobs are stored per capture rather than deduplicated by CID.** Content addressing would
 * save space across captures, but it makes retention a reference count, and getting that wrong
 * deletes the only copy of somebody's save while a manifest still points at it. The duplicate
 * cost is bought deliberately; a later sweep can dedupe with the manifests in hand.
 */
import { db } from "@anthers/db";
import { spaceBackups, USER_SPACE_SKEY, userSpaces } from "@anthers/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
	commitDigest,
	type SpaceCommit,
	type SpaceRecord,
	SpaceRequestError,
} from "./atproto-space.js";
import { type RegistryOptions, registeredSpace } from "./space-registry.js";
import { hostedSpaceSession, spaceClientFor } from "./space-writer.js";
import { storage } from "./storage/index.js";

/** The narrow storage surface a backup needs. Injected so tests need no bucket. */
export interface BackupStore {
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	removePrefix(key: string): Promise<void>;
}

/** The production store: the app's private object storage, never a public URL. */
export const objectBackupStore: BackupStore = {
	async put(key, bytes, contentType) {
		await storage.upload(key, bytes, contentType, "private");
	},
	async get(key) {
		return storage.read(key);
	},
	async removePrefix(key) {
		await storage.deletePrefix(key);
	},
};

/** One record as the record list stores it. */
export interface BackupRecord {
	collection: string;
	rkey: string;
	cid: string;
	value: unknown;
}

/** The registry half, in the shape a restore recreates the space from. */
export interface BackupRegistry {
	did: string;
	spaceUri: string;
	spaceType: string;
	readPolicy: Record<string, unknown>;
	writePolicy: Record<string, unknown>;
	appAccess: Record<string, unknown>;
	members: Array<{ did: string; read: boolean; write: boolean }>;
	verifiedAt: string | null;
}

/** `blobs.json`: what each stored blob is, by CID. */
export type BackupBlobIndex = Record<string, { contentType: string; size: number }>;

export interface CaptureOptions extends RegistryOptions {
	store?: BackupStore;
	/** The capture's clock; the folder name and the row both read it. */
	now?: Date;
}

export type CaptureResult =
	| { ok: true; backup: typeof spaceBackups.$inferSelect }
	| { ok: false; reason: string; backupId?: number };

/**
 * Capture one account's space.
 *
 * A missing session is ordinary and produces no row: an identity Anthers does not host has no
 * credential this deployment may use, and the promise for that space is an export on demand
 * rather than a standing copy. Every other failure leaves a `failed` row with the reason, so a
 * backup that stops working is visible rather than absent.
 */
export async function captureSpace(
	userId: number,
	opts: CaptureOptions = {},
): Promise<CaptureResult> {
	const registry = await registeredSpace(userId);
	if (!registry) return { ok: false, reason: "no_registry_row" };

	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(userId);
	if (!resolved.session) return { ok: false, reason: resolved.reason };

	const store = opts.store ?? objectBackupStore;
	const now = opts.now ?? new Date();
	const capturedAt = new Date(now.getTime());
	const prefix = backupPrefix(registry.did, registry.spaceType, USER_SPACE_SKEY, capturedAt);
	const client = spaceClientFor(resolved.session, { fetchImpl: opts.fetchImpl });
	const { spaceUri } = registry;

	// The registry is a cache, and a backup has to be of what the PDS holds now rather than of
	// what the row last saw. Reading the space here also refreshes the row, so the two halves of
	// the three-part backup agree about the policy and the members.
	const description = await client.getSpace(spaceUri);
	const liveMembers = (await client.listMembers(spaceUri).catch(() => ({ members: [] }))).members;
	const livePolicies = {
		readPolicy: description.readPolicy as unknown as Record<string, unknown>,
		writePolicy: description.writePolicy as unknown as Record<string, unknown>,
		appAccess: description.appAccess as unknown as Record<string, unknown>,
		members: liveMembers.map((member) => ({
			did: member.did,
			read: member.read,
			write: member.write,
		})),
	};

	let status: "complete" | "partial" | "failed" = "complete";
	let commit: SpaceCommit | null = null;
	let star: Uint8Array | null = null;
	const skips: string[] = [];

	try {
		const records = await listAllRecords(client, spaceUri, registry.did);
		commit = await latestCommitOrNull(client, spaceUri, registry.did);
		if (commit) {
			star = (await client.getRepo({ space: spaceUri, repo: registry.did })).bytes;
		}

		const index: BackupBlobIndex = {};
		const blobs: Array<{ cid: string; bytes: Uint8Array; contentType: string }> = [];
		if (commit) {
			for (const cid of await listAllBlobCids(client, spaceUri, registry.did)) {
				try {
					const blob = await client.getBlob({ space: spaceUri, repo: registry.did, cid });
					const contentType = blob.contentType ?? "application/octet-stream";
					blobs.push({ cid, bytes: blob.bytes, contentType });
					index[cid] = { contentType, size: blob.bytes.length };
				} catch (error) {
					// A record can reference a blob the blob store no longer has. The records still
					// restore; the bytes are what the partial status is for.
					status = "partial";
					skips.push(`blob ${cid}: ${messageOf(error)}`);
				}
			}
		}

		const registrySnapshot: BackupRegistry = {
			did: registry.did,
			spaceUri: registry.spaceUri,
			spaceType: registry.spaceType,
			readPolicy: livePolicies.readPolicy,
			writePolicy: livePolicies.writePolicy,
			appAccess: livePolicies.appAccess,
			members: livePolicies.members,
			verifiedAt: capturedAt.toISOString(),
		};

		await store.put(
			key(prefix, "registry.json"),
			bytesOf(JSON.stringify(registrySnapshot)),
			"application/json",
		);
		await store.put(
			key(prefix, "records.json"),
			bytesOf(JSON.stringify({ rev: commit?.rev ?? null, records })),
			"application/json",
		);
		await store.put(key(prefix, "blobs.json"), bytesOf(JSON.stringify(index)), "application/json");
		if (star) await store.put(key(prefix, "star.car"), star, "application/vnd.ipld.car");
		for (const blob of blobs) {
			await store.put(key(prefix, `blobs/${blob.cid}`), blob.bytes, blob.contentType);
		}

		const [row] = await db
			.insert(spaceBackups)
			.values({
				userId,
				did: registry.did,
				spaceUri,
				capturedAt,
				status,
				rev: commit?.rev ?? null,
				commitData: commit ? commitDigest(commit) : null,
				prefix,
				starKey: star ? key(prefix, "star.car") : null,
				recordsKey: key(prefix, "records.json"),
				registryKey: key(prefix, "registry.json"),
				blobsKey: key(prefix, "blobs.json"),
				starBytes: star?.length ?? 0,
				recordCount: records.length,
				blobCount: blobs.length,
				blobBytes: blobs.reduce((total, blob) => total + blob.bytes.length, 0),
				lastError: skips.length ? skips.join("; ") : null,
				updatedAt: now,
			})
			.returning();

		// The row is refreshed from what the PDS just said: the registry is a cache, and a capture
		// that read the live policy and member list has the current answer in hand.
		await db
			.update(userSpaces)
			.set({
				...livePolicies,
				verifiedAt: capturedAt,
				lastCheckedAt: capturedAt,
				updatedAt: capturedAt,
			})
			.where(eq(userSpaces.userId, userId));
		return { ok: true, backup: row };
	} catch (error) {
		const [row] = await db
			.insert(spaceBackups)
			.values({
				userId,
				did: registry.did,
				spaceUri,
				capturedAt,
				status: "failed",
				rev: commit?.rev ?? null,
				commitData: commit ? commitDigest(commit) : null,
				prefix,
				starKey: star ? key(prefix, "star.car") : null,
				recordsKey: key(prefix, "records.json"),
				registryKey: key(prefix, "registry.json"),
				blobsKey: key(prefix, "blobs.json"),
				lastError: messageOf(error),
				updatedAt: now,
			})
			.returning();
		return { ok: false, reason: "capture_failed", backupId: row?.id };
	}
}

export interface SweepResult {
	spaces: number;
	complete: number;
	partial: number;
	failed: number;
	skipped: number;
}

/** Capture a page of registered spaces, one at a time. */
export async function backupRegisteredSpaces(
	opts: CaptureOptions & { limit?: number } = {},
): Promise<SweepResult> {
	const rows = await db
		.select({ userId: userSpaces.userId })
		.from(userSpaces)
		.limit(opts.limit ?? 100);

	const result: SweepResult = {
		spaces: rows.length,
		complete: 0,
		partial: 0,
		failed: 0,
		skipped: 0,
	};
	for (const row of rows) {
		const captured = await captureSpace(row.userId, opts);
		if (!captured.ok) {
			if (captured.backupId) result.failed++;
			else result.skipped++;
			continue;
		}
		if (captured.backup.status === "complete") result.complete++;
		else if (captured.backup.status === "partial") result.partial++;
		else result.failed++;
	}
	return result;
}

/** The newest capture of a space, which is what a restore starts from. */
export async function latestBackup(spaceUri: string) {
	const [row] = await db
		.select()
		.from(spaceBackups)
		.where(and(eq(spaceBackups.spaceUri, spaceUri), eq(spaceBackups.status, "complete")))
		.orderBy(desc(spaceBackups.capturedAt))
		.limit(1);
	return row ?? null;
}

/** One capture by id, whatever its status, for the restore's report to name. */
export async function backupById(id: number) {
	const [row] = await db.select().from(spaceBackups).where(eq(spaceBackups.id, id)).limit(1);
	return row ?? null;
}

/**
 * The retention policy: thirty daily captures, then the newest of each month for a year.
 *
 * ⚠️ **The window is a product promise rather than a storage decision.** A reader's progress
 * and shelf state are theirs, and a month of daily backups is the depth a support request can
 * reasonably reach back into; the monthly tail is what covers "I lost my Library last
 * quarter". A gated media space would want a shorter window because the bytes are large, and
 * that belongs to that space's own task.
 */
export const RETENTION_DAILY_DAYS = 30;
export const RETENTION_MONTHLY_MONTHS = 12;

export interface PruneResult {
	removed: number;
	kept: number;
}

/** Delete captures outside the retention window, manifest and objects together. */
export async function pruneSpaceBackups(
	opts: { now?: Date; store?: BackupStore } = {},
): Promise<PruneResult> {
	const store = opts.store ?? objectBackupStore;
	const now = opts.now ?? new Date();
	const dailyCutoff = new Date(now.getTime() - RETENTION_DAILY_DAYS * 24 * 60 * 60 * 1000);
	const monthlyCutoff = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHLY_MONTHS, 1),
	);

	const rows = await db.select().from(spaceBackups).orderBy(desc(spaceBackups.capturedAt));

	// Keep every capture inside the daily window, and one per month inside the monthly one.
	const keptBySpace = new Map<string, Set<string>>();
	const keep = (spaceUri: string, monthKey: string) => {
		const months = keptBySpace.get(spaceUri) ?? new Set<string>();
		months.add(monthKey);
		keptBySpace.set(spaceUri, months);
	};

	let kept = 0;
	const doomed: Array<typeof spaceBackups.$inferSelect> = [];
	for (const row of rows) {
		const inDaily = row.capturedAt >= dailyCutoff;
		if (inDaily) {
			kept++;
			continue;
		}
		const inMonthly = row.capturedAt >= monthlyCutoff;
		const monthKey = `${row.capturedAt.getUTCFullYear()}-${row.capturedAt.getUTCMonth()}`;
		const months = keptBySpace.get(row.spaceUri) ?? new Set<string>();
		if (inMonthly && !months.has(monthKey)) {
			keep(row.spaceUri, monthKey);
			kept++;
			continue;
		}
		doomed.push(row);
	}

	for (const row of doomed) {
		await store.removePrefix(row.prefix);
		await db.delete(spaceBackups).where(eq(spaceBackups.id, row.id));
	}

	// Kept for a caller that wants the window's edge without a second query.
	return { removed: doomed.length, kept };
}

/** The storage prefix for one capture. DIDs, NSIDs and record keys are all path-safe. */
export function backupPrefix(
	did: string,
	spaceType: string,
	skey: string,
	capturedAt: Date,
): string {
	return `space-backups/${did}/${spaceType}/${skey}/${stampFor(capturedAt)}`;
}

/** A filesystem- and URL-safe timestamp: no colons, no dots. */
export function stampFor(at: Date): string {
	return at.toISOString().replace(/[:.]/g, "-");
}

function key(prefix: string, name: string): string {
	return `${prefix}/${name}`;
}

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function latestCommitOrNull(
	client: ReturnType<typeof spaceClientFor>,
	space: string,
	repo: string,
): Promise<SpaceCommit | null> {
	try {
		return (await client.getLatestCommit({ space, repo })).commit;
	} catch (error) {
		if (error instanceof SpaceRequestError && error.error === "RepoNotFound") return null;
		throw error;
	}
}

async function listAllRecords(
	client: ReturnType<typeof spaceClientFor>,
	space: string,
	repo: string,
): Promise<BackupRecord[]> {
	const records: BackupRecord[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 500; page++) {
		const answer = await client.listRecords({ space, repo, limit: 100, cursor });
		for (const record of answer.records as SpaceRecord[]) {
			records.push({
				collection: record.collection ?? collectionOf(record.uri),
				rkey: record.rkey ?? rkeyOf(record.uri),
				cid: record.cid,
				value: record.value,
			});
		}
		if (!answer.cursor) return records;
		cursor = answer.cursor;
	}
	throw new Error("listRecords did not finish within 500 pages");
}

async function listAllBlobCids(
	client: ReturnType<typeof spaceClientFor>,
	space: string,
	repo: string,
): Promise<string[]> {
	const cids: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 500; page++) {
		const answer = await client.listBlobs({ space, repo, limit: 100, cursor });
		cids.push(...answer.cids);
		if (!answer.cursor) return cids;
		cursor = answer.cursor;
	}
	throw new Error("listBlobs did not finish within 500 pages");
}

/** The collection in a space record address, for a server that answered without one. */
function collectionOf(uri: string | undefined): string {
	// `at://spaceDid/space/type/skey/author/collection/rkey`
	return uri?.split("/").at(-2) ?? "";
}

function rkeyOf(uri: string | undefined): string {
	return uri?.split("/").at(-1) ?? "";
}

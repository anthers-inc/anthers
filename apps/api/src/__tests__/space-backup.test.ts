// SPDX-License-Identifier: Apache-2.0
/**
 * The logical backup and its restore, held to the three artifacts and the drill's checks.
 *
 * The fake PDS answers the same three sources the real branch does: `getRepo` for the STAR,
 * `listBlobs`/`getBlob` for the bytes, and the registry row for the policy and members. The
 * point of the suite is the restore: the space is deleted, the backup is the only copy, and
 * the restored record has to land at the same URI and CID with the same commit digest.
 *
 * The real server is `space-backup-staging.test.ts`, skipped without `SPACE_STAGING_PDS_URL`.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { spaceBackups } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { SpaceClient } from "../services/atproto-space.js";
import { gatedSpaceUri, studioSpaceUri, syncCreatorSpace } from "../services/creator-space.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	GATED_MANIFEST_RKEY,
} from "../services/creator-space-records.js";
import { managingAppFor } from "../services/managing-app.js";
import {
	type BackupStore,
	captureOwnedSpaces,
	pruneSpaceBackups,
} from "../services/space-backup.js";
import { USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { restoreSpace } from "../services/space-restore.js";
import { spaceClientFor } from "../services/space-writer.js";
import { storage } from "../services/storage/index.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { spaceContext } from "./space-fixtures.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

/** An in-memory bucket, so the suite needs no STORAGE_BACKEND and leaves no files. */
class MapStore implements BackupStore {
	readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

	async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
		this.objects.set(key, { bytes, contentType });
	}

	async get(key: string): Promise<Uint8Array | null> {
		return this.objects.get(key)?.bytes ?? null;
	}

	async removePrefix(prefix: string): Promise<void> {
		for (const key of [...this.objects.keys()]) {
			if (key.startsWith(prefix)) this.objects.delete(key);
		}
	}
}

const SAVE_BYTES = new TextEncoder().encode("a reader's save bytes\n".repeat(20));

describe("the space backup", () => {
	it("restores records, a blob, the policy and the members after the space is gone", async () => {
		const ctx = await spaceContext();
		const client = spaceClientFor(ctx.session, { fetchImpl: ctx.pds.fetch });

		// A save is the shape that carries a blob, and the only shape that needs one today.
		const blob = await client.uploadBlob(SAVE_BYTES, "text/plain");
		const saved = await client.putRecord({
			space: ctx.spaceUri,
			repo: ctx.did,
			collection: USER_SPACE_COLLECTIONS.workSave,
			rkey: "work-1",
			record: {
				$type: USER_SPACE_COLLECTIONS.workSave,
				work: `at://${ctx.did}/${USER_SPACE_COLLECTIONS.libraryItem}/work-${ctx.workId}`,
				blob,
			},
			validate: false,
		});
		const member = "did:plc:another-reader";
		await client.putMember(ctx.spaceUri, { did: member, read: true, write: false });

		const store = new MapStore();
		const captured = await captureOwnedSpaces(ctx.userId, {
			store,
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
		const [backup] = captured.backups;
		if (!backup) throw new Error("the Library space was not captured");

		expect(backup.status).toBe("complete");
		expect(backup.recordCount).toBe(1);
		expect(backup.blobCount).toBe(1);
		expect(backup.blobBytes).toBe(SAVE_BYTES.length);
		expect(backup.starBytes).toBeGreaterThan(0);
		expect(backup.commitData).not.toBeNull();
		expect(store.objects.has(`${backup.prefix}/star.car`)).toBe(true);
		expect(store.objects.has(`${backup.prefix}/registry.json`)).toBe(true);
		expect(store.objects.has(`${backup.prefix}/records.json`)).toBe(true);
		expect(store.objects.has(`${backup.prefix}/blobs/${blob.ref.$link}`)).toBe(true);

		// The backup is now the only copy: deleting the space takes its blob with it.
		await client.deleteSpace(ctx.spaceUri);
		expect(ctx.pds.records.get(ctx.spaceUri)).toBeUndefined();
		expect(ctx.pds.blobs.size).toBe(0);

		const restored = await restoreSpace(backup.id, {
			store,
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if (!restored.ok) throw new Error(`restore refused: ${restored.reason}`);
		const report = restored.report;

		expect(report.records.matched).toBe(1);
		expect(report.records.mismatched).toEqual([]);
		expect(report.blobs.matched).toBe(1);
		expect(report.blobs.missing).toEqual([]);
		expect(report.members.restored).toBe(1);
		expect(report.policy.matches).toBe(true);
		expect(report.commit.matches).toBe(true);

		// And the space really answers: the same address, the same CID, the same bytes.
		const records = await client.listRecords({
			space: ctx.spaceUri,
			repo: ctx.did,
			collection: USER_SPACE_COLLECTIONS.workSave,
		});
		expect(records.records).toHaveLength(1);
		expect(records.records[0].cid).toBe(saved.cid);

		const bytes = await client.getBlob({
			space: ctx.spaceUri,
			repo: ctx.did,
			cid: blob.ref.$link,
		});
		expect([...bytes.bytes]).toEqual([...SAVE_BYTES]);

		const members = await client.listMembers(ctx.spaceUri);
		expect(members.members.some((entry) => entry.did === member)).toBe(true);

		const description = await client.getSpace(ctx.spaceUri);
		expect(description.readPolicy.$type).toBe("com.atproto.simplespace.defs#memberListPolicy");
	});

	it("keeps thirty daily captures and one per month for a year", async () => {
		const ctx = await spaceContext();
		const store = new MapStore();
		const day = 24 * 60 * 60 * 1000;
		const now = new Date("2026-10-23T00:00:00.000Z");
		const dates = [
			now,
			new Date(now.getTime() - 29 * day),
			new Date(Date.UTC(2026, 7, 15)), // August, the newest of its month: kept
			new Date(Date.UTC(2026, 7, 1)), // August, older: removed
			new Date(Date.UTC(2024, 0, 1)), // far past: removed
		];

		for (const capturedAt of dates) {
			const prefix = `space-backups/${ctx.did}/org.anthers.userSpace/self/${capturedAt.toISOString()}`;
			await store.put(`${prefix}/registry.json`, new Uint8Array([1]), "application/json");
			await db.insert(spaceBackups).values({
				userId: ctx.userId,
				did: ctx.did,
				spaceUri: ctx.spaceUri,
				capturedAt,
				prefix,
				recordsKey: `${prefix}/records.json`,
				registryKey: `${prefix}/registry.json`,
			});
		}

		const pruned = await pruneSpaceBackups({ now, store });
		expect(pruned.removed).toBeGreaterThanOrEqual(2);

		// What matters is this space's window: the daily pair, the newest of August, and neither
		// the older August capture nor the 2024 one.
		const rows = await db
			.select({ capturedAt: spaceBackups.capturedAt })
			.from(spaceBackups)
			.where(eq(spaceBackups.userId, ctx.userId));
		const keptDates = rows.map((row) => row.capturedAt.toISOString()).sort();
		expect(keptDates).toEqual(
			[
				new Date(Date.UTC(2026, 7, 15)).toISOString(),
				new Date(now.getTime() - 29 * day).toISOString(),
				now.toISOString(),
			].sort(),
		);
		expect(store.objects.size).toBe(3);
	});

	it("takes no copy of a space whose identity Anthers does not host", async () => {
		const ctx = await spaceContext();
		const captured = await captureOwnedSpaces(ctx.userId, {
			store: new MapStore(),
			resolveSession: async () => ({ session: null, reason: "not_hosted" }),
		});
		expect(captured).toEqual({ ok: false, reason: "not_hosted", backups: [] });

		const rows = await db.select().from(spaceBackups).where(eq(spaceBackups.userId, ctx.userId));
		expect(rows).toHaveLength(0);
	});

	it("captures a creator's studio and gated space as their own captures, without colliding", async () => {
		const ctx = await spaceContext();
		const mediaKey = `creators/${ctx.userId}/media/nightjar.epub`;
		const media = new TextEncoder().encode("a novel\n".repeat(30));
		await storage.upload(mediaKey, media, "application/epub+zip");

		const work = await insertWork({
			creatorId: ctx.userId,
			type: "text",
			title: "Nightjar",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
			sourceKey: mediaKey,
		});
		const synced = await syncCreatorSpace(work.id, {
			resolveSession: ctx.resolveSession,
			managingApp: managingAppFor("http://localhost:4321"),
			fetchImpl: ctx.pds.fetch,
		});
		const studio = studioSpaceUri(ctx.did);
		const gated = gatedSpaceUri(ctx.did, work.publicId);
		expect(synced.refs.spaceUri).toBe(gated);

		try {
			const store = new MapStore();
			const captured = await captureOwnedSpaces(ctx.userId, {
				store,
				resolveSession: ctx.resolveSession,
				fetchImpl: ctx.pds.fetch,
			});
			if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);

			// The Library, the studio and the gated space — three addresses under one owner.
			expect(captured.backups.map((backup) => backup.spaceUri).sort()).toEqual(
				[ctx.spaceUri, studio, gated].sort(),
			);
			// 🚨 The prefix is per space, not per owner-and-type: the studio and the gated space
			// share both and only the key tells them apart.
			const prefixes = captured.backups.map((backup) => backup.prefix);
			expect(new Set(prefixes).size).toBe(3);
			expect(prefixes.some((prefix) => prefix.includes(`/org.anthers.creatorSpace/self/`))).toBe(
				true,
			);
			expect(
				prefixes.some((prefix) => prefix.includes(`/org.anthers.creatorSpace/${work.publicId}/`)),
			).toBe(true);

			const gatedBackup = captured.backups.find((backup) => backup.spaceUri === gated);
			const studioBackup = captured.backups.find((backup) => backup.spaceUri === studio);
			if (!gatedBackup || !studioBackup) throw new Error("a creator space was not captured");
			expect(gatedBackup.recordCount).toBe(1);
			expect(studioBackup.recordCount).toBe(1);

			// The capture is the only copy of both spaces from here.
			await spaceClientFor(ctx.session, { fetchImpl: ctx.pds.fetch })
				.deleteSpace(gated)
				.catch(() => undefined);
			await spaceClientFor(ctx.session, { fetchImpl: ctx.pds.fetch })
				.deleteSpace(studio)
				.catch(() => undefined);

			for (const backup of [studioBackup, gatedBackup]) {
				const restored = await restoreSpace(backup.id, {
					store,
					resolveSession: ctx.resolveSession,
					fetchImpl: ctx.pds.fetch,
				});
				if (!restored.ok) throw new Error(`restore refused: ${restored.reason}`);
				expect(restored.report.records.mismatched).toEqual([]);
				expect(restored.report.records.matched).toBe(1);
				expect(restored.report.policy.matches).toBe(true);
				expect(restored.report.commit.matches).toBe(true);
				// The draft and the manifest name R2 keys; the restore says whether they still
				// resolve rather than assuming the media layer is where it was.
				expect(restored.report.files).toEqual({
					references: 1,
					present: 1,
					missing: [],
				});
			}

			const reader = new SpaceClient({
				baseUrl: ctx.session.pdsUrl,
				token: ctx.session.token,
				fetch: ctx.pds.fetch,
			});
			const manifest = await reader.getRecord({
				space: gated,
				repo: ctx.did,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
			});
			expect(manifest.value).toMatchObject({
				publicId: work.publicId,
				files: [{ role: "source", key: mediaKey, bytes: media.length }],
			});
			const draft = await reader.getRecord({
				space: studio,
				repo: ctx.did,
				collection: CREATOR_SPACE_COLLECTIONS.draft,
				rkey: String(work.publicId),
			});
			expect(draft.value).toMatchObject({ publicId: work.publicId, title: "Nightjar" });
		} finally {
			await storage.delete(mediaKey).catch(() => undefined);
		}
	});
});

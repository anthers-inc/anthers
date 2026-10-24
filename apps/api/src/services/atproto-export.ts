// SPDX-License-Identifier: Apache-2.0
/**
 * The AT Protocol export: everything the network holds for this account, in one ZIP.
 *
 * 🚨 **The JSON export is not this.** `account-data.ts` assembles the rows Anthers keeps; it
 * carries no repository and no space, because until Spaces those lived on the network and
 * were not ours to hand out. A person leaving now has three things the JSON cannot see: the
 * public repository's records, the records in their spaces, and the blobs those records
 * reference. Deletion destroys the actor store and leaves the DID in the PLC, so the export is
 * the only copy if the identity is not moved first.
 *
 * ⭐ **The bundle is the same three artifacts the backup captures**, read through
 * `readSpaceArtifacts`, plus the public CAR and the JSON account export. One reader means a
 * backup and an export cannot disagree about what a space contains.
 *
 * ⚠️ **An identity Anthers does not host still gets its public repository.** The CAR is
 * readable from the account's own PDS without a credential; the spaces are not, because
 * Anthers holds no way in. The manifest says which half was taken rather than pretending the
 * bundle is complete.
 */
import { db } from "@anthers/db";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { strToU8, type Zippable, zipSync } from "fflate";
import { buildAccountExport } from "./account-data.js";
import { type BackupRegistry, readSpaceArtifacts, type SpaceArtifacts } from "./space-backup.js";
import { type OwnedSpace, ownedSpacesFor, registeredSpacesFor } from "./space-registry.js";
import { hostedSpaceSession, type ResolveSpaceSession, spaceClientFor } from "./space-writer.js";
import { storage } from "./storage/index.js";

/** Bump when the bundle's shape changes in a way a consumer would notice. */
export const ATPROTO_EXPORT_FORMAT_VERSION = 1;

export interface AtprotoExportSpace {
	spaceUri: string;
	spaceType: string;
	skey: string;
	recordCount: number;
	blobCount: number;
	blobBytes: number;
	rev: string | null;
	registry: BackupRegistry;
}

export interface AtprotoExportManifest {
	format: "anthers-atproto-export";
	formatVersion: number;
	generatedAt: string;
	did: string;
	handle: string;
	pdsUrl: string;
	publicRepo: { present: boolean; bytes: number };
	spaces: AtprotoExportSpace[];
	notes: string[];
}

export type AtprotoExportResult =
	| { ok: true; zip: Uint8Array; manifest: AtprotoExportManifest; key: string }
	| { ok: false; reason: string };

export interface AtprotoExportOptions {
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
	now?: Date;
}

/**
 * Build the bundle for one account and store it under the account's export prefix.
 *
 * The stored object is the record the deletion gate reads; the bytes are also returned so the
 * route can stream them without a second read. A download from storage would need a signed URL
 * in production and would be a public object in local mode, and neither is worth it for a file
 * the request already holds.
 */
export async function buildAtprotoExport(
	userId: number,
	opts: AtprotoExportOptions = {},
): Promise<AtprotoExportResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user) return { ok: false, reason: "no_user" };

	const now = opts.now ?? new Date();
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(userId);
	const session = resolved.session;
	const client = session ? spaceClientFor(session, { fetchImpl: opts.fetchImpl }) : null;

	// The public repository. With a hosted session it is the owner's own read; without one it
	// is the network's public read from the account's PDS, which is what an identity held
	// elsewhere can offer.
	let publicCar: Uint8Array | null = null;
	if (client) {
		publicCar = await client
			.getPublicRepo(user.atprotoDid)
			.then((bytes) => bytes.bytes)
			.catch(() => null);
	} else if (user.atprotoPdsUrl) {
		publicCar = await publicRepoWithoutSession(user.atprotoPdsUrl, user.atprotoDid).catch(
			() => null,
		);
	}

	const entries: Zippable = {};
	const spaces: AtprotoExportSpace[] = [];
	const notes: string[] = [
		"This is a snapshot taken at generatedAt, not a live feed.",
		"public-repo.car is the account's public repository, in the protocol's own repository format.",
		"Each folder under spaces/ is one permissioned space: its registry entry, records, STAR and blobs.",
		"A creator's studio and each gated Work's space are spaces like any other; their manifests name media in storage rather than carrying the bytes.",
		"account.json is the same JSON export the Download my data button produces: the rows Anthers holds.",
	];

	if (session) {
		// ⚠️ **A listing failure must not cost the reader the bundle.** The public repository and
		// the JSON export are still theirs; a creator space the server would not list is reported
		// as a gap rather than turning the whole export into an error.
		let registries: OwnedSpace[];
		try {
			registries = await ownedSpacesFor(userId, { session, fetchImpl: opts.fetchImpl });
		} catch (error) {
			registries = await registeredSpacesFor(userId);
			notes.push(
				`Creator spaces could not be listed (${messageOf(error)}). The bundle carries only the ` +
					"spaces Anthers had already registered.",
			);
		}
		for (const registry of registries) {
			const artifacts = await readSpaceArtifacts(registry, session, { fetchImpl: opts.fetchImpl });
			const skey = lastSegment(registry.spaceUri);
			const dir = `spaces/${registry.spaceType}/${skey}`;
			entries[`${dir}/registry.json`] = strToU8(JSON.stringify(artifacts.registry, null, 2));
			entries[`${dir}/records.json`] = strToU8(
				JSON.stringify({ rev: artifacts.commit?.rev ?? null, records: artifacts.records }, null, 2),
			);
			entries[`${dir}/blobs.json`] = strToU8(JSON.stringify(artifacts.index, null, 2));
			if (artifacts.star) {
				entries[`${dir}/star.car`] = [artifacts.star, { level: 0 }];
			}
			for (const blob of artifacts.blobs) {
				entries[`${dir}/blobs/${blob.cid}`] = [blob.bytes, { level: 0 }];
			}
			if (artifacts.skipped.length) {
				notes.push(`Space ${registry.spaceUri} was incomplete: ${artifacts.skipped.join("; ")}`);
			}
			spaces.push(summarize(registry, artifacts));
		}
	} else {
		notes.push(
			"Your identity lives on another server, so Anthers could take the public repository and not the spaces. Move the identity, or export your spaces from the app you use there.",
		);
	}

	const account = await buildAccountExport(userId);
	if (account) entries["account.json"] = strToU8(JSON.stringify(account, null, 2));
	if (publicCar) entries["public-repo.car"] = [publicCar, { level: 0 }];

	const manifest: AtprotoExportManifest = {
		format: "anthers-atproto-export",
		formatVersion: ATPROTO_EXPORT_FORMAT_VERSION,
		generatedAt: now.toISOString(),
		did: user.atprotoDid,
		handle: user.atprotoHandle,
		pdsUrl: session?.pdsUrl ?? user.atprotoPdsUrl ?? "",
		publicRepo: { present: !!publicCar, bytes: publicCar?.length ?? 0 },
		spaces,
		notes,
	};
	entries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

	const zip = zipSync(entries, { level: 6 });
	const key = `exports/${userId}/${stampFor(now)}/anthers-atproto-export.zip`;
	await storage.upload(key, zip, "application/zip", "private");
	await db.update(users).set({ atprotoExportedAt: now }).where(eq(users.id, userId));

	return { ok: true, zip, manifest, key };
}

/** The newest bundle's time, without reading the object. */
export async function lastAtprotoExport(userId: number): Promise<Date | null> {
	const [row] = await db
		.select({ atprotoExportedAt: users.atprotoExportedAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row?.atprotoExportedAt ?? null;
}

/** The newest stored bundle, for an operator answering "what did they take". */
export async function latestExportKey(userId: number): Promise<string | null> {
	const [row] = await db
		.select({ atprotoExportedAt: users.atprotoExportedAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row?.atprotoExportedAt) return null;
	return `exports/${userId}/${stampFor(row.atprotoExportedAt)}/anthers-atproto-export.zip`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A filesystem-safe timestamp for the export prefix. */
function stampFor(at: Date): string {
	return at.toISOString().replace(/[:.]/g, "-");
}

function lastSegment(uri: string): string {
	return uri.split("/").at(-1) ?? "self";
}

function summarize(registry: OwnedSpace, artifacts: SpaceArtifacts): AtprotoExportSpace {
	return {
		spaceUri: registry.spaceUri,
		spaceType: registry.spaceType,
		skey: lastSegment(registry.spaceUri),
		recordCount: artifacts.records.length,
		blobCount: artifacts.blobs.length,
		blobBytes: artifacts.blobs.reduce((total, blob) => total + blob.bytes.length, 0),
		rev: artifacts.commit?.rev ?? null,
		registry: artifacts.registry,
	};
}

/** `sync.getRepo` with no credential, for an identity on a server Anthers may only read. */
async function publicRepoWithoutSession(pdsUrl: string, did: string): Promise<Uint8Array> {
	const url = new URL("/xrpc/com.atproto.sync.getRepo", pdsUrl);
	url.searchParams.set("did", did);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`getRepo failed with ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * The export prefix, for the retention sweep that will eventually retire old bundles. It is
 * exported so the sweep and the builder cannot disagree about where a bundle lives.
 */
export function exportPrefix(userId: number, at: Date): string {
	return `exports/${userId}/${stampFor(at)}`;
}

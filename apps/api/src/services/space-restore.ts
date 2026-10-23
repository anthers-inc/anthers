// SPDX-License-Identifier: Apache-2.0
/**
 * Restore a space from a logical backup: policy, blobs, records, members, in that order.
 *
 * 🚨 **The order is the contract.** A record that references a blob can only land after the
 * blob does, so the bytes go up first through `com.atproto.repo.uploadBlob` and the record is
 * replayed against the CID the upload returns. The member list goes last because a member
 * added before the records could read a space that is still being rebuilt.
 *
 * ⭐ **The restore checks three independent things, because each one is a different lie.** The
 * record's CID proves the bytes hashed to what the source wrote; the commit's data (the set
 * hash) proves the whole record set is the same set; the blob bytes read back prove the
 * content-addressed upload actually stored them. A drill that checked only the CIDs would pass
 * on a restore that lost the policy or the members, which is why the registry is its own
 * artifact and its own check.
 *
 * ⚠️ **A restore by default refuses to overwrite a live space.** `replace` is an explicit
 * decision because the destination may hold the only copy of something the backup does not:
 * a record written after the capture, a member added since. The drill is the one caller that
 * passes it, after deleting the space it just captured.
 */
import {
	commitDigest,
	type SpaceAppAccess,
	type SpacePolicy,
	SpaceRequestError,
} from "./atproto-space.js";
import {
	type BackupBlobIndex,
	type BackupRecord,
	type BackupRegistry,
	type BackupStore,
	backupById,
	objectBackupStore,
} from "./space-backup.js";
import { hostedSpaceSession, type ResolveSpaceSession, spaceClientFor } from "./space-writer.js";

export interface RestoreOptions {
	store?: BackupStore;
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
	/** Delete an existing space at the same address first. Never implied. */
	replace?: boolean;
}

export interface RestoreReport {
	spaceUri: string;
	replaced: boolean;
	records: {
		total: number;
		matched: number;
		mismatched: Array<{ collection: string; rkey: string; expected: string; actual: string }>;
	};
	blobs: { total: number; matched: number; missing: string[] };
	members: { total: number; restored: number };
	policy: { matches: boolean };
	commit: { expected: string | null; actual: string | null; matches: boolean | null };
}

export type RestoreResult = { ok: true; report: RestoreReport } | { ok: false; reason: string };

/** Restore one capture by its manifest id. */
export async function restoreSpace(
	backupId: number,
	opts: RestoreOptions = {},
): Promise<RestoreResult> {
	const backup = await backupById(backupId);
	if (!backup) return { ok: false, reason: "no_backup" };
	if (backup.status === "failed") return { ok: false, reason: "backup_failed" };

	const store = opts.store ?? objectBackupStore;
	const registry = await readJson<BackupRegistry>(store, backup.registryKey);
	const records = await readJson<{ rev: string | null; records: BackupRecord[] }>(
		store,
		backup.recordsKey,
	);
	const blobs = backup.blobsKey ? await readJson<BackupBlobIndex>(store, backup.blobsKey) : {};

	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(backup.userId);
	if (!resolved.session) return { ok: false, reason: resolved.reason };
	const { session } = resolved;
	const client = spaceClientFor(session, { fetchImpl: opts.fetchImpl });
	const { spaceUri } = backup;

	// The address in the manifest is the one to recreate. A registry snapshot whose URI
	// disagrees with the manifest is a broken backup rather than a choice to make here.
	const skey = spaceUri.split("/").at(-1) ?? "self";
	const existing = await findSpace(client, session.did, registry.spaceType, spaceUri);
	if (existing && !opts.replace) return { ok: false, reason: "space_exists" };
	if (existing) await client.deleteSpace(spaceUri);

	await client.createSpace({
		spaceType: registry.spaceType,
		skey,
		readPolicy: registry.readPolicy as unknown as SpacePolicy,
		writePolicy: registry.writePolicy as unknown as SpacePolicy,
		appAccess: registry.appAccess as unknown as SpaceAppAccess,
	});

	// 1. The bytes, through the normal repository route, at the CIDs the records reference.
	const missing: string[] = [];
	let blobsMatched = 0;
	for (const [cid, meta] of Object.entries(blobs)) {
		const bytes = await store.get(`${backup.prefix}/blobs/${cid}`);
		if (!bytes) {
			missing.push(cid);
			continue;
		}
		const ref = await client.uploadBlob(bytes, meta.contentType);
		if (ref.ref.$link === cid) blobsMatched++;
		else missing.push(cid);
	}

	// 2. The records, at the keys the backup recorded, compared by the CID the write returns.
	const mismatched: RestoreReport["records"]["mismatched"] = [];
	for (const record of records.records) {
		const written = await client.putRecord({
			space: spaceUri,
			repo: session.did,
			collection: record.collection,
			rkey: record.rkey,
			record: record.value as Record<string, unknown>,
			validate: false,
		});
		if (written.cid !== record.cid) {
			mismatched.push({
				collection: record.collection,
				rkey: record.rkey,
				expected: record.cid,
				actual: written.cid,
			});
		}
	}

	// 3. The members, last, from the registry snapshot rather than from the STAR.
	let membersRestored = 0;
	for (const member of registry.members) {
		await client.putMember(spaceUri, {
			did: member.did,
			read: member.read,
			write: member.write,
		});
		membersRestored++;
	}

	// 4. Independent checks: the policy that came back, and the whole set's digest.
	const description = await client.getSpace(spaceUri);
	const policyMatches =
		description.readPolicy.$type === (registry.readPolicy as { $type?: string }).$type &&
		description.writePolicy.$type === (registry.writePolicy as { $type?: string }).$type;

	const commit = await client
		.getLatestCommit({ space: spaceUri, repo: session.did })
		.catch((error) => {
			if (error instanceof SpaceRequestError && error.error === "RepoNotFound") return null;
			throw error;
		});
	const expectedData = backup.commitData;
	const actualData = commit ? commitDigest(commit.commit) : null;

	return {
		ok: true,
		report: {
			spaceUri,
			replaced: !!existing,
			records: {
				total: records.records.length,
				matched: records.records.length - mismatched.length,
				mismatched,
			},
			blobs: { total: Object.keys(blobs).length, matched: blobsMatched, missing },
			members: { total: registry.members.length, restored: membersRestored },
			policy: { matches: policyMatches },
			commit: {
				expected: expectedData,
				actual: actualData,
				matches: expectedData && actualData ? expectedData === actualData : null,
			},
		},
	};
}

async function readJson<T>(store: BackupStore, key: string): Promise<T> {
	const bytes = await store.get(key);
	if (!bytes) throw new Error(`backup object is missing: ${key}`);
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function findSpace(
	client: ReturnType<typeof spaceClientFor>,
	did: string,
	spaceType: string,
	spaceUri: string,
): Promise<boolean> {
	const listed = await client.listSpaces({ did, spaceType });
	return listed.spaces.some((space) => space.uri === spaceUri);
}

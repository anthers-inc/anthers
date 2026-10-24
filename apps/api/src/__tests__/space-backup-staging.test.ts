// SPDX-License-Identifier: Apache-2.0
/**
 * The restore drill, against a real spaces-capable PDS.
 *
 * The acceptance for the backup task is this test: a space with a blob is captured, deleted,
 * restored from the capture alone, and answers at the same record URI and CID with the same
 * bytes, the same policy and the same members. It uses the app's real storage adapter (local
 * files under the test session), so the backup artifacts are written and read exactly as they
 * would be in a deployment.
 *
 * Skipped unless `SPACE_STAGING_PDS_URL` names a server. Never point it at the real network.
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/network.mjs
 *   cd ~/Anthers/anthers && SPACE_STAGING_PDS_URL=http://127.0.0.1:2683 \
 *     bun test apps/api/src/__tests__/space-backup-staging.test.ts
 */

import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { spaceBackups } from "@anthers/db/schema";
import { inArray } from "drizzle-orm";
import { SpaceClient } from "../services/atproto-space.js";
import { gatedSpaceUri, studioSpaceUri, syncCreatorSpace } from "../services/creator-space.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	GATED_MANIFEST_RKEY,
} from "../services/creator-space-records.js";
import { managingAppFor } from "../services/managing-app.js";
import { captureOwnedSpaces } from "../services/space-backup.js";
import { USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { ensureUserSpace } from "../services/space-registry.js";
import { restoreSpace } from "../services/space-restore.js";
import { type ResolveSpaceSession, spaceClientFor } from "../services/space-writer.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const PDS_URL = process.env.SPACE_STAGING_PDS_URL ?? null;

purgeAccountsCreatedHere();

const staged = PDS_URL ? describe : describe.skip;
const SAVE_BYTES = new TextEncoder().encode("a staging reader's save\n".repeat(40));

staged("the space restore drill against a staging PDS", () => {
	let did = "";
	let memberDid = "";
	let token = "";
	let userId = 0;
	let spaceUri = "";
	let resolveSession: ResolveSpaceSession;
	let backupId = 0;
	const extraBackupIds: number[] = [];
	const createdSpaces: string[] = [];
	let mediaKey = "";

	async function xrpc(method: string, body: Record<string, unknown>, auth?: string) {
		const response = await fetch(new URL(`/xrpc/${method}`, PDS_URL as string), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(auth ? { authorization: `Bearer ${auth}` } : {}),
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		if (!response.ok) {
			throw new Error(`${method}: ${response.status} ${String(data.error ?? text)}`);
		}
		return data;
	}

	async function stagingAccount(name: string): Promise<{ did: string; token: string }> {
		// The lab PDS caps a handle at thirty characters; a short label keeps the suffix inside it.
		const tag = `${name}${Date.now().toString(36)}`;
		const created = (await xrpc("com.atproto.server.createAccount", {
			handle: `${tag}.spaces.test`,
			email: `${tag}@example.com`,
			password: `pw-${tag}`,
		})) as { did: string; accessJwt: string };
		return { did: created.did, token: created.accessJwt };
	}

	async function setUp(): Promise<void> {
		if (spaceUri) return;
		const owner = await stagingAccount("bko");
		did = owner.did;
		token = owner.token;
		const member = await stagingAccount("bkm");
		memberDid = member.did;

		const account = await createAccount(`bk-${Date.now().toString(36)}`);
		userId = account.userId;
		resolveSession = async (id) =>
			id === userId
				? { session: { did, pdsUrl: PDS_URL as string, token } }
				: { session: null, reason: "not_hosted" };

		const ensured = await ensureUserSpace(userId, { resolveSession });
		if (!ensured.space) throw new Error(`space was not created: ${ensured.reason}`);
		spaceUri = ensured.space.spaceUri;
	}

	it("captures and restores records, a blob, the policy and the members", async () => {
		await setUp();
		const client = spaceClientFor({ did, pdsUrl: PDS_URL as string, token });

		const blob = await client.uploadBlob(SAVE_BYTES, "text/plain");
		const saved = await client.putRecord({
			space: spaceUri,
			repo: did,
			collection: USER_SPACE_COLLECTIONS.workSave,
			rkey: "work-1",
			record: {
				$type: USER_SPACE_COLLECTIONS.workSave,
				work: `at://${did}/org.anthers.work/nightjar`,
				blob,
			},
			validate: false,
		});
		await client.putMember(spaceUri, { did: memberDid, read: true, write: false });

		const captured = await captureOwnedSpaces(userId, { resolveSession });
		if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
		// The account owns one space: it has published nothing, so it has no studio yet.
		expect(captured.backups).toHaveLength(1);
		const [backup] = captured.backups;
		if (!backup) throw new Error("the Library space was not captured");
		backupId = backup.id;
		expect(backup.status).toBe("complete");
		expect(backup.recordCount).toBe(1);
		expect(backup.blobCount).toBe(1);
		expect(backup.starBytes).toBeGreaterThan(0);

		// The capture is the only copy from here on.
		await client.deleteSpace(spaceUri);
		await expect(client.getSpace(spaceUri)).rejects.toThrow();

		const restored = await restoreSpace(backupId, { resolveSession });
		if (!restored.ok) throw new Error(`restore refused: ${restored.reason}`);
		const report = restored.report;
		expect(report.records.mismatched).toEqual([]);
		expect(report.records.matched).toBe(1);
		expect(report.blobs.missing).toEqual([]);
		expect(report.blobs.matched).toBe(1);
		expect(report.policy.matches).toBe(true);
		expect(report.commit.matches).toBe(true);

		// A fresh client, outside the restore, reads the space back.
		const reader = new SpaceClient({ baseUrl: PDS_URL as string, token });
		const records = await reader.listRecords({
			space: spaceUri,
			repo: did,
			collection: USER_SPACE_COLLECTIONS.workSave,
		});
		expect(records.records).toHaveLength(1);
		expect(records.records[0].cid).toBe(saved.cid);

		const bytes = await reader.getBlob({
			space: spaceUri,
			repo: did,
			cid: blob.ref.$link,
		});
		expect([...bytes.bytes]).toEqual([...SAVE_BYTES]);

		const members = await reader.listMembers(spaceUri);
		expect(members.members.some((entry) => entry.did === memberDid)).toBe(true);

		const description = await reader.getSpace(spaceUri);
		expect(description.readPolicy.$type).toBe("com.atproto.simplespace.defs#memberListPolicy");
		expect(description.writePolicy.$type).toBe("com.atproto.simplespace.defs#memberListPolicy");
	});

	it("captures and restores a creator's studio and a gated Work's space", async () => {
		await setUp();
		const client = spaceClientFor({ did, pdsUrl: PDS_URL as string, token });

		// A Work whose media lives in the app's storage, as a published one would.
		mediaKey = `creators/${userId}/media/nightjar-${Date.now().toString(36)}.epub`;
		const media = new TextEncoder().encode("a staging creator's novel\n".repeat(20));
		await storage.upload(mediaKey, media, "application/epub+zip");
		const work = await insertWork({
			creatorId: userId,
			type: "text",
			title: "Nightjar",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
			sourceKey: mediaKey,
		});
		const synced = await syncCreatorSpace(work.id, {
			resolveSession,
			managingApp: managingAppFor("http://localhost:4321"),
		});
		const studio = studioSpaceUri(did);
		const gated = gatedSpaceUri(did, work.publicId);
		createdSpaces.push(studio, gated);
		expect(synced.refs.spaceUri).toBe(gated);

		const captured = await captureOwnedSpaces(userId, { resolveSession });
		if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
		const bySpace = new Map(captured.backups.map((backup) => [backup.spaceUri, backup]));
		const studioBackup = bySpace.get(studio);
		const gatedBackup = bySpace.get(gated);
		if (!studioBackup || !gatedBackup) throw new Error("a creator space was not captured");
		extraBackupIds.push(studioBackup.id, gatedBackup.id);
		expect(studioBackup.recordCount).toBe(1);
		expect(gatedBackup.recordCount).toBe(1);
		// The prefix tells the two spaces apart even though they share an owner and a type.
		expect(studioBackup.prefix).not.toBe(gatedBackup.prefix);
		expect(studioBackup.prefix).toContain(`/org.anthers.creatorSpace/self/`);
		expect(gatedBackup.prefix).toContain(`/org.anthers.creatorSpace/${work.publicId}/`);

		// The captures are the only copies from here.
		await client.deleteSpace(studio);
		await client.deleteSpace(gated);

		for (const backup of [studioBackup, gatedBackup]) {
			const restored = await restoreSpace(backup.id, { resolveSession });
			if (!restored.ok) throw new Error(`restore refused: ${restored.reason}`);
			expect(restored.report.records.mismatched).toEqual([]);
			expect(restored.report.records.matched).toBe(1);
			expect(restored.report.policy.matches).toBe(true);
			expect(restored.report.commit.matches).toBe(true);
			// The manifest names R2 keys, not blobs; the restore checked they still resolve.
			expect(restored.report.files).toEqual({ references: 1, present: 1, missing: [] });
		}

		const reader = new SpaceClient({ baseUrl: PDS_URL as string, token });
		const manifest = await reader.getRecord({
			space: gated,
			repo: did,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
		});
		expect(manifest.value).toMatchObject({
			publicId: work.publicId,
			files: [{ role: "source", key: mediaKey, bytes: media.length }],
		});
		const draft = await reader.getRecord({
			space: studio,
			repo: did,
			collection: CREATOR_SPACE_COLLECTIONS.draft,
			rkey: String(work.publicId),
		});
		expect(draft.value).toMatchObject({ publicId: work.publicId, title: "Nightjar" });
	});

	afterAll(async () => {
		// Dispose of the staging spaces and every artifact this drill wrote.
		if (token) {
			const client = spaceClientFor({ did, pdsUrl: PDS_URL as string, token });
			for (const space of [spaceUri, ...createdSpaces].filter(Boolean)) {
				await client.deleteSpace(space).catch(() => undefined);
			}
		}
		if (mediaKey) await storage.delete(mediaKey).catch(() => undefined);
		const ids = [backupId, ...extraBackupIds].filter(Boolean);
		if (ids.length) {
			const rows = await db.select().from(spaceBackups).where(inArray(spaceBackups.id, ids));
			for (const row of rows) {
				await storage.deletePrefix(row.prefix).catch(() => undefined);
			}
		}
	});
});

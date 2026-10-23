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
import { eq } from "drizzle-orm";
import { SpaceClient } from "../services/atproto-space.js";
import { captureSpace } from "../services/space-backup.js";
import { USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { ensureUserSpace } from "../services/space-registry.js";
import { restoreSpace } from "../services/space-restore.js";
import { type ResolveSpaceSession, spaceClientFor } from "../services/space-writer.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";

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

		const captured = await captureSpace(userId, { resolveSession });
		if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
		backupId = captured.backup.id;
		expect(captured.backup.status).toBe("complete");
		expect(captured.backup.recordCount).toBe(1);
		expect(captured.backup.blobCount).toBe(1);
		expect(captured.backup.starBytes).toBeGreaterThan(0);

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

	afterAll(async () => {
		// Dispose of the staging space and every artifact this drill wrote.
		if (token && spaceUri) {
			const client = spaceClientFor({ did, pdsUrl: PDS_URL as string, token });
			await client.deleteSpace(spaceUri).catch(() => undefined);
		}
		const [row] = backupId
			? await db.select().from(spaceBackups).where(eq(spaceBackups.id, backupId)).limit(1)
			: [];
		if (row) await storage.deletePrefix(row.prefix).catch(() => undefined);
	});
});

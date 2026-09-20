// SPDX-License-Identifier: Apache-2.0
/**
 * Erasing an account that holds a handle Anthers issued — the third place personal data lives.
 *
 * 🚨 **The failure this exists to prevent is a wipe that reports success while somebody's
 * records are still on the identity server.** Before the handle door, everything personal was
 * in one database and one object store and `eraseAccount` covered both. Hosting added a live
 * account carrying that person's address on a machine Anthers operates, and nothing in the old
 * suite could tell whether it had been reached — a wipe that skipped it looks identical from
 * every other assertion in `account-deletion.test.ts`.
 *
 * ⭐ **The two failure directions are opposite and both are tested**, because getting either
 * one wrong is silent. An unreachable node must DEFER — leaving the account intact so the daily
 * sweep tries again — and a credential nobody can open must NOT, because retrying never opens
 * it and a person blocked from leaving forever is worse than a shell left on a server.
 *
 * ⚠️ **Nothing here reaches the real node.** The identities are real ones on the test session's own
 * server; the unreachable case then points the hub at a `.invalid` host, which RFC 2606 guarantees
 * can never resolve, and the unusable case is refused before any request is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { hostedAccounts, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

// 🚨 Put back in `afterAll`, because `bun test` runs every file in one process. Left set,
// `HOSTED_PDS_URL` would point the rest of the suite at a host that cannot resolve.
const before = {
	url: process.env.HOSTED_PDS_URL,
	key: process.env.HOSTED_ACCOUNT_KEY,
};

beforeAll(() => {
	// RFC 2606 reserves `.invalid`, so this can never become a real request to anything.
	process.env.HOSTED_PDS_URL = "https://node.invalid";
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterAll(() => {
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_ACCOUNT_KEY", before.key);
});

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

const { eraseAccount, deletionPreview } = await import("../services/account-deletion.js");

const suffix = crypto.randomUUID().slice(0, 8);
const unreachableName = `hd_defer_${suffix}`;
const strandedName = `hd_strand_${suffix}`;

let deferId: number;
let strandId: number;
let deferDid: string;
let deferHandle: string;
let strandDid: string;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${unreachableName + "@example.com"}`, sql`${strandedName + "@example.com"}`], sql`, `)})`,
	);
	// Real identities on the session's server, sealed under the key this file set — so the one
	// that is meant to be openable is.
	const defer = await createAccount(unreachableName);
	const strand = await createAccount(strandedName);
	deferId = defer.userId;
	deferDid = defer.did;
	deferHandle = defer.handle;
	strandId = strand.userId;
	strandDid = strand.did;

	// 🚨 Resealed under a key this process does not have. `open` refuses it, which is the state
	// the runbook describes for `signup-probe` and the one that must not block somebody's erasure.
	await db
		.update(hostedAccounts)
		.set({ sealedPassword: "v1.YWFhYWFhYWFhYWFh.YmJiYmJiYmJiYmJiYmJiYg.Y2Nj" })
		.where(eq(hostedAccounts.did, strandDid));
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.execute(sql`DELETE FROM hosted_accounts WHERE did IN (${deferDid}, ${strandDid})`);
});

describe("an account holding a handle Anthers issued", () => {
	it("names the handle in the preview, so nobody finds out afterwards", async () => {
		const preview = await deletionPreview(deferId);
		expect(preview.hostedHandles).toEqual([deferHandle]);
	});

	it("says nothing about handles for an account that has none", async () => {
		const plain = await createAccount(`hd_none_${suffix}`, { identity: "brought" });
		expect((await deletionPreview(plain.userId)).hostedHandles).toEqual([]);
	});

	// 🚨 The whole point. An unreachable identity server is Anthers failing to finish its own
	// job, so the erasure waits rather than declaring itself done — and nothing is destroyed in
	// the meantime, which is what makes tomorrow's retry a retry rather than a second half.
	it("DEFERS the whole erasure when the node cannot be reached, destroying nothing", async () => {
		const result = await eraseAccount(deferId);
		expect(result).toEqual({ erased: false });

		const [still] = await db.select({ id: users.id }).from(users).where(eq(users.id, deferId));
		expect(still?.id).toBe(deferId);

		// And the credential is still here, because it is the only way back into that account.
		const [row] = await db
			.select({ did: hostedAccounts.did })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, deferDid));
		expect(row?.did).toBe(deferDid);
	}, 60_000);

	// ⚠️ The opposite direction. Retrying never opens a credential this deployment's key cannot
	// open, so deferring here would block somebody's erasure permanently on an operational
	// problem that is not theirs.
	it("finishes the erasure when the credential cannot be opened, and keeps the row as the record", async () => {
		const result = await eraseAccount(strandId);
		expect(result).toEqual({ erased: true, strandedRecords: 0 });

		const [gone] = await db.select({ id: users.id }).from(users).where(eq(users.id, strandId));
		expect(gone).toBeUndefined();

		// 🚨 `user_id` is `set null` rather than `cascade` precisely so this survives: the shell
		// on the node is real, and a row nobody can join to a person is still the only record
		// that it is there.
		const [row] = await db
			.select({ did: hostedAccounts.did, userId: hostedAccounts.userId })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, strandDid));
		expect(row?.did).toBe(strandDid);
		expect(row?.userId).toBeNull();
	}, 60_000);
});

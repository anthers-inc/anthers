// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Erasing an account takes the Bluesky grant with it.
 *
 * 🚨 **Until 2026-08-29 it did not, and the failure was invisible from our side by
 * construction.** `eraseAccount` deleted the `atproto_sessions` row by cascade and stopped, so
 * somebody who asked to be forgotten was left with a live OAuth authorization on their Bluesky
 * account pointing at an Anthers that no longer held anything — and once the row was gone,
 * nothing here could even find it to try again. It was found by hand, removing a walkthrough
 * account, when the revoke had to be done separately.
 *
 * ⚠️ **The two assertions this suite is really about pull against each other**, which is why
 * both are here. The grant must be revoked, and a revocation that fails must never leave an
 * account undeleted: somebody asked to be forgotten and a third party's outage is not a reason
 * to refuse them. A suite asserting only the first would pass against an implementation that
 * lets an authorization-server error abort the erasure.
 *
 * ⭐ The client is faked because the alternative is an authorization server. `revoke` is the
 * only method any of this touches, so the fake records what it was called with and nothing
 * else — which is also what lets the "no DID" case assert an *absence* of calls.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { atprotoSessions, legalHolds, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import { eraseAccount } from "../services/account-deletion.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import { liftHold, placeHold } from "../services/legal-hold.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const RUN = Date.now().toString(36);

/** Every DID the fake client was asked to revoke, in order. */
let revoked: string[] = [];
/** When set, the fake client throws this instead of revoking — the outage case. */
let revokeThrows = false;

beforeAll(() => {
	setAtprotoClient({
		revoke: async (did: string) => {
			if (revokeThrows) throw new Error("authorization server unreachable");
			revoked.push(did);
		},
	} as never);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	setAtprotoClient(undefined);
	await db.delete(atprotoSessions).where(like(atprotoSessions.did, `did:plc:${RUN}%`));
	await db.delete(users).where(like(users.email, `er_${RUN}%`));
});

let n = 0;

/** An account with a linked ATProto identity and the session row that carries its tokens. */
async function makeLinkedUser(opts: { reconciled?: boolean } = {}) {
	n += 1;
	const did = `did:plc:${RUN}${n}`;
	const [user] = await db
		.insert(users)
		.values({
			username: `er_${RUN}_${n}`,
			email: `er_${RUN}_${n}@example.com`,
			passwordHash: "x",
			atprotoDid: did,
			atprotoHandle: `er${n}.bsky.social`,
			atprotoPdsUrl: "https://pds.example",
		})
		.returning({ id: users.id });
	await db.insert(atprotoSessions).values({
		did,
		// `userId` is nullable because the callback writes this row before there is an
		// account to own it. An unreconciled row cascades from nothing.
		userId: opts.reconciled === false ? null : user.id,
		session: {},
	});
	return { userId: user.id, did };
}

async function sessionExists(did: string): Promise<boolean> {
	const rows = await db
		.select({ did: atprotoSessions.did })
		.from(atprotoSessions)
		.where(eq(atprotoSessions.did, did));
	return rows.length > 0;
}

async function userExists(userId: number): Promise<boolean> {
	const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
	return rows.length > 0;
}

describe("eraseAccount revokes the ATProto grant", () => {
	beforeAll(() => {
		revoked = [];
		revokeThrows = false;
	});

	it("🚨 revokes at the authorization server, and takes the local session with it", async () => {
		const { userId, did } = await makeLinkedUser();

		const result = await eraseAccount(userId);

		expect(result.erased).toBe(true);
		expect(revoked).toContain(did);
		expect(await sessionExists(did)).toBe(false);
		expect(await userExists(userId)).toBe(false);
	});

	it("🚨 erases anyway when the revocation fails — being forgotten is not conditional on Bluesky", async () => {
		// The counterweight to the test above. A revocation that throws must not abort the
		// erasure: the person asked to be forgotten, and a third party's outage is not a
		// reason to refuse them. `revokeAtprotoGrant` swallows it for exactly this.
		const { userId, did } = await makeLinkedUser();
		revokeThrows = true;
		try {
			const result = await eraseAccount(userId);
			expect(result.erased).toBe(true);
			expect(await userExists(userId)).toBe(false);
			expect(await sessionExists(did)).toBe(false);
		} finally {
			revokeThrows = false;
		}
	});

	it("🚨 deletes an UNRECONCILED session row, which cascades from nothing", async () => {
		// `atproto_sessions` is keyed by DID because the SDK's session store is addressed by
		// the token subject and knows nothing about Anthers accounts — so the row is written at
		// the OAuth callback, before there is an account, and `user_id` is reconciled
		// afterwards. A row whose reconciliation never happened holds this person's live
		// tokens and is not touched by the cascade at all.
		const { userId, did } = await makeLinkedUser({ reconciled: false });

		await eraseAccount(userId);

		expect(revoked).toContain(did);
		expect(await sessionExists(did)).toBe(false);
	});

	it("⭐ revokes nothing for an account that never linked one", async () => {
		n += 1;
		const [user] = await db
			.insert(users)
			.values({
				username: `er_${RUN}_plain_${n}`,
				email: `er_${RUN}_plain_${n}@example.com`,
				passwordHash: "x",
			})
			.returning({ id: users.id });
		const before = revoked.length;

		await eraseAccount(user.id);

		expect(revoked.length).toBe(before);
	});

	it("🚨 does NOT revoke an account under a legal hold, because it is not being erased", async () => {
		// The ordering assertion. A held account returns early and stays intact, so revoking
		// before that guard would break the identity link of an account that is still very
		// much alive — and the daily sweep would re-select it and do it again tomorrow.
		const { userId, did } = await makeLinkedUser();
		const { holdId } = await placeHold({
			subjectType: "user",
			subjectId: userId,
			reason: "test — erase must defer under a hold",
		});

		try {
			const result = await eraseAccount(userId);
			expect(result.erased).toBe(false);
			expect(revoked).not.toContain(did);
			expect(await userExists(userId)).toBe(true);
			expect(await sessionExists(did)).toBe(true);
		} finally {
			await liftHold(holdId);
			await db.delete(legalHolds).where(eq(legalHolds.id, holdId));
			await db.delete(atprotoSessions).where(eq(atprotoSessions.did, did));
			await db.delete(users).where(eq(users.id, userId));
		}
	});
});

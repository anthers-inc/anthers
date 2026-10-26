// SPDX-License-Identifier: Apache-2.0
/**
 * Which credential writes an account's records, once a hosted identity has a grant.
 *
 * 🚨 **The subject is the order and the refusal, not the write itself.** A hosted identity used to
 * be writable only through the hub's own session. Now that it signs in through its own
 * authorization server, the grant it gives there is the authority, and the session is the
 * transition credential for an account that has not signed in yet. The failure this suite exists
 * to catch is a fallback that makes a withdrawal cosmetic: a revoked or narrowed grant must not
 * be routed around just because the hub still holds a session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, users } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
	CREATOR_SCOPE_EXPANDED,
	setAtprotoClient,
	USER_SCOPE_EXPANDED,
} from "../services/atproto-client.js";
import { WORK_COLLECTION } from "../services/atproto-repo.js";
import { writerForAccount } from "../services/repo-writer.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `rw${Date.now().toString(36)}`;
const GRANTED = `atproto ${USER_SCOPE_EXPANDED} ${CREATOR_SCOPE_EXPANDED}`;

/** What the fake authorization server says the restored token carries. */
let grantedScope = "";
/** Throw from `restore`, to model a server that will not answer. */
let restoreFails = false;
/** How many times the OAuth route asked for a session. */
let restored = 0;
/** Every XRPC call the OAuth-backed writer made. */
const handled: string[] = [];
const dids: string[] = [];

beforeAll(() => {
	setAtprotoClient({
		restore: async (did: string) => {
			restored++;
			if (restoreFails) throw new Error("the authorization server did not answer");
			return {
				did,
				getTokenInfo: async () => ({ aud: "http://localhost:2584", scope: grantedScope }),
				fetchHandler: async (path: string) => {
					handled.push(path);
					return new Response("{}");
				},
			};
		},
	} as never);
});

afterAll(async () => {
	setAtprotoClient(undefined);
	if (dids.length) await db.delete(atprotoSessions).where(inArray(atprotoSessions.did, dids));
});

/** A hosted fixture account, with an OAuth session row when one is asked for. */
async function account(
	tag: string,
	grant?: { scope: string | null },
): Promise<{ userId: number; did: string }> {
	const made = await createAccount(`${RUN}${tag}`);
	const [row] = await db
		.select({ did: users.atprotoDid })
		.from(users)
		.where(eq(users.id, made.userId));
	dids.push(row.did);
	if (grant) {
		await db.insert(atprotoSessions).values({
			did: row.did,
			userId: made.userId,
			session: {},
			scope: grant.scope,
		});
	}
	return { userId: made.userId, did: row.did };
}

function reset(): void {
	restored = 0;
	handled.length = 0;
	restoreFails = false;
	grantedScope = GRANTED;
}

describe("an account with no grant yet", () => {
	it("uses the hub's session, the way a fresh signup is writable", async () => {
		reset();
		const { userId } = await account("fresh");

		const opened = await writerForAccount(userId, { collections: [WORK_COLLECTION] });
		expect(opened.writer).not.toBeNull();
		// The grant gate is a column read; it never reached the authorization server.
		expect(restored).toBe(0);
	});
});

describe("an account with a recorded grant", () => {
	it("writes through the grant, not the hub's session", async () => {
		reset();
		const { userId } = await account("granted", { scope: GRANTED });

		const opened = await writerForAccount(userId, { collections: [WORK_COLLECTION] });
		expect(opened.writer).not.toBeNull();
		expect(restored).toBe(1);
		if (opened.writer) await opened.writer.deleteRecord(WORK_COLLECTION, "3kexample");
		expect(handled).toEqual(["/xrpc/com.atproto.repo.deleteRecord"]);
	});

	it("respects a grant that does not cover what is being written", async () => {
		reset();
		const { userId } = await account("narrow", { scope: "atproto" });

		const opened = await writerForAccount(userId, { collections: [WORK_COLLECTION] });
		// 🚨 No fallback to the hub's session, which still exists on the fixture. A hosted
		// account that granted less than publishing is not publishing.
		expect(opened).toEqual({ writer: null, reason: "not_granted" });
		expect(restored).toBe(0);
	});

	it("respects a grant that has been withdrawn, even though its row remains", async () => {
		reset();
		// A withdrawal clears the scope and leaves the row: the row is what says this person
		// authorized Anthers once, so the answer is theirs rather than "never granted".
		const { userId } = await account("withdrawn", { scope: null });

		const opened = await writerForAccount(userId, { collections: [WORK_COLLECTION] });
		expect(opened).toEqual({ writer: null, reason: "not_granted" });
		expect(restored).toBe(0);
	});

	it("reports an authorization server that will not answer rather than writing around it", async () => {
		reset();
		restoreFails = true;
		const { userId } = await account("outage", { scope: GRANTED });

		const opened = await writerForAccount(userId, { collections: [WORK_COLLECTION] });
		expect(opened).toEqual({ writer: null, reason: "session_unusable" });
		// The fixture's session is still on the row; using it here would have written a record
		// while the person's own server was unreachable.
		expect(opened.writer).toBeNull();
	});
});

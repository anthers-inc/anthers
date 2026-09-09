// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Asking Anthers for a handle from settings, after the account already exists.
 *
 * 🚨 **Every assertion here is a refusal, and that is what the route mostly is.** Issuing an
 * identity is one call to the node; deciding whether this account may have one is the whole
 * feature, and each of the four ways it can be no is a different sentence for a different
 * person to act on. A route that collapsed them would leave somebody retyping a name that was
 * never the problem — and, worse, would let an account that already holds an identity acquire
 * a second one, which nothing afterwards can tell apart from the first.
 *
 * ⚠️ **The eligible case is tested by pointing at a host that cannot exist.** RFC 2606 reserves
 * `.invalid`, so the one test that gets all the way through the guards proves it reached the
 * node — and proves it by failing to, which is the only way to test that path without creating
 * a real identity on a real server every time the suite runs.
 *
 * ⚠️ **`/subscribe` stays the only door that mints an account**, and the guard for that is the
 * session this route requires rather than the page being hard to find. The first test is the one
 * that pins it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import { unlinkAtprotoFromUser } from "../services/atproto.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import { createSession } from "../services/auth.js";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `hh${Date.now().toString(36)}`;
const ORIGIN = "http://localhost:3000";

// 🚨 Put back in `afterAll`, because `bun test` runs every file in one process. Left set, these
// would open the handle door for the rest of the suite — pointed at a host that cannot resolve.
const before = {
	url: process.env.HOSTED_PDS_URL,
	invite: process.env.HOSTED_PDS_INVITE_CODE,
	key: process.env.HOSTED_ACCOUNT_KEY,
};

/** Put a variable back exactly as it was, including having been unset. */
function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(() => {
	process.env.HOSTED_PDS_URL = "https://node.invalid";
	process.env.HOSTED_PDS_INVITE_CODE = "EXAMPLE-not-a-real-invite";
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);

	// ⚠️ Unlinking revokes the OAuth grant on the way out, best-effort. Left real, the one test
	// that unlinks successfully would build the SDK client and talk to an authorization server
	// for a revocation nothing here asserts on.
	setAtprotoClient({ revoke: async () => {} } as never);
});

afterAll(async () => {
	setAtprotoClient(undefined);
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_PDS_INVITE_CODE", before.invite);
	restore("HOSTED_ACCOUNT_KEY", before.key);
	await db.delete(hostedAccounts).where(like(hostedAccounts.did, `did:plc:${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

async function makeUser(tag: string, values: Partial<typeof users.$inferInsert> = {}) {
	const [user] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
			...values,
		})
		.returning();
	return user;
}

/** Ask for a handle as somebody. `session` omitted means nobody is signed in. */
function ask(name: string, session?: string) {
	return app.request("/api/atproto/handle", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: ORIGIN,
			...(session ? { Cookie: `session=${session}` } : {}),
		},
		body: JSON.stringify({ name }),
	});
}

async function sessionFor(userId: number): Promise<string> {
	return createSession(userId, undefined, undefined);
}

describe("who may ask for a handle", () => {
	// 🚨 The rule this route exists under: it acts on an account, so it needs one. There is one
	// signup door and this is not it.
	it("refuses anybody who is not signed in", async () => {
		const res = await ask("someone");
		expect(res.status).toBe(401);
	});

	it("refuses an account that already holds a handle Anthers issued", async () => {
		const user = await makeUser("held");
		// ⚠️ **A credential row with no DID on the account**, which is what a provisioning that
		// half-failed leaves behind. Checked before the DID for exactly this shape: issuing a
		// second identity over the top of it would strand the first on the node.
		await db.insert(hostedAccounts).values({
			did: `did:plc:${RUN}held`,
			userId: user.id,
			handle: `${RUN}held.anthers.social`,
			sealedPassword: "v1.YWFhYWFhYWFhYWFh.YmJiYmJiYmJiYmJiYmJiYg.Y2Nj",
		});

		const res = await ask("anothername", await sessionFor(user.id));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		// It names the handle, because "you already have one" is useless if you cannot see it.
		expect(body.error).toContain(`${RUN}held.anthers.social`);
	});

	it("refuses an account signed in with an identity from somewhere else", async () => {
		const user = await makeUser("linked", {
			atprotoDid: `did:plc:${RUN}elsewhere`,
			atprotoHandle: "alice.bsky.social",
		});

		const res = await ask("alice", await sessionFor(user.id));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("alice.bsky.social");
	});

	// 🚨 The same rule signup runs on, for the same reason: the node is given the account's
	// address and binds the identity to it, so an unproved address would bind an identity to
	// whoever typed it.
	it("refuses an account whose address nobody has confirmed", async () => {
		const user = await makeUser("unconfirmed", { emailVerified: false });

		const res = await ask("unconfirmed", await sessionFor(user.id));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Confirm your email");
	});

	// ⭐ **400 rather than 409**, because this is the one refusal where typing again is the fix.
	// Answered before anything is created, so a reserved name costs no round trip.
	it("refuses a reserved name as a name problem, not an account problem", async () => {
		const user = await makeUser("reserved");

		const res = await ask("anthers", await sessionFor(user.id));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("reserved");
	});

	it("refuses a name a domain could not carry", async () => {
		const user = await makeUser("badname");

		const res = await ask("not_a_handle", await sessionFor(user.id));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("underscore");
	});
});

describe("an eligible account", () => {
	// ⭐ **The only test that gets past every guard**, and it proves it by reaching a host that
	// cannot exist. A 503 here means the account was allowed, the name was accepted, and the
	// node was actually asked — which is everything this route does that is not a refusal.
	it("is taken all the way to the node, and reports the node's silence as ours", async () => {
		const user = await makeUser("eligible");

		const res = await ask("eligible", await sessionFor(user.id));
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("handle server");

		// Nothing was written for an identity that was never created.
		const rows = await db
			.select({ did: hostedAccounts.did })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.userId, user.id));
		expect(rows).toEqual([]);
	}, 60_000);

	it("is told the door is shut rather than refused for its name", async () => {
		const user = await makeUser("closed");
		const url = process.env.HOSTED_PDS_URL;
		delete process.env.HOSTED_PDS_URL;
		try {
			const res = await ask("closed", await sessionFor(user.id));
			expect(res.status).toBe(503);
		} finally {
			restore("HOSTED_PDS_URL", url);
		}
	});
});

describe("unlinking an identity Anthers hosts", () => {
	// 🚨 Unlinking is for an identity that lives somewhere else and carries on without Anthers.
	// This one lives on Anthers' node and the hub holds the only password to it, so detaching it
	// would leave somebody a repository they can no longer reach — and would look tidy doing it.
	it("is refused, and leaves the account still holding it", async () => {
		const did = `did:plc:${RUN}ours`;
		const user = await makeUser("ours", {
			atprotoDid: did,
			atprotoHandle: `${RUN}ours.anthers.social`,
		});
		await db.insert(hostedAccounts).values({
			did,
			userId: user.id,
			handle: `${RUN}ours.anthers.social`,
			sealedPassword: "v1.YWFhYWFhYWFhYWFh.YmJiYmJiYmJiYmJiYmJiYg.Y2Nj",
		});

		const result = await unlinkAtprotoFromUser(user.id);
		expect(result.error).toContain("Anthers issued you");

		const [still] = await db
			.select({ did: users.atprotoDid })
			.from(users)
			.where(eq(users.id, user.id));
		expect(still?.did).toBe(did);
	});

	// The other direction, so the refusal above is known to be about hosting rather than about
	// having an identity at all.
	it("still lets go of an identity that lives on somebody else's server", async () => {
		const user = await makeUser("theirs", {
			atprotoDid: `did:plc:${RUN}theirs`,
			atprotoHandle: "bob.bsky.social",
		});

		const result = await unlinkAtprotoFromUser(user.id);
		expect(result.error).toBeUndefined();

		const [gone] = await db
			.select({ did: users.atprotoDid })
			.from(users)
			.where(eq(users.id, user.id));
		expect(gone?.did).toBeNull();
	});
});

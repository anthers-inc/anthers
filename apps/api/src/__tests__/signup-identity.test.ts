// SPDX-License-Identifier: Apache-2.0
/**
 * A signup holds its handle from the click, and an account is created only with its identity.
 *
 * 🚨 **Two rules, and every test below holds one of them.** The first is that pressing the button
 * reserves the requested handle until the signup finishes, is changed or abandoned, or expires —
 * so nobody is stranded at the last step by a name taken out from under them. The second is that
 * the identity is settled BEFORE the `users` row is written, and the row is written with its DID:
 * whatever goes wrong at that step leaves the pending signup proved and its handle held, and never
 * leaves an account that exists without an identity.
 *
 * ⚠️ **The node is a stub, and every other address fails loudly** — see `stubNetwork`. Creating a
 * hosted identity for real would write a permanent entry in a public directory on every run.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import {
	atprotoSessions,
	hostedAccounts,
	pendingSignups,
	signupCodes,
	users,
} from "@anthers/db/schema";
import { eq, like, or } from "drizzle-orm";
import app from "../index.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import { readPendingSignup, startPendingSignup } from "../services/pending-signups.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import {
	JSON_HEADERS,
	NODE_URL,
	pendingCookie,
	signUp,
	spendCode,
	stubNetwork,
} from "./signup-fixture";

purgeAccountsCreatedHere();
const net = stubNetwork();

const RUN = `sid${Date.now().toString(36)}`;
const name = (tag: string) => `${RUN}${tag}`;
const full = (tag: string) => `${name(tag)}.node.invalid`;
const addr = (tag: string) => `${RUN}${tag}@example.test`;
const did = (tag: string) => `did:plc:${RUN}${tag}`;

beforeAll(() => {
	// Abandoning a signup revokes an unclaimed OAuth session; nothing here holds a real one.
	setAtprotoClient({ revoke: async () => {} } as never);
});

afterAll(async () => {
	setAtprotoClient(undefined);
	await db
		.delete(pendingSignups)
		.where(
			or(
				like(pendingSignups.email, `${RUN}%`),
				like(pendingSignups.hostedHandle, `${RUN}%`),
				like(pendingSignups.atprotoDid, `did:plc:${RUN}%`),
			),
		);
	await db.delete(hostedAccounts).where(like(hostedAccounts.did, `did:plc:${RUN}%`));
	await db.delete(atprotoSessions).where(like(atprotoSessions.did, `did:plc:${RUN}%`));
	await db.delete(signupCodes).where(like(signupCodes.email, `${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

/** Press the button on the Anthers door, as a browser holding `token` (or none). */
async function begin(
	body: Record<string, unknown>,
	token?: string,
): Promise<{ res: Response; token: string | undefined }> {
	const res = await app.request("/api/auth/signup/begin", {
		method: "POST",
		headers: { ...JSON_HEADERS, ...(token ? { Cookie: `signup_pending=${token}` } : {}) },
		body: JSON.stringify({ picks: { anthers: 0, follow: [], seed: [] }, ...body }),
	});
	return { res, token: pendingCookie(res.headers.get("set-cookie")) };
}

async function usersWithEmail(email: string) {
	return db.select().from(users).where(eq(users.email, email));
}

async function rowsHolding(handleName: string) {
	return db.select().from(pendingSignups).where(eq(pendingSignups.hostedHandle, handleName));
}

describe("pressing the button holds the handle", () => {
	it("refuses the same name to a second browser while the first is holding it", async () => {
		const first = await begin({ hostedHandle: name("held") });
		expect(first.res.status).toBe(200);
		expect(first.token).toBeTruthy();

		const second = await begin({ hostedHandle: name("held") });
		expect(second.res.status).toBe(409);
		expect(((await second.res.json()) as { error: string }).error).toBe(
			`${full("held")} is taken.`,
		);
		expect(second.token, "a refused press starts no signup").toBeUndefined();
		expect(await rowsHolding(name("held"))).toHaveLength(1);
	});

	it("does not collide with itself when the same browser presses again", async () => {
		const first = await begin({ hostedHandle: name("again") });
		const second = await begin({ hostedHandle: name("again") }, first.token);
		expect(second.res.status).toBe(200);

		expect(await readPendingSignup(first.token), "the first press is replaced").toBeUndefined();
		const rows = await rowsHolding(name("again"));
		expect(rows).toHaveLength(1);
		expect(rows[0].token).toBe(second.token as string);
	});

	it("does not let an expired signup keep holding a name", async () => {
		const stale = await begin({ hostedHandle: name("stale") });
		await db
			.update(pendingSignups)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(pendingSignups.token, stale.token as string));

		// ⚠️ **Reserved through the service rather than the route, deliberately.** `/signup/begin`
		// also runs an opportunistic sweep of expired signups, which can clear the row first and
		// make this pass with the release it is about removed. Here no sweep has run: the expired
		// row is still in the table, and the unique index still sees it.
		const fresh = await startPendingSignup({ hostedHandle: name("stale") });
		expect((await readPendingSignup(fresh))?.hostedHandle).toBe(name("stale"));
	});

	it("refuses a name the node already has", async () => {
		net.existing.add(full("onnode"));
		const res = await begin({ hostedHandle: name("onnode") });
		expect(res.res.status).toBe(409);
		expect(await rowsHolding(name("onnode"))).toHaveLength(0);
	});

	it("reports another browser's reservation as taken, and this browser's own as available", async () => {
		const holder = await begin({ hostedHandle: name("avail") });
		const ask = async (token?: string) => {
			const res = await app.request(`/api/atproto/handle-available?name=${name("avail")}`, {
				headers: token ? { Cookie: `signup_pending=${token}` } : {},
			});
			return (await res.json()) as { status: string; handle: string };
		};

		expect((await ask()).status).toBe("taken");
		const own = await ask(holder.token);
		expect(own.status, "the person holding it is told it is theirs").toBe("available");
		expect(own.handle).toBe(full("avail"));
	});
});

describe("changing the identity a signup asks for", () => {
	const choose = (token: string | undefined, hostedHandle: string) =>
		app.request("/api/auth/signup/identity", {
			method: "POST",
			headers: { ...JSON_HEADERS, ...(token ? { Cookie: `signup_pending=${token}` } : {}) },
			body: JSON.stringify({ hostedHandle }),
		});

	it("reserves the new name and releases the old one", async () => {
		const started = await begin({ hostedHandle: name("first") });
		const res = await choose(started.token, name("second"));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { pending: { hostedHandle: string } }).pending.hostedHandle).toBe(
			full("second"),
		);

		expect((await readPendingSignup(started.token))?.hostedHandle).toBe(name("second"));
		// The old name is free for somebody else the moment it is let go.
		expect((await begin({ hostedHandle: name("first") })).res.status).toBe(200);
	});

	it("drops a Bluesky identity the signup was carrying, because the doors are exclusive", async () => {
		const token = await startPendingSignup({
			identity: { did: did("fromdid"), handle: "was.bsky.social", pdsUrl: "https://pds.example" },
		});
		expect((await choose(token, name("fromdid"))).status).toBe(200);

		const row = await readPendingSignup(token);
		expect(row?.atprotoDid).toBeNull();
		expect(row?.hostedHandle).toBe(name("fromdid"));
	});

	it("refuses a name another signup is holding, and keeps the one it had", async () => {
		await begin({ hostedHandle: name("contest") });
		const other = await begin({ hostedHandle: name("mine") });

		const res = await choose(other.token, name("contest"));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe(`${full("contest")} is taken.`);
		expect((await readPendingSignup(other.token))?.hostedHandle).toBe(name("mine"));
	});

	it("needs a signup in progress", async () => {
		expect((await choose(undefined, name("nobody"))).status).toBe(404);
	});
});

describe("an account is created only with its identity", () => {
	it("creates nothing for a proved address with no signup in progress", async () => {
		const res = await spendCode("/api/auth/signup/verify", addr("nosignup"));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { reason: string }).reason).toBe("no_signup");
		expect(await usersWithEmail(addr("nosignup"))).toHaveLength(0);
	});

	it("refuses a signup that has chosen no identity, and keeps the proof for when it does", async () => {
		const token = await startPendingSignup({ email: addr("bare") });
		const res = await spendCode("/api/auth/signup/verify", addr("bare"), token);

		expect(res.status).toBe(409);
		const body = (await res.json()) as { reason: string; pending: { addressProved: boolean } };
		expect(body.reason).toBe("no_identity");
		expect(body.pending.addressProved).toBe(true);
		expect((await readPendingSignup(token))?.emailProvedAt).not.toBeNull();
		expect(await usersWithEmail(addr("bare"))).toHaveLength(0);
	});

	it("releases a name the node refuses, so another can be chosen, and creates nothing", async () => {
		const { token } = await begin({ hostedHandle: name("refused"), email: addr("refused") });
		net.create = { kind: "refuse", error: "HandleNotAvailable" };

		const res = await spendCode("/api/auth/signup/verify", addr("refused"), token);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { reason: string }).reason).toBe("handle_unavailable");
		expect((await readPendingSignup(token))?.hostedHandle).toBeNull();
		expect(await usersWithEmail(addr("refused"))).toHaveLength(0);
	});

	it("waits through a node outage with the handle held, then finishes without a second code", async () => {
		const { token } = await begin({ hostedHandle: name("later"), email: addr("later") });
		net.create = { kind: "down" };

		const failed = await spendCode("/api/auth/signup/verify", addr("later"), token);
		expect(failed.status).toBe(503);
		expect(((await failed.json()) as { reason: string }).reason).toBe("identity_unavailable");
		expect(failed.headers.get("set-cookie") ?? "").not.toContain("session=");

		const waiting = await readPendingSignup(token);
		expect(waiting?.hostedHandle, "the handle is still held").toBe(name("later"));
		expect(waiting?.emailProvedAt, "and the code still counts").not.toBeNull();
		expect(await usersWithEmail(addr("later"))).toHaveLength(0);

		net.create = { kind: "ok", did: did("later"), handle: full("later") };
		const finished = await app.request("/api/auth/signup/complete", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${token}` },
		});
		expect(finished.status).toBe(201);

		const [user] = await usersWithEmail(addr("later"));
		expect(user.atprotoDid).toBe(did("later"));
	});

	it("creates the account holding the identity the node just made, and records its credential", async () => {
		const { token } = await begin({ hostedHandle: name("made"), email: addr("made") });
		net.create = { kind: "ok", did: did("made"), handle: full("made") };

		const res = await spendCode("/api/auth/signup/verify", addr("made"), token);
		expect(res.status).toBe(201);
		expect(((await res.json()) as { created: boolean }).created).toBe(true);
		expect(res.headers.get("set-cookie") ?? "").toContain("session=");

		const [user] = await usersWithEmail(addr("made"));
		expect(user.atprotoDid).toBe(did("made"));
		expect(user.atprotoHandle).toBe(full("made"));
		expect(user.atprotoPdsUrl).toBe(NODE_URL);

		const [credential] = await db
			.select()
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, did("made")));
		expect(credential?.userId).toBe(user.id);
		expect(credential?.sealedPassword).toBeTruthy();

		expect(await readPendingSignup(token), "the signup is spent").toBeUndefined();
		expect(await rowsHolding(name("made"))).toHaveLength(0);
	});

	it("signs an existing account in without giving it the identity the signup asked for", async () => {
		expect((await signUp(addr("exists"))).status).toBe(201);
		const [before] = await usersWithEmail(addr("exists"));

		const { token } = await begin({ hostedHandle: name("exists"), email: addr("exists") });
		net.create = { kind: "ok", did: did("exists"), handle: full("exists") };

		const res = await spendCode("/api/auth/signup/verify", addr("exists"), token);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { created: boolean }).created).toBe(false);

		const [after] = await usersWithEmail(addr("exists"));
		expect(after.atprotoDid, "an account holds the one identity it was created with").toBe(
			before.atprotoDid,
		);
		const credentials = await db
			.select()
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, did("exists")));
		expect(credentials).toHaveLength(0);
		// Released rather than left held for a signup that became a sign-in.
		expect(await rowsHolding(name("exists"))).toHaveLength(0);
	});
});

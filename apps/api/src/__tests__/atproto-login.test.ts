// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in with Bluesky.
 *
 * The protocol half is `atproto-oauth.test.ts`'s. What is tested here is the half that is
 * ours and that a person can actually reach: which door each intent opens, where someone
 * lands afterwards, and the refusals that keep this from being a signup path or a way to
 * change which identity an account holds.
 *
 * 🚨 **The load-bearing assertions are the refusals.** A `next` that leaves the origin must
 * not survive the round trip; a Bluesky handle with no account must not mint one; and there
 * is no linking intent at all, because an account is created holding its one identity and a
 * flow that attached another would silently swap it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import { hasReachableEmail } from "../services/atproto.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import { createSession } from "../services/auth.js";
import { purgeAccountsCreatedHere } from "./cleanup";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const RUN = `bl${Date.now().toString(36)}`;
const did = (tag: string) => `did:plc:${RUN}${tag}`;

/** The options the fake client was last asked to authorize with. */
let lastAuthorize: { handle: string; options: { state?: string; scope?: string } } | undefined;
/** What the fake client's `callback()` should hand back next. */
let nextCallback: { did: string; state?: string } | undefined;

const realFetch = globalThis.fetch;

beforeAll(() => {
	// One fake stands in for the whole SDK client. `resolveIdentity` and the two flow
	// methods are all the routes touch, and faking them is what makes an OAuth round trip
	// testable without an authorization server.
	setAtprotoClient({
		authorize: async (handle: string, options: { state?: string; scope?: string }) => {
			lastAuthorize = { handle, options };
			return new URL("https://bsky.social/oauth/authorize?fake=1");
		},
		callback: async () => {
			if (!nextCallback) throw new Error("no callback staged");
			return { session: { did: nextCallback.did }, state: nextCallback.state };
		},
		identityResolver: {
			resolve: async (didOrHandle: string) => ({
				did: didOrHandle,
				handle: `${RUN}.bsky.social`,
				didDoc: {
					service: [
						{
							id: "#atproto_pds",
							type: "AtprotoPersonalDataServer",
							serviceEndpoint: "https://pds.example",
						},
					],
				},
			}),
		},
	} as never);

	// ⚠️ `getBlueskyProfile` calls the public Bluesky API unconditionally on the callback
	// path. It is best-effort and swallows failures, so leaving it real would still pass —
	// it would just make every one of these tests do a live network round trip for a
	// display name nothing asserts on.
	// `preconnect` rides along because Bun's `fetch` carries it and a bare async function
	// is not assignable without it — keeping the real one is more honest than casting the
	// shape away.
	globalThis.fetch = Object.assign(
		async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
		{ preconnect: realFetch.preconnect },
	);
});

afterAll(async () => {
	setAtprotoClient(undefined);
	globalThis.fetch = realFetch;
	await db.delete(atprotoSessions).where(like(atprotoSessions.did, `did:plc:${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

/** CSRF requires a real browser Origin — a bare Request never reaches the handler. */
function startAuth(body: unknown, headers: Record<string, string> = {}) {
	return app.request("/api/atproto/auth", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers },
		body: JSON.stringify(body),
	});
}

/** Run the callback with a staged outcome, and read where it sent the browser. */
async function runCallback(staged: { did: string; state?: string }): Promise<URL> {
	nextCallback = staged;
	const res = await app.request("/api/atproto/callback?code=x&state=y&iss=https://bsky.social");
	expect(res.status).toBe(302);
	return new URL(res.headers.get("location") as string);
}

/**
 * An account bound to the identity the faked OAuth callback signs in as.
 *
 * ⚠️ **Written directly, with the suite's own `did(tag)`, because the identity exists only inside
 * the faked OAuth client** — its resolver and its session are stubs, so there is no server for a
 * real identity to live on. This moves to a real identity when the local network gains a server
 * standing in for `bsky.social`, and the OAuth round trip with it.
 */
async function makeUser(tag: string, values: Partial<typeof users.$inferInsert> = {}) {
	const [user] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
			atprotoDid: did(tag),
			...values,
		})
		.returning();
	return user;
}

describe("where a sign-in lands", () => {
	it("carries an in-app destination through the round trip", async () => {
		const user = await makeUser("dest", { atprotoDid: did("dest") });

		const started = await startAuth({
			handle: "someone.bsky.social",
			intent: "login",
			next: "/works/a-game-4",
		});
		expect(started.status).toBe(200);

		const url = await runCallback({ did: did("dest"), state: lastAuthorize?.options.state });
		expect(url.pathname).toBe("/auth/atproto/callback");
		expect(url.searchParams.get("success")).toBe("login");
		expect(url.searchParams.get("next")).toBe("/works/a-game-4");
		// The session cookie is the actual sign-in; the redirect only says where to go.
		expect(started.headers.get("set-cookie")).toBeNull();
		expect(user.id).toBeGreaterThan(0);
	});

	it("refuses a destination that would leave the origin, at both ends", async () => {
		await makeUser("evil", { atprotoDid: did("evil") });

		await startAuth({
			handle: "someone.bsky.social",
			intent: "login",
			next: "//evil.example/phish",
		});
		// 🚨 First refusal: it never reaches the stored state, so a tampered row cannot
		// resurrect it either.
		const state = JSON.parse(lastAuthorize?.options.state ?? "{}");
		expect(state.next).toBeUndefined();

		// Second refusal: even handed a poisoned state directly, the callback drops it.
		const url = await runCallback({
			did: did("evil"),
			state: JSON.stringify({ intent: "login", next: "//evil.example/phish" }),
		});
		expect(url.searchParams.get("next")).toBeNull();
	});

	it("says so when the account still owes a handle", async () => {
		// The signup ceremony creates and signs in an account before asking for a name, and
		// nothing forces the question later — so this state outlives the flow that made it.
		await db
			.insert(users)
			.values({ email: `${RUN}onb@example.test`, emailVerified: true, atprotoDid: did("onb") })
			.returning();

		const url = await runCallback({
			did: did("onb"),
			state: JSON.stringify({ intent: "login", next: "/works/x-1" }),
		});
		expect(url.searchParams.get("onboarding")).toBe("1");
		expect(url.searchParams.get("next")).toBe("/works/x-1");
	});

	it("asks a reader for their own records and nothing else", async () => {
		await startAuth({ handle: "someone.bsky.social", intent: "login" });
		// ⚠️ **This passes because the account is a reader, not because a sign-in never asks
		// for more.** Every account is asked for the reader set, since a reader's comments and
		// votes are Anthers working; a creator's sign-in also carries the creator set through —
		// `atproto-publishing.test.ts` pins that half, and asking for less there would silently
		// discard a grant they had made.
		expect(lastAuthorize?.options.scope).toBe("atproto include:org.anthers.userPermissions");
	});
});

describe("signing in is not signing up", () => {
	it("refuses a handle that has no account, and creates nothing", async () => {
		const url = await runCallback({
			did: did("nobody"),
			state: JSON.stringify({ intent: "login" }),
		});
		// The code the callback page turns into "there is no account", rather than into
		// "something broke" — the distinction is the whole of what that person needs.
		expect(url.searchParams.get("error")).toBe("signup_disabled");
		expect(url.searchParams.get("success")).toBeNull();

		const rows = await db
			.select()
			.from(users)
			.where(eq(users.atprotoDid, did("nobody")));
		expect(rows.length).toBe(0);
	});
});

describe("an account's identity cannot be changed through sign-in", () => {
	// 🚨 **The link intent is gone, and a request for it must be refused rather than read as a
	// sign-in.** An account is created holding its one identity; a flow that attached a second
	// DID to a signed-in account would silently swap who that account is on the network.
	it("refuses the link intent outright, even for a signed-in account", async () => {
		const user = await makeUser("linker");
		const token = await createSession(user.id, undefined, undefined);
		lastAuthorize = undefined;

		const res = await startAuth(
			{ handle: "someone.bsky.social", intent: "link" },
			{ Cookie: `session=${token}` },
		);
		expect(res.status).toBe(400);
		expect(lastAuthorize, "nobody is sent to an authorization server").toBeUndefined();
	});
});

describe("which addresses a sign-in code can reach", () => {
	it("knows which addresses can actually be mailed", () => {
		expect(hasReachableEmail("someone@example.com")).toBe(true);
		// RFC 2606 reserves `.invalid` so it can never resolve — the placeholder is honest
		// about being unreachable rather than merely unverified.
		expect(hasReachableEmail("did:plc:abc@atproto.invalid")).toBe(false);
		expect(hasReachableEmail("")).toBe(false);
		expect(hasReachableEmail(null)).toBe(false);
	});
});

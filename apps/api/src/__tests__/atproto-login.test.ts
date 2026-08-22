// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signing in with Bluesky, linking one to an account, and unlinking again.
 *
 * The protocol half is `atproto-oauth.test.ts`'s. What is tested here is the half that is
 * ours and that a person can actually reach: which door each intent opens, where someone
 * lands afterwards, and the two refusals that keep this from being a signup path or a
 * lockout.
 *
 * 🚨 **The load-bearing assertions are the refusals.** A `next` that leaves the origin must
 * not survive the round trip; a Bluesky handle nobody has linked must not mint an account;
 * and unlinking must not strand an account that has no other way in — while no longer
 * refusing the many accounts that *do* and simply have no password.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import {
	hasReachableEmail,
	linkAtprotoToUser,
	unlinkAtprotoFromUser,
} from "../services/atproto.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import { createSession } from "../services/auth.js";

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

	it("asks for identity and nothing else", async () => {
		await startAuth({ handle: "someone.bsky.social", intent: "login" });
		// Writing records needs more, and bundling it into a sign-in is exactly what the
		// pivot plan defers. `transition:generic` is App-Password-equivalent access.
		expect(lastAuthorize?.options.scope).toBe("atproto");
	});
});

describe("signing in is not signing up", () => {
	it("refuses a handle no account has linked, and creates nothing", async () => {
		const prev = process.env.ATPROTO_SIGNUP_ENABLED;
		delete process.env.ATPROTO_SIGNUP_ENABLED;
		try {
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
		} finally {
			if (prev === undefined) delete process.env.ATPROTO_SIGNUP_ENABLED;
			else process.env.ATPROTO_SIGNUP_ENABLED = prev;
		}
	});
});

describe("linking", () => {
	it("needs a session, and says which failure it was", async () => {
		const res = await startAuth({ handle: "someone.bsky.social", intent: "link" });
		expect(res.status).toBe(401);
	});

	it("refuses a DID another account already holds, as a code the page can render", async () => {
		const owner = await makeUser("owner", { atprotoDid: did("shared") });
		const other = await makeUser("other");

		// ⚠️ A sentence here was unrenderable: `ATProtoCallbackPage` maps `did_already_linked`
		// to words, and the service returned prose that could never match the key. It read
		// fine on screen, which is why nothing caught it.
		const result = await linkAtprotoToUser(other.id, {
			did: did("shared"),
			handle: "x.bsky.social",
			pdsUrl: "https://pds.example",
		});
		expect(result.error).toBe("did_already_linked");
		expect(owner.atprotoDid).toBe(did("shared"));
	});

	it("carries the session's own user through the flow, not the client's claim", async () => {
		const user = await makeUser("linker");
		const token = await createSession(user.id, undefined, undefined);

		await startAuth(
			{ handle: "someone.bsky.social", intent: "link", next: "/somewhere" },
			{ Cookie: `session=${token}` },
		);
		const state = JSON.parse(lastAuthorize?.options.state ?? "{}");
		expect(state.userId).toBe(user.id);

		const url = await runCallback({ did: did("linker"), state: lastAuthorize?.options.state });
		expect(url.searchParams.get("success")).toBe("linked");

		const [after] = await db.select().from(users).where(eq(users.id, user.id));
		expect(after.atprotoDid).toBe(did("linker"));
	});
});

describe("unlinking must not lock anyone out", () => {
	it("lets a passwordless account with a real address unlink", async () => {
		// 🚨 This is the regression. A password has been optional since the signup ceremony
		// shipped — `/auth/signin/start` mails a code to any address that has an account —
		// so refusing every passwordless account refused most of them.
		const user = await makeUser("nopw", { atprotoDid: did("nopw"), passwordHash: null });
		expect(await unlinkAtprotoFromUser(user.id)).toEqual({});

		const [after] = await db.select().from(users).where(eq(users.id, user.id));
		expect(after.atprotoDid).toBeNull();
	});

	it("refuses when the account has neither a password nor a reachable address", async () => {
		const user = await makeUser("only", {
			atprotoDid: did("only"),
			passwordHash: null,
			email: `${RUN}only@atproto.invalid`,
		});
		const result = await unlinkAtprotoFromUser(user.id);
		expect(result.error).toMatch(/no way to sign in/i);

		const [after] = await db.select().from(users).where(eq(users.id, user.id));
		expect(after.atprotoDid).toBe(did("only"));
	});

	it("knows which addresses can actually be mailed", () => {
		expect(hasReachableEmail("someone@example.com")).toBe(true);
		// RFC 2606 reserves `.invalid` so it can never resolve — the placeholder is honest
		// about being unreachable rather than merely unverified.
		expect(hasReachableEmail("did:plc:abc@atproto.invalid")).toBe(false);
		expect(hasReachableEmail("")).toBe(false);
		expect(hasReachableEmail(null)).toBe(false);
	});
});

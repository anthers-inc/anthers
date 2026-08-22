// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signing up with a Bluesky identity, and the two rules the ceremony exists to keep.
 *
 * 🚨 **Rule one: an account is never created without an address Anthers can reach.** The
 * PDS is asked for one, and the four ways that can fail to produce a usable answer — the
 * scope was refused, the PDS holds none, it is unconfirmed, some account already has it —
 * all end in the same place: the identity is parked and the ordinary emailed-code ceremony
 * finishes the job. None of them creates anything.
 *
 * 🚨 **Rule two: an account created this way still owes a handle and the terms.** That is
 * carried by a single field — `username` stays null, which makes the account
 * `needsOnboarding` and routes it to `/welcome`, the only place the 13+ assertion is
 * presented. An earlier version generated a username from the Bluesky handle, which made
 * the account look finished while it had agreed to nothing.
 *
 * ⚠️ What cannot be tested here is the consent screen: whether bsky.social lets somebody
 * grant `atproto` while declining `transition:email` is unverified either way, and finding
 * out means a human authorizing on a real account. That is exactly why the granted scope is
 * read from the token rather than assumed — the refusal path below is reachable regardless.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoPendingSignups, atprotoSessions, signupCodes, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import {
	attachPendingSignup,
	PENDING_SIGNUP_TTL_MS,
	readPdsEmail,
	readPendingSignup,
	startPendingSignup,
	sweepExpiredPendingSignups,
} from "../services/atproto.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import { issueSignupCode } from "../services/signup-codes.js";

const RUN = `su${Date.now().toString(36)}`;
const did = (tag: string) => `did:plc:${RUN}${tag}`;
const addr = (tag: string) => `${RUN}${tag}@example.test`;

/** What the fake PDS will answer `com.atproto.server.getSession` with, and with what scope. */
let pds: { scope: string; body: Record<string, unknown>; ok: boolean } = {
	scope: "atproto transition:email",
	body: {},
	ok: true,
};
let nextCallback: { did: string; state?: string } | undefined;
let lastScope: string | undefined;

const realFetch = globalThis.fetch;
const prevFlag = process.env.ATPROTO_SIGNUP_ENABLED;

beforeAll(() => {
	process.env.ATPROTO_SIGNUP_ENABLED = "true";
	setAtprotoClient({
		authorize: async (_handle: string, options: { scope?: string }) => {
			lastScope = options.scope;
			return new URL("https://bsky.social/oauth/authorize?fake=1");
		},
		callback: async () => {
			if (!nextCallback) throw new Error("no callback staged");
			return {
				session: {
					did: nextCallback.did,
					getTokenInfo: async () => ({ scope: pds.scope }),
					fetchHandler: async () =>
						new Response(JSON.stringify(pds.body), {
							status: pds.ok ? 200 : 400,
							headers: { "Content-Type": "application/json" },
						}),
				},
				state: nextCallback.state,
			};
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

	// The Bluesky profile decoration is a live call on this path and asserts nothing here.
	globalThis.fetch = Object.assign(
		async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
		{ preconnect: realFetch.preconnect },
	);
});

afterEach(() => {
	pds = { scope: "atproto transition:email", body: {}, ok: true };
});

afterAll(async () => {
	setAtprotoClient(undefined);
	globalThis.fetch = realFetch;
	if (prevFlag === undefined) delete process.env.ATPROTO_SIGNUP_ENABLED;
	else process.env.ATPROTO_SIGNUP_ENABLED = prevFlag;
	await db.delete(atprotoPendingSignups).where(like(atprotoPendingSignups.did, `did:plc:${RUN}%`));
	await db.delete(atprotoSessions).where(like(atprotoSessions.did, `did:plc:${RUN}%`));
	await db.delete(signupCodes).where(like(signupCodes.email, `${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

/** Run the callback with a staged outcome, and read where it sent the browser. */
async function runCallback(staged: {
	did: string;
	intent?: string;
	next?: string;
}): Promise<{ url: URL; cookies: string }> {
	nextCallback = {
		did: staged.did,
		state: JSON.stringify({ intent: staged.intent ?? "signup", next: staged.next }),
	};
	const res = await app.request("/api/atproto/callback?code=x&state=y&iss=https://bsky.social");
	expect(res.status).toBe(302);
	return {
		url: new URL(res.headers.get("location") as string),
		cookies: res.headers.get("set-cookie") ?? "",
	};
}

function pendingCookie(setCookie: string): string | undefined {
	return setCookie.match(/atproto_pending=([^;]+)/)?.[1];
}

describe("the scope a signup asks for", () => {
	it("asks for the address, and only signup does", async () => {
		const start = (intent: string) =>
			app.request("/api/atproto/auth", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
				body: JSON.stringify({ handle: "someone.bsky.social", intent }),
			});

		await start("signup");
		expect(lastScope).toBe("atproto transition:email");

		// 🚨 Signing in must not ask. Bundling the email scope into the login intent would
		// make every returning person consent to us reading their address to do something
		// that never needs it.
		await start("login");
		expect(lastScope).toBe("atproto");
	});

	it("tells the browser whether the door is open, so a closed one is not advertised", async () => {
		// 🚨 Without this the closed state is a button that refuses when pressed, which is
		// worse than no button. The API refuses either way; this decides whether anybody is
		// invited to try.
		const read = async () =>
			((await (await app.request("/api/atproto/config")).json()) as { signupEnabled: boolean })
				.signupEnabled;

		expect(await read()).toBe(true);

		const prev = process.env.ATPROTO_SIGNUP_ENABLED;
		delete process.env.ATPROTO_SIGNUP_ENABLED;
		try {
			expect(await read()).toBe(false);
		} finally {
			process.env.ATPROTO_SIGNUP_ENABLED = prev;
		}
	});

	it("refuses before the round trip when signup is closed, not after", async () => {
		const prev = process.env.ATPROTO_SIGNUP_ENABLED;
		delete process.env.ATPROTO_SIGNUP_ENABLED;
		try {
			const res = await app.request("/api/atproto/auth", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
				body: JSON.stringify({ handle: "someone.bsky.social", intent: "signup" }),
			});
			// Sending somebody to another website to authorize, and only then telling them the
			// door is shut, is a worse refusal than this one.
			expect(res.status).toBe(403);
		} finally {
			if (prev === undefined) delete process.env.ATPROTO_SIGNUP_ENABLED;
			else process.env.ATPROTO_SIGNUP_ENABLED = prev;
		}
	});
});

describe("a PDS calling an address confirmed proves nothing", () => {
	it("still parks the signup, and creates no account", async () => {
		// 🚨 **The security assertion of this file.** A shortcut lived here until 2026-08-22:
		// `emailConfirmed: true` created the account outright and skipped our verification.
		// The server making that claim is whichever one the person's identity lives on, so
		// anybody self-hosting a PDS could assert an address belonging to somebody else and
		// walk away with an Anthers account bound to it. The remedy is not an allowlist of
		// trusted hosts — that is the wrong posture for a platform arguing it needs nobody's
		// permission — it is verifying everybody equally, which costs one email.
		pds.body = { email: addr("claimed"), emailConfirmed: true };

		const { url, cookies } = await runCallback({ did: did("claimed"), next: "/works/x-1" });
		expect(url.searchParams.get("success")).toBe("needs_email");
		expect(url.searchParams.get("next")).toBe("/works/x-1");
		expect(pendingCookie(cookies)).toBeTruthy();

		const rows = await db
			.select()
			.from(users)
			.where(eq(users.atprotoDid, did("claimed")));
		expect(rows.length, "a PDS's word must not be enough to mint an account").toBe(0);
	});

	it("signs in rather than scolding somebody who pressed the wrong button", async () => {
		// An identity that already has an account is a sign-in, whichever door it came
		// through — no scolding, and no second account.
		const [existing] = await db
			.insert(users)
			.values({ email: addr("again"), emailVerified: true, atprotoDid: did("again") })
			.returning();

		const { url } = await runCallback({ did: did("again") });
		expect(url.searchParams.get("success")).toBe("login");

		const rows = await db
			.select()
			.from(users)
			.where(eq(users.atprotoDid, did("again")));
		expect(rows.length).toBe(1);
		expect(rows[0].id).toBe(existing.id);
	});
});

describe("no answer a PDS can give creates an account", () => {
	const cases: [string, () => void][] = [
		["the scope was refused", () => (pds.scope = "atproto")],
		["the PDS holds no address", () => (pds.body = {})],
		[
			"the address is unconfirmed",
			() => (pds.body = { email: addr("unconf"), emailConfirmed: false }),
		],
		["the PDS refuses the call", () => (pds.ok = false)],
	];

	for (const [name, stage] of cases) {
		it(`parks the identity instead of creating an account when ${name}`, async () => {
			stage();
			const tag = name.replace(/\W/g, "").slice(0, 12);
			const { url, cookies } = await runCallback({ did: did(tag) });

			// Not an error — a hand-off. The identity is proved; only the address is missing.
			expect(url.searchParams.get("success")).toBe("needs_email");
			expect(pendingCookie(cookies)).toBeTruthy();

			const created = await db
				.select()
				.from(users)
				.where(eq(users.atprotoDid, did(tag)));
			expect(created.length, "no account may exist without a reachable address").toBe(0);
		});
	}

	it("parks it when the address already belongs to an Anthers account", async () => {
		// The interesting one. The PDS says this address is confirmed — but its claim is
		// somebody else's assertion, and taking over an existing account on the strength of
		// it would be a takeover. The emailed code settles it instead.
		await db.insert(users).values({ email: addr("taken"), emailVerified: true });
		pds.body = { email: addr("taken"), emailConfirmed: true };

		const { url } = await runCallback({ did: did("taken") });
		expect(url.searchParams.get("success")).toBe("needs_email");

		const [existing] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("taken")));
		expect(existing.atprotoDid, "the existing account must not be adopted").toBeNull();
	});

	it("carries the address forward as a prefill, without treating it as proof", async () => {
		pds.body = { email: addr("prefill"), emailConfirmed: false };
		const { cookies } = await runCallback({ did: did("prefill") });

		const res = await app.request("/api/atproto/pending", {
			headers: { Cookie: `atproto_pending=${pendingCookie(cookies)}` },
		});
		const body = (await res.json()) as { pending: { handle: string; email: string | null } };
		expect(body.pending.email).toBe(addr("prefill"));
		expect(body.pending.handle).toBe(`${RUN}.bsky.social`);
	});

	it("tells a browser holding no token nothing at all", async () => {
		const res = await app.request("/api/atproto/pending");
		expect(((await res.json()) as { pending: unknown }).pending).toBeNull();
	});
});

describe("the sign-in door still cannot sign anyone up", () => {
	it("refuses an unlinked handle even while signup is open", async () => {
		pds.body = { email: addr("viadoor"), emailConfirmed: true };
		const { url } = await runCallback({ did: did("viadoor"), intent: "login" });

		// 🚨 Signup being open does not make the sign-in door a signup door. It asked for
		// identity only, so it holds no address and could not create an account it can mail.
		expect(url.searchParams.get("error")).toBe("signup_disabled");
		const rows = await db
			.select()
			.from(users)
			.where(eq(users.atprotoDid, did("viadoor")));
		expect(rows.length).toBe(0);
	});
});

describe("the parked identity itself", () => {
	const identity = (tag: string) => ({
		did: did(tag),
		handle: "someone.bsky.social",
		pdsUrl: "https://pds.example",
	});

	it("attaches to the account whose address was just proved", async () => {
		const token = await startPendingSignup(identity("attach"));
		const [user] = await db
			.insert(users)
			.values({ email: addr("attach") })
			.returning();

		expect(await attachPendingSignup(token, user.id)).toEqual({ attached: true });
		const [after] = await db.select().from(users).where(eq(users.id, user.id));
		expect(after.atprotoDid).toBe(did("attach"));
	});

	it("is spent on use, so it cannot be replayed onto a second account", async () => {
		const token = await startPendingSignup(identity("once"));
		const [first] = await db
			.insert(users)
			.values({ email: addr("once1") })
			.returning();
		const [second] = await db
			.insert(users)
			.values({ email: addr("once2") })
			.returning();

		await attachPendingSignup(token, first.id);
		expect(await attachPendingSignup(token, second.id)).toEqual({ attached: false });

		const [after] = await db.select().from(users).where(eq(users.id, second.id));
		expect(after.atprotoDid).toBeNull();
	});

	it("refuses rather than steals a DID another account already holds", async () => {
		const [owner] = await db
			.insert(users)
			.values({ email: addr("owner"), atprotoDid: did("contested") })
			.returning();
		const [other] = await db
			.insert(users)
			.values({ email: addr("other") })
			.returning();

		const token = await startPendingSignup(identity("contested"));
		expect(await attachPendingSignup(token, other.id)).toEqual({ attached: false });

		const [stillOwner] = await db.select().from(users).where(eq(users.id, owner.id));
		expect(stillOwner.atprotoDid).toBe(did("contested"));
	});

	it("expires, and reads as absent before the sweep gets to it", async () => {
		const token = await startPendingSignup(identity("stale"));
		await db
			.update(atprotoPendingSignups)
			.set({ createdAt: new Date(Date.now() - PENDING_SIGNUP_TTL_MS - 1000) })
			.where(eq(atprotoPendingSignups.token, token));

		// Absent to a reader immediately — the sweep is housekeeping, never the gate.
		expect(await readPendingSignup(token)).toBeUndefined();

		await sweepExpiredPendingSignups();
		const rows = await db
			.select()
			.from(atprotoPendingSignups)
			.where(eq(atprotoPendingSignups.token, token));
		expect(rows.length).toBe(0);
	});

	it("does nothing at all without a token", async () => {
		const [user] = await db
			.insert(users)
			.values({ email: addr("notoken") })
			.returning();
		expect(await attachPendingSignup(undefined, user.id)).toEqual({ attached: false });
	});
});

describe("finishing a parked signup through the emailed code", () => {
	/** Spend a real code for an address, carrying whatever cookies are given. */
	async function verify(email: string, cookie: string) {
		const issued = await issueSignupCode(email);
		expect(issued.code, "the test needs the plaintext code the service just minted").toBeTruthy();
		return app.request("/api/auth/signup/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: cookie,
			},
			body: JSON.stringify({ email, code: issued.code }),
		});
	}

	it("creates the account and attaches the identity, in one ceremony", async () => {
		pds.scope = "atproto"; // refused, so it parks
		const { cookies } = await runCallback({ did: did("finish") });
		const token = pendingCookie(cookies);

		const res = await verify(addr("finish"), `atproto_pending=${token}`);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { created: boolean; needsOnboarding: boolean };
		expect(body.created).toBe(true);
		// Still owes a handle and the terms, exactly like every other new account.
		expect(body.needsOnboarding).toBe(true);

		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("finish")));
		expect(user.atprotoDid).toBe(did("finish"));
		expect(user.username).toBeNull();

		// The token is spent and the cookie cleared, so a back button cannot replay it.
		expect(await readPendingSignup(token)).toBeUndefined();
		expect(res.headers.get("set-cookie")).toMatch(/atproto_pending=;|atproto_pending=""/);
	});

	it("links a RETURNING account whose address matches, because they proved the mailbox", async () => {
		// 🚨 The collision case, resolved. The PDS said this address was confirmed and we
		// refused to act on that alone; a code we sent and they read is a different quality
		// of evidence, and it is enough.
		await db.insert(users).values({ email: addr("returning"), emailVerified: true });
		pds.body = { email: addr("returning"), emailConfirmed: true };
		const { cookies } = await runCallback({ did: did("returning") });

		const res = await verify(addr("returning"), `atproto_pending=${pendingCookie(cookies)}`);
		expect(res.status).toBe(200);

		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("returning")));
		expect(user.atprotoDid).toBe(did("returning"));
	});

	it("still signs somebody up when there is no parked identity at all", async () => {
		// The ordinary ceremony, unchanged. This is the regression guard for touching it.
		const res = await verify(addr("plain"), "");
		expect(res.status).toBe(201);
		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("plain")));
		expect(user.atprotoDid).toBeNull();
	});
});

describe("reading the address from a PDS", () => {
	it("reports the granted scope rather than the requested one", async () => {
		// ⭐ This is what makes the refusal path reachable at all. Assuming the scope we asked
		// for would turn a decline into a confusing failure much further downstream.
		const result = await readPdsEmail({
			getTokenInfo: async () => ({ scope: "atproto" }),
			fetchHandler: async () => new Response("{}"),
		});
		expect(result.scopeGranted).toBe(false);
		expect(result.email).toBeUndefined();
	});

	it("never throws, whatever the PDS does", async () => {
		const result = await readPdsEmail({
			getTokenInfo: async () => {
				throw new Error("PDS is down");
			},
			fetchHandler: async () => new Response("{}"),
		});
		// A soft failure, because the caller's remedy is the same for all of them: ask for
		// an address the ordinary way. There is nothing here worth an error page.
		expect(result).toEqual({ confirmed: false, scopeGranted: false });
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pending account — a signup asked for and not yet finished.
 *
 * 🚨 **The security of this whole flow is one sentence, and every assertion below is a way
 * of holding it: resumption is gated on the emailed code and never on knowing an address or
 * a handle.** Writing the signup down early is what makes it resumable, and resumable is
 * what makes it worth attacking — a row somebody else can claim is worse than no row.
 *
 * Three tests carry the weight and the rest are the surface around them:
 *
 *   • **An address-resumed signup does not carry an identity across.** Anyone can complete a
 *     real OAuth round trip with their own Bluesky account and then type *your* address; if
 *     the row handed its DID over when you proved that mailbox, your brand-new account would
 *     come into existence with a stranger's identity linked to it and they could sign in
 *     with it.
 *   • **The sign-in door still creates nothing.** It may now find an unfinished signup, which
 *     is what lets somebody carry on in another browser — but a mistyped address at `/login`
 *     has no pending signup behind it, so it mints exactly as much as it ever did.
 *   • **A pending signup is not an account.** No `users` row exists until a code has been
 *     spent, so nothing about it may claim the address, be signed into, or look finished.
 *
 * ⚠️ What cannot be tested here is the walk itself. Completing a signup means authorizing on
 * a real Bluesky account and reading a real mailbox, and no spec may do either — so the
 * emailed code is spent by minting it through the service, exactly as the ceremony spec does.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, pendingSignups, signupCodes, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import { setAtprotoClient } from "../services/atproto-client.js";
import {
	PENDING_SIGNUP_TTL_MS,
	readPendingSignup,
	startPendingSignup,
	sweepExpiredPendingSignups,
} from "../services/pending-signups.js";
import { issueSignInCode, issueSignupCode } from "../services/signup-codes.js";

const RUN = `ps${Date.now().toString(36)}`;
const addr = (tag: string) => `${RUN}${tag}@example.test`;
const did = (tag: string) => `did:plc:${RUN}${tag}`;

const JSON_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:3000" };

beforeAll(() => {
	// `clearPendingSignup` revokes at the authorization server before dropping an orphan
	// OAuth session. Nothing here is a real token, so the client is stubbed to a no-op
	// rather than left to reach the network from a unit test.
	setAtprotoClient({ revoke: async () => {} } as never);
});

afterAll(async () => {
	setAtprotoClient(undefined);
	await db.delete(pendingSignups).where(like(pendingSignups.email, `${RUN}%`));
	await db.delete(pendingSignups).where(like(pendingSignups.atprotoDid, `did:plc:${RUN}%`));
	await db.delete(atprotoSessions).where(like(atprotoSessions.did, `did:plc:${RUN}%`));
	await db.delete(signupCodes).where(like(signupCodes.email, `${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

/** Press *Create My Account*, and hand back the cookie the browser would be holding. */
async function begin(body: Record<string, unknown>): Promise<{ res: Response; token: string }> {
	const res = await app.request("/api/auth/signup/begin", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ picks: { anthers: 0, follow: [], seed: [] }, ...body }),
	});
	const token = (res.headers.get("set-cookie") ?? "").match(/signup_pending=([^;]+)/)?.[1] ?? "";
	return { res, token };
}

/**
 * Drop whatever code is live for an address.
 *
 * 🚨 **Without this the send throttle answers instead of the rule under test.** `begin`
 * mails a code, and a second `issueSignupCode` seconds later returns `{code: null}` because
 * one just went out — which reads identically to *"this door refused to issue"*. The expiry
 * test below was passing on exactly that confusion until 2026-08-26: it asserted `null` and
 * got `null` from the throttle, so it would have passed with the expiry check deleted.
 */
async function clearThrottle(email: string): Promise<void> {
	await db.delete(signupCodes).where(eq(signupCodes.email, email.trim().toLowerCase()));
}

/** Spend a real code at either door, carrying whatever cookie is given. */
async function spendCode(path: string, email: string, cookie: string): Promise<Response> {
	await clearThrottle(email);
	const issued = await issueSignupCode(email);
	expect(issued.code, "the test needs the plaintext code the service just minted").toBeTruthy();
	return app.request(path, {
		method: "POST",
		headers: { ...JSON_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
		body: JSON.stringify({ email, code: issued.code }),
	});
}

describe("asking for an account writes it down", () => {
	it("keeps the picks, so the page that finishes the job knows what it is finishing", async () => {
		const { res, token } = await begin({
			email: addr("picks"),
			picks: { anthers: 9, follow: ["alice", "bob"], seed: ["alice"] },
		});
		expect(res.status).toBe(200);

		const read = await app.request("/api/auth/signup/pending", {
			headers: { Cookie: `signup_pending=${token}` },
		});
		const body = (await read.json()) as {
			pending: { email: string; picks: { anthers: number; follow: string[]; seed: string[] } };
		};
		expect(body.pending.email).toBe(addr("picks"));
		expect(body.pending.picks.anthers).toBe(9);
		expect(body.pending.picks.follow).toEqual(["alice", "bob"]);
	});

	it("tells a browser holding no token nothing at all", async () => {
		// 🚨 The guard that keeps `/finish` from being an entry point. It answers from the
		// httpOnly cookie and nothing else, so a hand-typed URL gets null and the page sends
		// the visitor to `/subscribe`.
		const res = await app.request("/api/auth/signup/pending");
		expect(((await res.json()) as { pending: unknown }).pending).toBeNull();
	});

	it("holds one signup per browser, so a second press replaces the first", async () => {
		const first = await begin({ email: addr("twice1") });
		const second = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${first.token}` },
			body: JSON.stringify({
				email: addr("twice2"),
				picks: { anthers: 0, follow: [], seed: [] },
			}),
		});
		expect(second.status).toBe(200);

		// Pressing the button twice is somebody changing their mind, not two signups —
		// and leaving the first alive would mean a later resume could find the wrong one.
		expect(await readPendingSignup(first.token)).toBeUndefined();
	});

	it("sanitizes the destination on the way in rather than trusting it on the way out", async () => {
		const { token } = await begin({ email: addr("next"), next: "//evil.example/steal" });
		const row = await readPendingSignup(token);
		expect(row?.next, "a protocol-relative path is another host, not a path").toBe("");
	});

	it("says nothing about whether the address already has an account", async () => {
		await db.insert(users).values({ email: addr("known"), emailVerified: true });
		const known = await begin({ email: addr("known") });
		const stranger = await begin({ email: addr("stranger") });
		// The moment these answer differently, this endpoint becomes a way to ask "is this
		// person on Anthers?" and get a reliable answer.
		expect(known.res.status).toBe(stranger.res.status);
		expect(await known.res.text()).toBe(await stranger.res.text());
	});
});

describe("finishing it in the same browser", () => {
	it("mints the account, spends the row, and hands the picks back", async () => {
		const { token } = await begin({
			email: addr("finish"),
			picks: { anthers: 3, follow: ["carol"], seed: [] },
			next: "/works/x-1",
		});

		const res = await spendCode(
			"/api/auth/signup/verify",
			addr("finish"),
			`signup_pending=${token}`,
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			created: boolean;
			needsOnboarding: boolean;
			picks: { anthers: number; follow: string[] } | null;
			next: string | null;
		};
		expect(body.created).toBe(true);
		// 🚨 Still owes a handle and the terms. `username` staying null is the single field
		// that makes an account `needsOnboarding` and routes it to `/welcome`, which is the
		// only place the 13+ assertion is ever presented.
		expect(body.needsOnboarding).toBe(true);
		expect(body.picks?.anthers, "the choices survive the detour").toBe(3);
		expect(body.next).toBe("/works/x-1");

		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("finish")));
		expect(user.username).toBeNull();
		// A spent row cannot be replayed onto a second account.
		expect(await readPendingSignup(token)).toBeUndefined();
	});

	it("follows a corrected address, so the account is not minted against the typo", async () => {
		const { token } = await begin({ email: addr("typo") });
		await app.request("/api/auth/signup/start", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${token}` },
			body: JSON.stringify({ email: addr("fixed") }),
		});

		const row = await readPendingSignup(token);
		expect(row?.email).toBe(addr("fixed"));
	});
});

describe("resuming it in another browser", () => {
	it("issues a code for an unfinished signup, and still not for a stranger", async () => {
		await begin({ email: addr("resumable") });
		await clearThrottle(addr("resumable"));

		// ⭐ The widening: an address with an unfinished signup is one Anthers is already in a
		// relationship with, so mailing a code to it tells an outsider nothing new.
		expect((await issueSignInCode(addr("resumable"))).code).toBeTruthy();

		// 🚨 And the narrowing that must survive it. A mistyped address at `/login` has no
		// pending signup behind it, so this door mints exactly as much as it ever did: nothing.
		expect((await issueSignInCode(addr("nobody"))).code).toBeNull();
	});

	it("does not resume one that has expired", async () => {
		const { token } = await begin({ email: addr("stale") });
		await db
			.update(pendingSignups)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(pendingSignups.token, token));
		// The throttle would answer `null` for this address too — see `clearThrottle`.
		await clearThrottle(addr("stale"));

		expect((await issueSignInCode(addr("stale"))).code).toBeNull();
	});

	it("hands the signup to this browser and creates absolutely nothing", async () => {
		await begin({ email: addr("carry"), picks: { anthers: 6, follow: ["dee"], seed: [] } });

		const res = await spendCode("/api/auth/signin/verify", addr("carry"), "");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: unknown; resume: boolean };
		expect(body.resume).toBe(true);
		// 🚨 The load-bearing assertion. `/signin/*` exists as a separate pair from `/signup/*`
		// for exactly one reason, and this is it.
		expect(body.user, "the sign-in door hands back no session and no account").toBeNull();
		const made = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("carry")));
		expect(made.length).toBe(0);

		// The row is now bound to this browser, and its address is proved.
		const rebound = (res.headers.get("set-cookie") ?? "").match(/signup_pending=([^;]+)/)?.[1];
		expect(rebound).toBeTruthy();
		const row = await readPendingSignup(rebound);
		expect(row?.emailProvedAt).not.toBeNull();
		expect(row?.picks).toMatchObject({ anthers: 6 });
	});

	it("finishes from the proved stamp without asking for a second code", async () => {
		await begin({ email: addr("proved") });
		const signin = await spendCode("/api/auth/signin/verify", addr("proved"), "");
		const token = (signin.headers.get("set-cookie") ?? "").match(/signup_pending=([^;]+)/)?.[1];

		const res = await app.request("/api/auth/signup/complete", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${token}` },
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as { needsOnboarding: boolean }).needsOnboarding).toBe(true);

		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("proved")));
		expect(user.username, "a resumed signup owes a handle like every other one").toBeNull();

		// Spent. A back button cannot mint a second account from the same stamp.
		const again = await app.request("/api/auth/signup/complete", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${token}` },
		});
		expect(again.status).toBe(404);
	});

	it("refuses to finish a signup whose address nobody has proved", async () => {
		// ⚠️ The two things `/signup/complete` insists on are what keep it from being a second
		// signup door: a row bound to this browser, and a stamp on it. Neither can be produced
		// by asking — this row has the first and not the second.
		const { token } = await begin({ email: addr("unproved") });
		const res = await app.request("/api/auth/signup/complete", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${token}` },
		});
		expect(res.status).toBe(404);
		expect(
			(
				await db
					.select()
					.from(users)
					.where(eq(users.email, addr("unproved")))
			).length,
		).toBe(0);
	});

	it("still refuses an address with neither an account nor a signup", async () => {
		// Reachable only by somebody holding a live code for an address `/signin/start` would
		// never have mailed — which means a code minted at `/subscribe` was typed in here.
		const res = await spendCode("/api/auth/signin/verify", addr("orphancode"), "");
		expect(res.status).toBe(404);
		expect(
			(
				await db
					.select()
					.from(users)
					.where(eq(users.email, addr("orphancode")))
			).length,
		).toBe(0);
	});
});

describe("what an address-resumed signup may NOT carry across", () => {
	it("drops the ATProto identity, because a mailbox was proved and an identity was not", async () => {
		/*
		 * 🚨 **The takeover this closes, in full.** A stranger completes a real OAuth round
		 * trip with their own Bluesky account — so the DID on the row is genuinely theirs —
		 * and types somebody else's address into the finishing page. They walk away. The
		 * address's real owner signs up later in a browser with no cookie, completes a code
		 * sent to their own mailbox, and their account comes into existence. If the row handed
		 * its DID over at that point, the stranger could sign in to it with Bluesky forever.
		 *
		 * Proving a mailbox is not proving an identity. Coming back through Bluesky is how an
		 * identity is re-proved, and that path keeps the row whole.
		 */
		const token = await startPendingSignup({
			email: addr("victim"),
			identity: { did: did("squatter"), handle: "squatter.bsky.social", pdsUrl: "https://pds" },
		});
		await db
			.insert(atprotoSessions)
			.values({ did: did("squatter"), session: {}, userId: null })
			.onConflictDoNothing();

		const signin = await spendCode("/api/auth/signin/verify", addr("victim"), "");
		const rebound = (signin.headers.get("set-cookie") ?? "").match(/signup_pending=([^;]+)/)?.[1];

		const row = await readPendingSignup(rebound);
		expect(
			row?.atprotoDid,
			"an identity nobody re-proved must not survive the hand-over",
		).toBeNull();
		expect(row?.atprotoHandle).toBe("");

		// And the stranger's OAuth session goes with it, rather than sitting there as a live
		// token nobody tracks.
		const orphan = await db
			.select()
			.from(atprotoSessions)
			.where(eq(atprotoSessions.did, did("squatter")));
		expect(orphan.length).toBe(0);

		const finished = await app.request("/api/auth/signup/complete", {
			method: "POST",
			headers: { ...JSON_HEADERS, Cookie: `signup_pending=${rebound}` },
		});
		expect(finished.status).toBe(201);
		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, addr("victim")));
		expect(
			user.atprotoDid,
			"the account is the victim's, with nobody else's identity on it",
		).toBeNull();

		// The old token was rebound rather than left alive in the stranger's browser.
		expect(await readPendingSignup(token)).toBeUndefined();
	});
});

describe("an abandoned signup does not linger", () => {
	it("expires, reads as absent immediately, and takes its orphan OAuth session with it", async () => {
		// An abandoned pending signup is personal data belonging to somebody who never became
		// a user (51.05), and the OAuth session beside it is live tokens for somebody else's
		// repository. Both go.
		const token = await startPendingSignup({
			email: addr("abandoned"),
			identity: { did: did("abandoned"), handle: "gone.bsky.social", pdsUrl: "https://pds" },
		});
		await db
			.insert(atprotoSessions)
			.values({ did: did("abandoned"), session: {}, userId: null })
			.onConflictDoNothing();
		await db
			.update(pendingSignups)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(pendingSignups.token, token));

		// Absent to a reader before the sweep runs — the sweep is housekeeping, never the gate.
		expect(await readPendingSignup(token)).toBeUndefined();

		await sweepExpiredPendingSignups();
		expect(
			(await db.select().from(pendingSignups).where(eq(pendingSignups.token, token))).length,
		).toBe(0);
		expect(
			(
				await db
					.select()
					.from(atprotoSessions)
					.where(eq(atprotoSessions.did, did("abandoned")))
			).length,
		).toBe(0);
	});

	it("leaves an OAuth session that an account has since claimed", async () => {
		// ⚠️ Only null-`userId` rows are swept. A session that belongs to a real account is
		// that account's credential, and the expiring signup beside it says nothing about it.
		const [owner] = await db
			.insert(users)
			.values({ email: addr("claimed"), atprotoDid: did("claimed") })
			.returning();
		await db
			.insert(atprotoSessions)
			.values({ did: did("claimed"), session: {}, userId: owner.id })
			.onConflictDoNothing();

		const token = await startPendingSignup({
			email: addr("claimedpending"),
			identity: { did: did("claimed"), handle: "owner.bsky.social", pdsUrl: "https://pds" },
		});
		await db
			.update(pendingSignups)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(pendingSignups.token, token));
		await sweepExpiredPendingSignups();

		expect(
			(
				await db
					.select()
					.from(atprotoSessions)
					.where(eq(atprotoSessions.did, did("claimed")))
			).length,
		).toBe(1);
	});

	it("gives a signup long enough to read the mail, and not longer", async () => {
		// ⚠️ Seven days rather than the thirty minutes a parked identity used to get, because
		// what the row holds changed: this is a decision somebody made, and "press the button,
		// read the mail tomorrow" is the ordinary case rather than an edge one.
		const { token } = await begin({ email: addr("ttl") });
		const row = await readPendingSignup(token);
		const life = (row as NonNullable<typeof row>).expiresAt.getTime() - Date.now();
		expect(life).toBeGreaterThan(PENDING_SIGNUP_TTL_MS - 60_000);
		expect(life).toBeLessThanOrEqual(PENDING_SIGNUP_TTL_MS);
	});
});

// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { db } from "@anthers/db/client";
import { desktopAuthRequests, userSessions, users } from "@anthers/db/schema";
import { and, desc, eq, gt, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { allHeldSubjectIds } from "./legal-hold.js";

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** How stale `user_sessions.last_used_at` may get before a request refreshes it. */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
/** Enrollment window — long enough to read the authorize page, short enough to matter. */
const DESKTOP_AUTH_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/** How a session is carried. See `user_sessions.kind`. */
export type SessionKind = "web" | "desktop";

// ─── Token Generation ────────────────────────────────────────────────────────

/** Generate a 64-char hex token (two UUIDs with hyphens stripped) */
export function generateToken(): string {
	return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

// ─── Code & PIN Hashing ─────────────────────────────────────────────────────
//
// No account holds a password — sign-in is the emailed code — so these serve the other
// secrets of the same shape: the six-character codes (`services/signup-codes.ts`), the
// parental-control PIN, and the admin app's own sign-in codes. argon2id, by name, so a
// cheap digest cannot be substituted where the keyspace is small.

/**
 * The most argon2 operations this process runs at once.
 *
 * 🚨 **The API container is one vCPU and one gigabyte.** argon2id is expensive on purpose —
 * that is what makes a dumped hash useless — and Bun runs it on the thread pool, so a hundred
 * concurrent requests do not queue behind one another, they all allocate. A burst of
 * `/signup/begin` calls, each minting a code for a fresh address, could make every other
 * request on the platform wait on memory; a script did not need an account to do it.
 *
 * Two slots keeps one caller's ceremony exactly as costly as it was while bounding what a
 * crowd can ask for. The rate limiters in front of the doors are what stop the crowd from
 * forming; this is the floor under a limiter that is disabled in a test, misconfigured, or
 * racing a window boundary.
 */
const HASH_CONCURRENCY = 2;
let hashSlots = HASH_CONCURRENCY;
const hashWaiters: Array<() => void> = [];

/** Run `work` while holding one of the hash slots, waiting for a free one if need be. */
async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
	if (hashSlots > 0) {
		hashSlots -= 1;
	} else {
		await new Promise<void>((resolve) => hashWaiters.push(resolve));
	}
	try {
		return await work();
	} finally {
		// Hand the slot straight to the next waiter rather than releasing and re-taking it,
		// which would let a later arrival overtake somebody already queued.
		const next = hashWaiters.shift();
		if (next) next();
		else hashSlots += 1;
	}
}

/** Hash a short-lived secret using Bun's built-in argon2id */
export async function hashPassword(password: string): Promise<string> {
	return withHashSlot(() => Bun.password.hash(password, { algorithm: "argon2id" }));
}

/** Verify a secret against a hash */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return withHashSlot(() => Bun.password.verify(password, hash));
}

/**
 * Spend one hash's work on a comparison that is already known to fail.
 *
 * 🚨 **This is timing uniformity, and it is the reason a miss must do real work.** The admin
 * sign-in door mints a code row only for an active admin's address; without this, a wrong code
 * for an address with no account returns in microseconds while the same wrong code for a real
 * admin spends argon2, and the response time answers "is this person an admin?" for anybody
 * willing to ask twice. The hash is computed once and reused, so the cost is the comparison
 * rather than a fresh hash each time.
 */
let dummyHash: Promise<string> | null = null;

export async function spendPasswordWork(secret: string): Promise<void> {
	dummyHash ??= hashPassword(generateToken());
	// A verify against a valid hash cannot throw for a reason the caller can act on; a broken
	// constant would be a bug here, not a property of the submitted secret.
	await verifyPassword(secret, await dummyHash);
}

// ─── Session Management ──────────────────────────────────────────────────────

/**
 * The stored form of a session token.
 *
 * 🚨 **The raw token is a bearer credential, so the database keeps only its SHA-256.** A
 * dump, a replica or a read-only SQL credential then yields nothing that can be presented
 * as a session. The token is already 256 bits of randomness, so a plain hash is enough; no
 * password-style KDF is needed for a value that was never chosen by a person.
 */
export function hashSessionToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Create a new session for a user. Returns the session token. */
export async function createSession(
	userId: number,
	ipAddress?: string | null,
	userAgent?: string | null,
	options?: { kind?: SessionKind; label?: string | null },
): Promise<string> {
	const token = generateToken();
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

	await db.insert(userSessions).values({
		token: hashSessionToken(token),
		userId,
		ipAddress: ipAddress ?? null,
		userAgent: userAgent ?? null,
		kind: options?.kind ?? "web",
		label: options?.label ?? null,
		expiresAt,
	});

	return token;
}

/** Validate a session token. Returns the user if valid, null if expired/invalid. */
export async function validateSession(token: string) {
	const stored = hashSessionToken(token);
	const find = (value: string) =>
		db
			.select({
				session: userSessions,
				user: users,
			})
			.from(userSessions)
			.innerJoin(users, eq(userSessions.userId, users.id))
			.where(
				and(
					eq(userSessions.token, value),
					gt(userSessions.expiresAt, new Date()),
					// A suspended account is gone as far as its holder is concerned: no session
					// of it may authenticate, however fresh. `suspendAccount` deletes the rows
					// outright, so this predicate is the backstop rather than the mechanism —
					// the one fact every user of a session agrees on, in case a token
					// outlives the action that should have destroyed it. Session deletion is
					// not content deletion: a session is a credential, and `deleteExpiredSessions`
					// destroys them as routine hygiene.
					isNull(users.suspendedAt),
				),
			)
			.limit(1);

	let result = await find(stored);
	if (result.length === 0 && token !== stored) {
		// A row written before the hash migration: the raw token still names it. Accept
		// once and rewrite it in place, so the next request takes the ordinary path and
		// the credential does not stay in the clear.
		result = await find(token);
		if (result.length > 0) {
			await db
				.update(userSessions)
				.set({ token: stored })
				.where(eq(userSessions.id, result[0].session.id));
		}
	}
	if (result.length === 0) return null;

	return {
		session: result[0].session,
		user: result[0].user,
	};
}

/**
 * The active account a media token names, or null.
 *
 * 🚨 **Suspension is checked here for the same reason `validateSession` checks it.** A media
 * token is minted while an account is active and can outlive the action that suspends it;
 * the delivery route must not keep serving bytes to an account the session store has
 * already disowned. The token names a user id rather than a session row, so there is no
 * session lifetime left to consult — this predicate is the whole guard.
 */
export async function activeUserById(userId: number) {
	const [user] = await db
		.select()
		.from(users)
		.where(and(eq(users.id, userId), isNull(users.suspendedAt)))
		.limit(1);
	return user ?? null;
}

/** Delete a session (sign out) */
export async function deleteSession(token: string): Promise<void> {
	// Both spellings: the hashed row and, on a database that has not finished the lazy
	// migration, the legacy raw one.
	await db
		.delete(userSessions)
		.where(inArray(userSessions.token, [hashSessionToken(token), token]));
}

/**
 * Record that a session just authenticated a request.
 *
 * Throttled: skipped entirely unless the stored value is already older than
 * `LAST_USED_THROTTLE_MS`, so the Devices list gets a "last used" reading without
 * turning every authenticated API call into a write. The read that decides this has
 * already happened in validateSession, so the throttle costs nothing when it holds.
 */
export async function touchSession(session: {
	id: number;
	lastUsedAt: Date | null;
}): Promise<void> {
	const now = Date.now();
	if (session.lastUsedAt && now - session.lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
	await db
		.update(userSessions)
		.set({ lastUsedAt: new Date(now) })
		.where(eq(userSessions.id, session.id));
}

/**
 * List a user's live sessions for the Devices list, newest first. Tokens are never
 * included — this is a revocation UI, not a credential dispenser.
 */
export async function listUserSessions(userId: number) {
	return db
		.select({
			id: userSessions.id,
			kind: userSessions.kind,
			label: userSessions.label,
			ipAddress: userSessions.ipAddress,
			userAgent: userSessions.userAgent,
			lastUsedAt: userSessions.lastUsedAt,
			createdAt: userSessions.createdAt,
			expiresAt: userSessions.expiresAt,
		})
		.from(userSessions)
		.where(and(eq(userSessions.userId, userId), gt(userSessions.expiresAt, new Date())))
		.orderBy(desc(userSessions.createdAt));
}

/**
 * Revoke one of a user's own sessions by id. Scoped to `userId` in the WHERE clause
 * rather than checked beforehand, so one user can never revoke another's session
 * even if they guess the id. Returns false when nothing matched.
 */
export async function revokeUserSession(userId: number, sessionId: number): Promise<boolean> {
	const deleted = await db
		.delete(userSessions)
		.where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)))
		.returning({ id: userSessions.id });
	return deleted.length > 0;
}

// ─── Desktop Enrollment (browser handoff + PKCE) ──────────────────────────────

/** SHA-256 of a PKCE verifier, lowercase hex — the form stored as `challenge`. */
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Open a desktop enrollment. Called unauthenticated by the app itself, which has only
 * generated a verifier — no session exists yet and no user is implied. Re-opening an
 * existing challenge is idempotent so a retried request can't strand the flow.
 */
export async function startDesktopAuth(challenge: string, label: string | null): Promise<void> {
	const expiresAt = new Date(Date.now() + DESKTOP_AUTH_EXPIRY_MS);
	await db
		.insert(desktopAuthRequests)
		.values({ challenge, label, expiresAt })
		.onConflictDoUpdate({
			target: desktopAuthRequests.challenge,
			set: { label, expiresAt, code: null, sessionToken: null, userId: null, consumedAt: null },
		});
}

/** A pending enrollment, as shown on the authorize page before the creator confirms. */
export async function getPendingDesktopAuth(challenge: string) {
	const [row] = await db
		.select()
		.from(desktopAuthRequests)
		.where(
			and(
				eq(desktopAuthRequests.challenge, challenge),
				gt(desktopAuthRequests.expiresAt, new Date()),
			),
		)
		.limit(1);
	if (!row || row.consumedAt) return null;
	return row;
}

/**
 * The confirm click: mint the desktop session and a one-time code that redeems it.
 * Runs in the browser under a normal cookie session, so the user is already proven —
 * this call is what turns that proof into a separately revocable desktop credential.
 */
export async function authorizeDesktopAuth(
	challenge: string,
	userId: number,
	ipAddress: string | null,
	userAgent: string | null,
): Promise<string | null> {
	const pending = await getPendingDesktopAuth(challenge);
	if (!pending) return null;

	const sessionToken = await createSession(userId, ipAddress, userAgent, {
		kind: "desktop",
		label: pending.label,
	});
	const code = generateToken();

	await db
		.update(desktopAuthRequests)
		.set({ code, sessionToken, userId })
		.where(eq(desktopAuthRequests.id, pending.id));

	return code;
}

/**
 * Redeem a code for the session token, proving possession of the verifier.
 *
 * This is the step that makes deep-link interception useless: a rogue local app that
 * registers `anthers://` and grabs the code never saw the verifier, so the hash won't
 * match and the code is spent either way — the row is marked consumed on ANY redemption
 * attempt against it, so a stolen code cannot be retried once the real app fails over.
 */
export async function redeemDesktopAuth(code: string, verifier: string): Promise<string | null> {
	const [row] = await db
		.select()
		.from(desktopAuthRequests)
		.where(and(eq(desktopAuthRequests.code, code), gt(desktopAuthRequests.expiresAt, new Date())))
		.limit(1);

	if (!row || row.consumedAt || !row.sessionToken) return null;

	// Burn the row first, whatever the outcome — a code is single-use by definition,
	// and a wrong verifier means someone other than the requester holds it.
	await db
		.update(desktopAuthRequests)
		.set({ consumedAt: new Date(), sessionToken: null, code: null })
		.where(eq(desktopAuthRequests.id, row.id));

	const expected = await pkceChallenge(verifier);
	if (expected !== row.challenge) return null;

	return row.sessionToken;
}

/** Drop expired/consumed enrollment rows. Safe to call opportunistically. */
export async function cleanupDesktopAuthRequests(): Promise<void> {
	await db.delete(desktopAuthRequests).where(lt(desktopAuthRequests.expiresAt, new Date()));
}

/**
 * Delete all expired sessions. Returns how many rows went.
 *
 * 🚨 **Run it, don't just export it.** This was exported and called from nowhere until
 * 2026-08-12, while Privacy Policy promised "Sessions: deleted when they expire" — and because
 * `validateSession` and `listUserSessions` both filter on `expiresAt > now()`, nothing
 * anywhere behaved differently for the rows that should have been gone. The `ip_address`
 * and `user_agent` on every session ever created were simply kept. It is scheduled as
 * `QUEUES.PRUNE_CREDENTIALS` now.
 *
 * The count is returned rather than logged here so a test can assert on **rows removed**.
 * Asserting through a read would prove nothing: every user already excludes what this
 * is supposed to delete, so the test would pass identically against a no-op.
 */
export async function deleteExpiredSessions(): Promise<number> {
	// 🚨 A session row is the only place Anthers holds an IP address, so this sweep is
	// the one that destroys the network evidence a child-safety report is most likely
	// to be asked for. Sessions of a held user survive their expiry — they are already
	// dead to every user, which filters on `expiresAt`, so keeping the row costs a
	// row and preserves the address.
	const held = await allHeldSubjectIds("user");
	const gone = await db
		.delete(userSessions)
		.where(
			held.length > 0
				? and(lt(userSessions.expiresAt, new Date()), notInArray(userSessions.userId, held))
				: lt(userSessions.expiresAt, new Date()),
		)
		.returning({ id: userSessions.id });
	return gone.length;
}

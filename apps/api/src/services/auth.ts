// SPDX-License-Identifier: AGPL-3.0-or-later
import { db } from "@anthers/db/client";
import { desktopAuthRequests, sessions, users, verificationTokens } from "@anthers/db/schema";
import { and, desc, eq, gt, lt } from "drizzle-orm";

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
/** How stale `sessions.last_used_at` may get before a request refreshes it. */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
/** Enrolment window — long enough to read the authorize page, short enough to matter. */
const DESKTOP_AUTH_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/** How a session is carried. See `sessions.kind`. */
export type SessionKind = "web" | "desktop";

// ─── Token Generation ────────────────────────────────────────────────────────

/** Generate a 64-char hex token (two UUIDs with hyphens stripped) */
export function generateToken(): string {
	return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

// ─── Password Hashing ───────────────────────────────────────────────────────

/** Hash a password using Bun's built-in argon2id */
export async function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Verify a password against a hash */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return Bun.password.verify(password, hash);
}

// ─── Session Management ──────────────────────────────────────────────────────

/** Create a new session for a user. Returns the session token. */
export async function createSession(
	userId: number,
	ipAddress?: string | null,
	userAgent?: string | null,
	options?: { kind?: SessionKind; label?: string | null },
): Promise<string> {
	const token = generateToken();
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

	await db.insert(sessions).values({
		token,
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
	const result = await db
		.select({
			session: sessions,
			user: users,
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
		.limit(1);

	if (result.length === 0) return null;

	return {
		session: result[0].session,
		user: result[0].user,
	};
}

/** Delete a session (sign out) */
export async function deleteSession(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.token, token));
}

/** Delete all sessions for a user (e.g. after password change) */
export async function deleteAllUserSessions(userId: number): Promise<void> {
	await db.delete(sessions).where(eq(sessions.userId, userId));
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
		.update(sessions)
		.set({ lastUsedAt: new Date(now) })
		.where(eq(sessions.id, session.id));
}

/**
 * List a user's live sessions for the Devices list, newest first. Tokens are never
 * included — this is a revocation UI, not a credential dispenser.
 */
export async function listUserSessions(userId: number) {
	return db
		.select({
			id: sessions.id,
			kind: sessions.kind,
			label: sessions.label,
			ipAddress: sessions.ipAddress,
			userAgent: sessions.userAgent,
			lastUsedAt: sessions.lastUsedAt,
			createdAt: sessions.createdAt,
			expiresAt: sessions.expiresAt,
		})
		.from(sessions)
		.where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
		.orderBy(desc(sessions.createdAt));
}

/**
 * Revoke one of a user's own sessions by id. Scoped to `userId` in the WHERE clause
 * rather than checked beforehand, so one user can never revoke another's session
 * even if they guess the id. Returns false when nothing matched.
 */
export async function revokeUserSession(userId: number, sessionId: number): Promise<boolean> {
	const deleted = await db
		.delete(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
		.returning({ id: sessions.id });
	return deleted.length > 0;
}

// ─── Desktop Enrolment (browser handoff + PKCE) ──────────────────────────────

/** SHA-256 of a PKCE verifier, lowercase hex — the form stored as `challenge`. */
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Open a desktop enrolment. Called unauthenticated by the app itself, which has only
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

/** A pending enrolment, as shown on the authorize page before the creator confirms. */
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

/**
 * The polling half of enrolment, for a client with no callback to be called back on.
 *
 * ── Why this exists beside `redeemDesktopAuth` rather than reusing it ───────────────
 *
 * The one-time `code` is a **courier**. It carries authorization across the one hop the
 * desktop flow cannot avoid: the browser holds the proof, the app needs it, and the two are
 * separate processes joined only by a registered `anthers://` scheme. A CLI has no such
 * hop. It can simply ask, repeatedly, whether the browser has confirmed yet — so there is
 * nothing for a code to carry, and inventing one would mean shipping a credential through a
 * channel that exists only to be intercepted.
 *
 * ── This is not weaker than the code path; it is the same proof with a step removed ──
 *
 * PKCE's whole claim is that possession of the **verifier** identifies the client that
 * started the flow. `redeemDesktopAuth` checks exactly that, after using the code to find
 * the row. Here the verifier finds the row *and* proves possession in one step, because the
 * stored challenge IS its hash — so an attacker needs the same secret either way.
 *
 * 🚨 **A poll keyed on the challenge instead would have been a denial-of-service.** The
 * challenge travels in the authorize URL — visible in the address bar, in history, over
 * whatever channel the user forwarded it. Anyone who saw it could have fetched the code and
 * burned the row with a wrong verifier (`redeemDesktopAuth` consumes on *any* attempt, by
 * design), leaving the real client permanently pending. Keying on the verifier, which never
 * leaves the client, closes that: the URL stays as harmless as it looks.
 *
 * Returns `"pending"` while the browser has not confirmed, `null` when there is nothing to
 * wait for — expired, consumed, or never started — and the session token exactly once.
 */
export async function pollDesktopAuth(verifier: string): Promise<string | "pending" | null> {
	const challenge = await pkceChallenge(verifier);
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
	if (!row.sessionToken) return "pending";

	// Burn on handover, same as the code path: the row's job is done and leaving a live
	// session token in a table that an unauthenticated endpoint reads is not a thing to do.
	await db
		.update(desktopAuthRequests)
		.set({ consumedAt: new Date(), sessionToken: null, code: null })
		.where(eq(desktopAuthRequests.id, row.id));

	return row.sessionToken;
}

/** Drop expired/consumed enrolment rows. Safe to call opportunistically. */
export async function cleanupDesktopAuthRequests(): Promise<void> {
	await db.delete(desktopAuthRequests).where(lt(desktopAuthRequests.expiresAt, new Date()));
}

/** Delete all expired sessions (cleanup) */
export async function deleteExpiredSessions(): Promise<void> {
	await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

// ─── Email Verification ──────────────────────────────────────────────────────

/** Create an email verification token. Returns the token string. */
export async function createEmailVerificationToken(userId: number): Promise<string> {
	// Delete any existing email verification tokens for this user
	await db
		.delete(verificationTokens)
		.where(and(eq(verificationTokens.userId, userId), eq(verificationTokens.type, "email_verify")));

	const token = generateToken();
	await db.insert(verificationTokens).values({
		userId,
		token,
		type: "email_verify",
		expiresAt: new Date(Date.now() + EMAIL_VERIFY_EXPIRY_MS),
	});

	return token;
}

/** Verify an email verification token. Returns the userId if valid, null otherwise. */
export async function verifyEmailToken(token: string): Promise<number | null> {
	const [result] = await db
		.select()
		.from(verificationTokens)
		.where(
			and(
				eq(verificationTokens.token, token),
				eq(verificationTokens.type, "email_verify"),
				gt(verificationTokens.expiresAt, new Date()),
			),
		)
		.limit(1);

	if (!result) return null;

	// Mark user as verified and delete the token
	await db.update(users).set({ emailVerified: true }).where(eq(users.id, result.userId));
	await db.delete(verificationTokens).where(eq(verificationTokens.id, result.id));

	return result.userId;
}

// ─── Password Reset ──────────────────────────────────────────────────────────

/** Create a password reset token. Returns the token string. */
export async function createPasswordResetToken(userId: number): Promise<string> {
	// Delete any existing password reset tokens for this user
	await db
		.delete(verificationTokens)
		.where(
			and(eq(verificationTokens.userId, userId), eq(verificationTokens.type, "password_reset")),
		);

	const token = generateToken();
	await db.insert(verificationTokens).values({
		userId,
		token,
		type: "password_reset",
		expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
	});

	return token;
}

/** Validate a password reset token. Returns the userId if valid, null otherwise. */
export async function validatePasswordResetToken(token: string): Promise<number | null> {
	const [result] = await db
		.select()
		.from(verificationTokens)
		.where(
			and(
				eq(verificationTokens.token, token),
				eq(verificationTokens.type, "password_reset"),
				gt(verificationTokens.expiresAt, new Date()),
			),
		)
		.limit(1);

	return result?.userId ?? null;
}

/** Reset password using a valid token. Invalidates all sessions. */
export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
	const userId = await validatePasswordResetToken(token);
	if (!userId) return false;

	const passwordHash = await hashPassword(newPassword);
	await db.update(users).set({ passwordHash }).where(eq(users.id, userId));

	// Delete the used token
	await db
		.delete(verificationTokens)
		.where(and(eq(verificationTokens.token, token), eq(verificationTokens.type, "password_reset")));

	// Invalidate all existing sessions for security
	await deleteAllUserSessions(userId);

	return true;
}

/** Delete all expired verification tokens (cleanup) */
export async function deleteExpiredTokens(): Promise<void> {
	await db.delete(verificationTokens).where(lt(verificationTokens.expiresAt, new Date()));
}

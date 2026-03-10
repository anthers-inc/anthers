import { eq, and, gt, lt, or } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { sessions, users, verificationTokens } from "@anthers/db/schema";

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

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
): Promise<string> {
	const token = generateToken();
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

	await db.insert(sessions).values({
		token,
		userId,
		ipAddress: ipAddress ?? null,
		userAgent: userAgent ?? null,
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
		.where(
			and(eq(verificationTokens.userId, userId), eq(verificationTokens.type, "email_verify")),
		);

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
			and(
				eq(verificationTokens.userId, userId),
				eq(verificationTokens.type, "password_reset"),
			),
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
		.where(
			and(
				eq(verificationTokens.token, token),
				eq(verificationTokens.type, "password_reset"),
			),
		);

	// Invalidate all existing sessions for security
	await deleteAllUserSessions(userId);

	return true;
}

/** Delete all expired verification tokens (cleanup) */
export async function deleteExpiredTokens(): Promise<void> {
	await db.delete(verificationTokens).where(lt(verificationTokens.expiresAt, new Date()));
}

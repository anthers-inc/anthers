import { eq, and, gt } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { sessions, users, verificationTokens } from "@anthers/db/schema";

/** Generate a 64-char hex session token (two UUIDs with hyphens stripped) */
export function generateSessionToken(): string {
	return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

/** Hash a password using Bun's built-in argon2id */
export async function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Verify a password against a hash */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return Bun.password.verify(password, hash);
}

/** Create a new session for a user. Returns the session token. */
export async function createSession(
	userId: number,
	ipAddress?: string | null,
	userAgent?: string | null,
): Promise<string> {
	const token = generateSessionToken();
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

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

/** Delete all expired sessions (cleanup) */
export async function deleteExpiredSessions(): Promise<void> {
	await db.delete(sessions).where(gt(new Date(), sessions.expiresAt));
}

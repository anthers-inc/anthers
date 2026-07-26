// SPDX-License-Identifier: AGPL-3.0-or-later
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { bearerToken } from "../middleware/bearer.js";
import { invalidBody } from "../middleware/validate.js";
import { isReservedUsername } from "../reserved-usernames.js";
import {
	authorizeDesktopAuth,
	cleanupDesktopAuthRequests,
	createEmailVerificationToken,
	createPasswordResetToken,
	createSession,
	deleteSession,
	getPendingDesktopAuth,
	hashPassword,
	listUserSessions,
	redeemDesktopAuth,
	resetPassword,
	revokeUserSession,
	startDesktopAuth,
	validateSession,
	verifyEmailToken,
	verifyPassword,
} from "../services/auth.js";
import { sendVerificationEmail, sendWelcomeEmail } from "../services/email.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const signUpSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(150)
		.regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, underscores")
		// A name the router already answers to would sign up fine and then strand
		// the profile at an unreachable URL — see reserved-usernames.ts.
		.refine((name) => !isReservedUsername(name), "That username is reserved"),
	email: z.string().email().max(254),
	password: z.string().min(8).max(128),
});

const signInSchema = z.object({
	login: z.string(), // accepts username or email
	password: z.string(),
});

const verifyEmailSchema = z.object({
	token: z.string().min(1),
});

const requestPasswordResetSchema = z.object({
	email: z.string().email(),
});

const resetPasswordSchema = z.object({
	token: z.string().min(1),
	password: z.string().min(8).max(128),
});

const changePasswordSchema = z.object({
	currentPassword: z.string(),
	newPassword: z.string().min(8).max(128),
});

/** A PKCE challenge/code/verifier — all are hex tokens from `generateToken()`. */
const hexToken = z
	.string()
	.min(32)
	.max(128)
	.regex(/^[0-9a-f]+$/, "Expected a lowercase hex token");

const desktopStartSchema = z.object({
	challenge: hexToken,
	label: z.string().min(1).max(80).optional(),
});

const desktopAuthorizeSchema = z.object({
	challenge: hexToken,
});

const desktopExchangeSchema = z.object({
	code: hexToken,
	verifier: hexToken,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Standard user shape returned from auth endpoints */
function serializeUser(user: typeof users.$inferSelect) {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		displayName: user.displayName,
		bio: user.bio,
		isCreator: user.isCreator,
		isAdmin: user.isAdmin,
		avatar: user.avatar,
		headerImage: user.headerImage,
		websiteUrl: user.websiteUrl,
		location: user.location,
		emailVerified: user.emailVerified,
		themePreference: user.themePreference,
		atprotoDid: user.atprotoDid,
		atprotoHandle: user.atprotoHandle,
		createdAt: user.createdAt,
	};
}

// Scope the session cookie to the parent domain (e.g. ".anthers.org") in prod so it's
// shared across the consumer site and the Creator Studio subdomain. Unset in dev
// (host-only cookie on localhost). Subdomains are same-site, so SameSite=Lax still sends it.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

function setSessionCookie(c: any, token: string) {
	setCookie(c, "session", token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60, // 30 days
		...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
	});
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const authRoutes = new Hono()
	// ── Sign Up ───────────────────────────────────────────────────────────────
	.post("/sign-up", zValidator("json", signUpSchema, invalidBody), async (c) => {
		const { username, email, password } = c.req.valid("json");

		// Check for existing user (username or email)
		const existing = await db
			.select({ id: users.id, username: users.username, email: users.email })
			.from(users)
			.where(or(eq(users.username, username), eq(users.email, email)))
			.limit(2);

		for (const row of existing) {
			if (row.username === username) {
				return c.json({ error: "Username already taken" }, 409);
			}
			if (row.email === email) {
				return c.json({ error: "Email already registered" }, 409);
			}
		}

		// Create user
		const passwordHash = await hashPassword(password);
		const [user] = await db.insert(users).values({ username, email, passwordHash }).returning();

		// Create session
		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		// Send the welcome + email-verification message. Never let a mail hiccup
		// fail the sign-up itself — the user can always re-request verification.
		const verifyToken = await createEmailVerificationToken(user.id);
		await sendWelcomeEmail(user.email, user.username, verifyToken);

		return c.json({ user: serializeUser(user) }, 201);
	})

	// ── Sign In (accepts username or email) ──────────────────────────────────
	.post("/sign-in", zValidator("json", signInSchema, invalidBody), async (c) => {
		const { login, password } = c.req.valid("json");

		// Look up by username or email
		const [user] = await db
			.select()
			.from(users)
			.where(or(eq(users.username, login), eq(users.email, login)))
			.limit(1);

		if (!user?.passwordHash) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		const valid = await verifyPassword(password, user.passwordHash);
		if (!valid) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		return c.json({ user: serializeUser(user) });
	})

	// ── Sign Out ──────────────────────────────────────────────────────────────
	// Reads the bearer token first so a desktop sign-out ends the DESKTOP session
	// rather than silently doing nothing (these two routes resolve the session
	// themselves instead of going through requireAuth, so they need the same rule).
	.post("/sign-out", async (c) => {
		const token = bearerToken(c) ?? getCookie(c, "session");
		if (token) {
			await deleteSession(token);
		}
		deleteCookie(c, "session", { path: "/", ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) });
		return c.json({ success: true });
	})

	// ── Current User ─────────────────────────────────────────────────────────
	.get("/me", async (c) => {
		const presentedBearer = bearerToken(c);
		const token = presentedBearer ?? getCookie(c, "session");
		if (!token) {
			return c.json({ user: null });
		}

		const result = await validateSession(token);
		if (!result) {
			// Only a browser has a cookie to clear; a dead bearer token is the client's
			// to discard, and clearing the cookie here would sign the browser out of a
			// session the desktop app's staleness says nothing about.
			if (!presentedBearer) {
				deleteCookie(c, "session", {
					path: "/",
					...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
				});
			}
			return c.json({ user: null });
		}

		return c.json({ user: serializeUser(result.user) });
	})

	// ── Email Verification ───────────────────────────────────────────────────
	.post("/verify-email", zValidator("json", verifyEmailSchema, invalidBody), async (c) => {
		const { token } = c.req.valid("json");
		const userId = await verifyEmailToken(token);

		if (!userId) {
			return c.json({ error: "Invalid or expired verification token" }, 400);
		}

		return c.json({ success: true });
	})

	// ── Resend Verification Email ────────────────────────────────────────────
	.post("/resend-verification", requireAuth, async (c) => {
		const user = c.get("user");

		// Check if already verified
		const [fullUser] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);

		if (fullUser?.emailVerified) {
			return c.json({ error: "Email already verified" }, 400);
		}

		const verifyToken = await createEmailVerificationToken(user.id);
		await sendVerificationEmail(user.email, user.username, verifyToken);
		return c.json({ success: true });
	})

	// ── Request Password Reset ───────────────────────────────────────────────
	.post(
		"/request-password-reset",
		zValidator("json", requestPasswordResetSchema, invalidBody),
		async (c) => {
			const { email } = c.req.valid("json");

			// Always return success to prevent email enumeration
			const [user] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, email))
				.limit(1);

			if (user) {
				await createPasswordResetToken(user.id);
				// In production, would send email here
			}

			return c.json({ success: true });
		},
	)

	// ── Reset Password ───────────────────────────────────────────────────────
	.post("/reset-password", zValidator("json", resetPasswordSchema, invalidBody), async (c) => {
		const { token, password } = c.req.valid("json");
		const success = await resetPassword(token, password);

		if (!success) {
			return c.json({ error: "Invalid or expired reset token" }, 400);
		}

		return c.json({ success: true });
	})

	// ── Change Password (authenticated) ──────────────────────────────────────
	.post(
		"/change-password",
		requireAuth,
		zValidator("json", changePasswordSchema, invalidBody),
		async (c) => {
			const user = c.get("user");
			const { currentPassword, newPassword } = c.req.valid("json");

			// Get full user record with password hash
			const [fullUser] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);

			if (!fullUser?.passwordHash) {
				return c.json({ error: "Cannot change password for ATProto-only accounts" }, 400);
			}

			const valid = await verifyPassword(currentPassword, fullUser.passwordHash);
			if (!valid) {
				return c.json({ error: "Current password is incorrect" }, 401);
			}

			const passwordHash = await hashPassword(newPassword);
			await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

			return c.json({ success: true });
		},
	)

	// ── Devices / Sessions ───────────────────────────────────────────────────
	// The revocation surface that makes long-lived desktop tokens safe to hand out:
	// a stolen laptop is killable without signing every browser out.
	.get("/sessions", requireAuth, async (c) => {
		const user = c.get("user");
		const current = c.get("sessionToken");
		const rows = await listUserSessions(user.id);
		const currentId = await validateSession(current).then((r) => r?.session.id ?? null);
		return c.json({
			sessions: rows.map((s) => ({ ...s, current: s.id === currentId })),
		});
	})

	.delete("/sessions/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id)) return c.json({ error: "Invalid session id" }, 400);

		const revoked = await revokeUserSession(user.id, id);
		if (!revoked) return c.json({ error: "Not found" }, 404);
		return c.json({ success: true });
	})

	// ── Desktop Enrolment ────────────────────────────────────────────────────
	// The desktop Studio never sees a password. It opens the authorize page in the
	// SYSTEM browser, where the creator already holds a cookie session, and one
	// confirm click mints an independently revocable desktop token. PKCE binds the
	// app that started the flow to the app that redeems it. See 42.06 § Desktop auth.

	// Step 1 — the app opens the flow with only a PKCE challenge. Deliberately
	// unauthenticated: no session exists yet and no user is implied.
	.post("/desktop/start", zValidator("json", desktopStartSchema, invalidBody), async (c) => {
		const { challenge, label } = c.req.valid("json");
		await startDesktopAuth(challenge, label ?? null);
		// Opportunistic sweep — these rows are short-lived and low-volume, so this
		// costs less than owning a scheduled job for them.
		void cleanupDesktopAuthRequests().catch(() => {});
		return c.json({ success: true }, 201);
	})

	// Step 2 — the authorize page asks what it is about to approve. Returns only the
	// device label, never anything derived from a session.
	.get("/desktop/pending/:challenge", async (c) => {
		const pending = await getPendingDesktopAuth(c.req.param("challenge"));
		if (!pending) return c.json({ error: "This sign-in request has expired" }, 404);
		return c.json({ label: pending.label, expiresAt: pending.expiresAt });
	})

	// Step 3 — the confirm click, under the browser's normal cookie session. This is
	// what turns "this browser is signed in" into a separate desktop credential.
	.post(
		"/desktop/authorize",
		requireAuth,
		zValidator("json", desktopAuthorizeSchema, invalidBody),
		async (c) => {
			const user = c.get("user");
			const { challenge } = c.req.valid("json");

			const code = await authorizeDesktopAuth(
				challenge,
				user.id,
				c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP") ?? null,
				c.req.header("User-Agent") ?? null,
			);
			if (!code) return c.json({ error: "This sign-in request has expired" }, 404);

			return c.json({ code });
		},
	)

	// Step 4 — the app redeems the code with its verifier and receives the token.
	// Unauthenticated by design: possession of code + verifier IS the proof.
	.post("/desktop/exchange", zValidator("json", desktopExchangeSchema, invalidBody), async (c) => {
		const { code, verifier } = c.req.valid("json");

		const token = await redeemDesktopAuth(code, verifier);
		if (!token) return c.json({ error: "Invalid or expired code" }, 400);

		const result = await validateSession(token);
		if (!result) return c.json({ error: "Invalid or expired code" }, 400);

		// The one place a session token is returned in a body rather than a Set-Cookie:
		// the caller is not a browser and has no cookie jar to put it in.
		return c.json({ token, user: serializeUser(result.user) });
	});

export { authRoutes };

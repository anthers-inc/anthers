// SPDX-License-Identifier: AGPL-3.0-or-later
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { invalidBody } from "../middleware/validate.js";
import { isReservedUsername } from "../reserved-usernames.js";
import {
	createEmailVerificationToken,
	createPasswordResetToken,
	createSession,
	deleteSession,
	hashPassword,
	resetPassword,
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
	.post("/sign-out", async (c) => {
		const token = getCookie(c, "session");
		if (token) {
			await deleteSession(token);
		}
		deleteCookie(c, "session", { path: "/", ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) });
		return c.json({ success: true });
	})

	// ── Current User ─────────────────────────────────────────────────────────
	.get("/me", async (c) => {
		const token = getCookie(c, "session");
		if (!token) {
			return c.json({ user: null });
		}

		const result = await validateSession(token);
		if (!result) {
			deleteCookie(c, "session", {
				path: "/",
				...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
			});
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
	);

export { authRoutes };

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { eq, or } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import {
	hashPassword,
	verifyPassword,
	createSession,
	deleteSession,
	validateSession,
	createEmailVerificationToken,
	verifyEmailToken,
	createPasswordResetToken,
	resetPassword,
} from "../services/auth.js";
import { requireAuth } from "../middleware/auth.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const signUpSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(150)
		.regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, underscores"),
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
		atprotoDid: user.atprotoDid,
		atprotoHandle: user.atprotoHandle,
		createdAt: user.createdAt,
	};
}

function setSessionCookie(c: any, token: string) {
	setCookie(c, "session", token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60, // 30 days
	});
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const authRoutes = new Hono()
	// ── Sign Up ───────────────────────────────────────────────────────────────
	.post("/sign-up", zValidator("json", signUpSchema), async (c) => {
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
		const [user] = await db
			.insert(users)
			.values({ username, email, passwordHash })
			.returning();

		// Create session
		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		// Create email verification token (would send email in production)
		await createEmailVerificationToken(user.id);

		return c.json({ user: serializeUser(user) }, 201);
	})

	// ── Sign In (accepts username or email) ──────────────────────────────────
	.post("/sign-in", zValidator("json", signInSchema), async (c) => {
		const { login, password } = c.req.valid("json");

		// Look up by username or email
		const [user] = await db
			.select()
			.from(users)
			.where(or(eq(users.username, login), eq(users.email, login)))
			.limit(1);

		if (!user || !user.passwordHash) {
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
		deleteCookie(c, "session", { path: "/" });
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
			deleteCookie(c, "session", { path: "/" });
			return c.json({ user: null });
		}

		return c.json({ user: serializeUser(result.user) });
	})

	// ── Email Verification ───────────────────────────────────────────────────
	.post("/verify-email", zValidator("json", verifyEmailSchema), async (c) => {
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
		const [fullUser] = await db
			.select()
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);

		if (fullUser?.emailVerified) {
			return c.json({ error: "Email already verified" }, 400);
		}

		await createEmailVerificationToken(user.id);
		// In production, would send email here
		return c.json({ success: true });
	})

	// ── Request Password Reset ───────────────────────────────────────────────
	.post(
		"/request-password-reset",
		zValidator("json", requestPasswordResetSchema),
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
	.post("/reset-password", zValidator("json", resetPasswordSchema), async (c) => {
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
		zValidator("json", changePasswordSchema),
		async (c) => {
			const user = c.get("user");
			const { currentPassword, newPassword } = c.req.valid("json");

			// Get full user record with password hash
			const [fullUser] = await db
				.select()
				.from(users)
				.where(eq(users.id, user.id))
				.limit(1);

			if (!fullUser?.passwordHash) {
				return c.json(
					{ error: "Cannot change password for ATProto-only accounts" },
					400,
				);
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

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import {
	hashPassword,
	verifyPassword,
	createSession,
	deleteSession,
	validateSession,
} from "../services/auth.js";

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
	username: z.string(),
	password: z.string(),
});

function setSessionCookie(c: any, token: string) {
	setCookie(c, "session", token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60, // 30 days
	});
}

const authRoutes = new Hono()
	.post("/sign-up", zValidator("json", signUpSchema), async (c) => {
		const { username, email, password } = c.req.valid("json");

		// Check for existing user
		const existing = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (existing.length > 0) {
			return c.json({ error: "Username already taken" }, 409);
		}

		const existingEmail = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(1);

		if (existingEmail.length > 0) {
			return c.json({ error: "Email already registered" }, 409);
		}

		// Create user
		const passwordHash = await hashPassword(password);
		const [user] = await db
			.insert(users)
			.values({
				username,
				email,
				passwordHash,
			})
			.returning({
				id: users.id,
				username: users.username,
				email: users.email,
				displayName: users.displayName,
				isCreator: users.isCreator,
			});

		// Create session
		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);

		setSessionCookie(c, token);

		return c.json({ user }, 201);
	})
	.post("/sign-in", zValidator("json", signInSchema), async (c) => {
		const { username, password } = c.req.valid("json");

		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.username, username))
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

		return c.json({
			user: {
				id: user.id,
				username: user.username,
				email: user.email,
				displayName: user.displayName,
				isCreator: user.isCreator,
			},
		});
	})
	.post("/sign-out", async (c) => {
		const token = getCookie(c, "session");
		if (token) {
			await deleteSession(token);
		}
		deleteCookie(c, "session", { path: "/" });
		return c.json({ success: true });
	})
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

		return c.json({
			user: {
				id: result.user.id,
				username: result.user.username,
				email: result.user.email,
				displayName: result.user.displayName,
				isCreator: result.user.isCreator,
			},
		});
	});

export { authRoutes };

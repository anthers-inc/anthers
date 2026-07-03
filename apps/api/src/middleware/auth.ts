// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { validateSession } from "../services/auth.js";

type SessionUser = {
	id: number;
	username: string;
	email: string;
	displayName: string | null;
	isCreator: boolean | null;
	emailVerified: boolean | null;
};

type AuthEnv = {
	Variables: {
		user: SessionUser;
		sessionToken: string;
	};
};

/**
 * Middleware that requires a valid session cookie.
 * Sets c.get("user") and c.get("sessionToken") on success.
 * Returns 401 if no valid session.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
	const token = getCookie(c, "session");

	if (!token) {
		return c.json({ error: "Authentication required" }, 401);
	}

	const result = await validateSession(token);

	if (!result) {
		return c.json({ error: "Invalid or expired session" }, 401);
	}

	c.set("user", {
		id: result.user.id,
		username: result.user.username,
		email: result.user.email,
		displayName: result.user.displayName,
		isCreator: result.user.isCreator,
		emailVerified: result.user.emailVerified,
	});
	c.set("sessionToken", token);

	await next();
});

/**
 * Middleware that requires the authenticated user to have a verified email.
 * Must be used AFTER requireAuth. Gates money-spending and creator activation.
 * Returns 403 with { code: "email_unverified" } so the frontend can prompt.
 */
export const requireVerified = createMiddleware<AuthEnv>(async (c, next) => {
	const user = c.get("user");
	if (!user?.emailVerified) {
		return c.json(
			{ error: "Please verify your email address to continue.", code: "email_unverified" },
			403,
		);
	}
	await next();
});

/**
 * Middleware that requires the authenticated user to be a creator.
 * Must be used AFTER requireAuth.
 */
export const requireCreator = createMiddleware<AuthEnv>(async (c, next) => {
	const user = c.get("user");
	if (!user?.isCreator) {
		return c.json({ error: "Creator account required" }, 403);
	}
	await next();
});

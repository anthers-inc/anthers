import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { validateSession } from "../services/auth.js";

type SessionUser = {
	id: number;
	username: string;
	email: string;
	displayName: string | null;
	isCreator: boolean | null;
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
	});
	c.set("sessionToken", token);

	await next();
});

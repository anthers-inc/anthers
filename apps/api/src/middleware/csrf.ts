import { createMiddleware } from "hono/factory";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection via Origin header checking.
 * Only checks mutating requests (POST, PUT, PATCH, DELETE).
 * Combined with SameSite=Lax cookies, this prevents CSRF attacks.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) {
		return next();
	}

	const origin = c.req.header("Origin");
	const allowedOrigin = process.env.FRONTEND_URL ?? "http://localhost:3000";

	if (!origin || origin !== allowedOrigin) {
		return c.json({ error: "CSRF validation failed" }, 403);
	}

	await next();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { createMiddleware } from "hono/factory";
import { allowedOrigins } from "../origins.js";

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

	if (!origin || !allowedOrigins().includes(origin)) {
		return c.json({ error: "CSRF validation failed" }, 403);
	}

	await next();
});

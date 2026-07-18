// SPDX-License-Identifier: AGPL-3.0-or-later
import { createMiddleware } from "hono/factory";
import { allowedOrigins } from "../origins.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Server-to-server webhooks authenticate by request signature, not Origin/cookies,
 * and legitimately arrive with no Origin header — so the Origin check would reject
 * them. Exempt them here; each such route verifies its own signature instead.
 */
const CSRF_EXEMPT_PATHS = new Set(["/api/payments/stripe/webhook"]);

/**
 * CSRF protection via Origin header checking.
 * Only checks mutating requests (POST, PUT, PATCH, DELETE).
 * Combined with SameSite=Lax cookies, this prevents CSRF attacks.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) {
		return next();
	}

	if (CSRF_EXEMPT_PATHS.has(c.req.path)) {
		return next();
	}

	const origin = c.req.header("Origin");

	if (!origin || !allowedOrigins().includes(origin)) {
		return c.json({ error: "CSRF validation failed" }, 403);
	}

	await next();
});

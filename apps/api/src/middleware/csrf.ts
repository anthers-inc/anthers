// SPDX-License-Identifier: AGPL-3.0-or-later
import { createMiddleware } from "hono/factory";
import { allowedOrigins } from "../origins.js";
import { bearerToken, resolveBearerSession } from "./bearer.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requests that authenticate by their own means rather than Origin/cookies, and
 * legitimately arrive with no Origin header — so the Origin check would reject them.
 * Each route below verifies its own proof instead.
 *
 * - The Stripe webhook authenticates by request signature.
 * - The Resend delivery webhook does the same, by Standard Webhooks HMAC over the raw
 *   body (`lib/standard-webhooks.ts`). 🚨 It fails CLOSED without its secret, so the
 *   exemption removes the Origin check and puts nothing in its place that could be
 *   absent: an unsigned request is rejected by the handler's first act rather than
 *   waved through.
 * - The two desktop-enrollment endpoints are called by the packaged app itself, which
 *   has no allowed Origin (`tauri://localhost`) and no session yet — obtaining one is
 *   the entire point of the exchange. Neither is CSRF-forgeable to any effect:
 *   `/start` only records a pending challenge the caller invented and touches no user
 *   state, and `/exchange` demands a code AND the PKCE verifier, possession of which
 *   IS the proof. `/desktop/authorize` is deliberately NOT exempt — that one runs
 *   under the browser's cookie session and needs the check.
 */
const CSRF_EXEMPT_PATHS = new Set([
	"/api/payments/stripe/webhook",
	"/api/webhooks/resend",
	"/api/auth/desktop/start",
	"/api/auth/desktop/exchange",
]);

/**
 * CSRF protection via Origin header checking.
 * Only checks mutating requests (POST, PUT, PATCH, DELETE).
 * Combined with SameSite=Lax cookies, this prevents CSRF attacks.
 *
 * Bearer-authenticated requests (the desktop Studio) skip the Origin check — see
 * `middleware/bearer.ts` for why that is principled rather than a hole. The skip keys
 * off a token that actually VALIDATES, never off the mere presence of a header the
 * caller controls.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) {
		return next();
	}

	if (CSRF_EXEMPT_PATHS.has(c.req.path)) {
		return next();
	}

	// A presented bearer token IS the request's credential, so resolve it before the
	// Origin check rather than after.
	if (bearerToken(c)) {
		if (await resolveBearerSession(c)) {
			return next();
		}
		// Presenting a dead credential is an auth failure, not a CSRF failure. Saying
		// so here matters: the desktop app sends no Origin, so the generic 403 below
		// would send an expired-token client chasing the wrong bug.
		return c.json({ error: "Invalid or expired session" }, 401);
	}

	const origin = c.req.header("Origin");

	if (!origin || !allowedOrigins().includes(origin)) {
		return c.json({ error: "CSRF validation failed" }, 403);
	}

	await next();
});

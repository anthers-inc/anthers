// SPDX-License-Identifier: Apache-2.0
/**
 * The two gates in front of every admin route: the admin host, then an admin session.
 *
 * 🚨 **Neither reads anything the main site's auth reads.** Not the `session` cookie, which a
 * browser sends to `admin.anthers.org` because it is scoped to `.anthers.org`, and not a bearer
 * token, which is how the desktop Studio signs in. Every way into an Anthers account is a way that
 * must not open the admin app, and the reliable way to hold that is for these gates to have no
 * code path that looks at either.
 */
import { createMiddleware } from "hono/factory";
import { isAdminHost, isAdminOrigin } from "../lib/admin-host.js";
import { readAdminSessionCookie } from "../lib/cookies.js";
import { type AdminAccount, validateAdminSession } from "../services/admin-accounts.js";
import { bearerToken } from "./bearer.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Answer 404 off the admin host, refuse a bearer credential, and require the admin origin on
 * anything that changes state.
 *
 * The site-wide `csrfProtection` skips the admin paths, because it admits the site and the desktop
 * Studio and this check must admit neither. So this middleware is the CSRF check for every route
 * it sits in front of, and a route under `/api/admin` that is mounted without it has none.
 */
export const adminHostOnly = createMiddleware(async (c, next) => {
	if (!isAdminHost(new URL(c.req.url).host)) {
		return c.json({ error: "Not found" }, 404);
	}
	if (bearerToken(c)) {
		return c.json({ error: "Not found" }, 404);
	}
	if (!SAFE_METHODS.has(c.req.method) && !isAdminOrigin(c.req.header("Origin"))) {
		return c.json({ error: "CSRF validation failed" }, 403);
	}
	await next();
});

export type AdminEnv = {
	Variables: {
		admin: AdminAccount;
		adminSessionToken: string;
	};
};

/**
 * Require a live admin session. Must be used after `adminHostOnly`.
 *
 * A 401 rather than the 404 the rest of the world gets, because by this point the request is
 * already on the admin host, where the app needs to tell "signed out" apart from "no such thing"
 * in order to show its sign-in page.
 */
export const requireAdminSession = createMiddleware<AdminEnv>(async (c, next) => {
	const token = readAdminSessionCookie(c);
	if (!token) return c.json({ error: "Authentication required" }, 401);

	const account = await validateAdminSession(token);
	if (!account) return c.json({ error: "Invalid or expired session" }, 401);

	c.set("admin", account);
	c.set("adminSessionToken", token);
	await next();
});

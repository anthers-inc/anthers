// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one place the session cookie is written.
 *
 * 🚨 It lives here because there were two copies and they disagreed. `routes/atproto.ts`
 * carried its own, without `COOKIE_DOMAIN` — so signing in through Bluesky set a host-only
 * cookie at the apex and did not carry to `www.anthers.org`, which is precisely the
 * failure `COOKIE_DOMAIN` exists to prevent and which `.do/app.yaml` warns about at
 * length. A cookie helper duplicated per route is a cookie policy per route.
 */
import { setCookie } from "hono/cookie";

// Scope the session cookie to the parent domain (e.g. ".anthers.org") in prod so it's
// shared with `www`. Unset in dev (host-only cookie on localhost). Subdomains are
// same-site, so SameSite=Lax still sends it.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

export function setSessionCookie(c: any, token: string): void {
	setCookie(c, "session", token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_COOKIE_MAX_AGE,
		...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
	});
}

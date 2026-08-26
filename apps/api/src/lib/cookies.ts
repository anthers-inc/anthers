// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one place a browser cookie's security attributes are decided.
 *
 * 🚨 It exists because there were two copies of the session cookie and they disagreed.
 * `routes/atproto.ts` carried its own, without `COOKIE_DOMAIN` — so signing in through
 * Bluesky set a host-only cookie at the apex and did not carry to `www.anthers.org`, which is
 * precisely the failure `COOKIE_DOMAIN` exists to prevent and which `.do/app.yaml` warns
 * about at length. A cookie helper duplicated per route is a cookie policy per route.
 *
 * 🚨 **That is exactly what happened again, and it is why this module now owns the attributes
 * rather than one named cookie.** `secure` was `process.env.NODE_ENV === "production"` in two
 * places — here and in the ATProto pending-signup cookie added on 2026-08-22 — and `NODE_ENV`
 * is set nowhere in this app, so both shipped without `Secure` in production. Each caller now
 * supplies only what is genuinely its own (the name, the value and the lifetime) and the
 * security attributes are decided once, here. See `lib/deployment.ts` for why the decision is
 * `isPublicDeployment()` and not a `NODE_ENV` label.
 */
import { deleteCookie, setCookie } from "hono/cookie";
import { isPublicDeployment } from "./deployment.js";

// Scope cookies to the parent domain (e.g. ".anthers.org") in prod so they're shared with
// `www`. Unset in dev (host-only cookie on localhost). Subdomains are same-site, so
// SameSite=Lax still sends them.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * Write a first-party cookie with the attributes every cookie this app sets should carry.
 *
 * `SameSite=Lax` rather than `Strict` because at least one of these — the ATProto pending
 * signup — has to survive the redirect back from an authorization server on another origin,
 * and a session cookie that vanished on any inbound link would be worse than useless.
 */
export function setSecureCookie(c: any, name: string, value: string, maxAge: number): void {
	setCookie(c, name, value, {
		httpOnly: true,
		secure: isPublicDeployment(),
		sameSite: "Lax",
		path: "/",
		maxAge,
		...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
	});
}

export function setSessionCookie(c: any, token: string): void {
	setSecureCookie(c, "session", token, SESSION_COOKIE_MAX_AGE);
}

/**
 * The cookie that binds an unfinished signup to this browser.
 *
 * ⚠️ **It was `atproto_pending` until 2026-08-26**, when the parked ATProto identity
 * generalized into a pending account both signup doors write. The name is here rather than
 * at its two call sites — `routes/auth.ts` sets and clears it, `routes/atproto.ts` reads and
 * rebinds it — because a cookie whose name is spelled in two files is a cookie one of them
 * will eventually stop clearing.
 */
export const PENDING_SIGNUP_COOKIE = "signup_pending";

/** The pending signup's own lifetime, in seconds. Mirrors `PENDING_SIGNUP_TTL_MS`. */
export const PENDING_SIGNUP_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

export function setPendingSignupCookie(c: any, token: string): void {
	setSecureCookie(c, PENDING_SIGNUP_COOKIE, token, PENDING_SIGNUP_COOKIE_MAX_AGE);
}

/**
 * Clear it — and note the guard, which is not decoration.
 *
 * 🚨 **An unconditional clear gave every signup a second `Set-Cookie` header** and broke a
 * client that read the header and took the first cookie; the ceremony test does exactly
 * that, and so might anything else. A route that has always answered with one cookie must
 * keep doing so on the path that has not changed, so callers pass the token they actually
 * found rather than clearing on the way past.
 */
export function clearPendingSignupCookie(c: any): void {
	deleteCookie(c, PENDING_SIGNUP_COOKIE, {
		path: "/",
		...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
	});
}

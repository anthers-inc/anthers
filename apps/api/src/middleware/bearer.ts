// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bearer-token session transport, shared by the CSRF and auth middlewares.
 *
 * The desktop Studio cannot use the session cookie: a packaged Tauri window serves
 * from `tauri://localhost`, which is cross-site to `.anthers.org`, so a `SameSite=Lax`
 * cookie is never sent. It presents the same session as an `Authorization: Bearer`
 * header instead. This introduces NO new auth primitive — a session is already an
 * opaque 64-hex row in `sessions` with an expiry, which is exactly what a bearer token
 * is, and `validateSession()` doesn't care how it arrived.
 *
 * Why the two middlewares must agree. `csrfProtection` is global and runs BEFORE any
 * route, so it cannot ask whether `requireAuth` later succeeded — it has to decide for
 * itself whether the request is header-authenticated. So both sides follow one rule:
 *
 *   An `Authorization: Bearer` header, when present, IS the request's credential —
 *   the cookie is not consulted, and there is no silent fallback to it.
 *
 * That makes "valid bearer ⇒ header-authenticated" true by construction, which is the
 * invariant the CSRF skip depends on. Skipping CSRF for header auth is principled
 * rather than a hole: CSRF exists because browsers attach cookies implicitly, and
 * nothing attaches an `Authorization` header on your behalf. A cross-site attacker
 * cannot add one without triggering a preflight, which `allowedOrigins()` refuses.
 */
import type { Context } from "hono";
import { validateSession } from "../services/auth.js";

/** Context key holding the memoized bearer lookup (`undefined` = not yet resolved). */
const BEARER_KEY = "bearerSession";

type BearerResult = Awaited<ReturnType<typeof validateSession>>;

/** The raw token from an `Authorization: Bearer <token>` header, if well-formed. */
export function bearerToken(c: Context): string | null {
	const header = c.req.header("Authorization");
	if (!header) return null;
	const [scheme, ...rest] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer") return null;
	const token = rest.join(" ").trim();
	return token.length > 0 ? token : null;
}

/**
 * Validate the request's bearer token, memoized on the context so the CSRF check and
 * `requireAuth` share one database lookup rather than each paying for their own.
 *
 * Returns null when there is no bearer header AND when there is one that doesn't
 * validate; call `bearerToken()` alongside it to tell those two apart.
 */
export async function resolveBearerSession(c: Context): Promise<BearerResult> {
	// biome-ignore lint/suspicious/noExplicitAny: untyped context bag, shared by two middlewares
	const cached = (c as any).get(BEARER_KEY) as BearerResult | undefined;
	if (cached !== undefined) return cached;

	const token = bearerToken(c);
	const result = token ? await validateSession(token) : null;
	// biome-ignore lint/suspicious/noExplicitAny: untyped context bag, shared by two middlewares
	(c as any).set(BEARER_KEY, result);
	return result;
}

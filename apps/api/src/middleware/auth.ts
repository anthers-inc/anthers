// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { touchSession, validateSession } from "../services/auth.js";
import { bearerToken, resolveBearerSession } from "./bearer.js";

type SessionUser = {
	id: number;
	/** The account's ATProto handle, and its public address. Always present. */
	handle: string;
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
 * Middleware that requires a valid session.
 *
 * The session arrives either as the browser's `session` cookie or, for the packaged
 * desktop Studio, as an `Authorization: Bearer` header. A presented bearer header IS
 * the request's credential — the cookie is not consulted and there is no fallback to
 * it — which is what lets `csrfProtection` decide the same question independently.
 * See `middleware/bearer.ts`.
 *
 * Sets c.get("user") and c.get("sessionToken") on success.
 * Returns 401 if no valid session.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
	const presentedBearer = bearerToken(c);
	const token = presentedBearer ?? getCookie(c, "session");

	if (!token) {
		return c.json({ error: "Authentication required" }, 401);
	}

	// On a mutating request the CSRF middleware has already resolved this token;
	// resolveBearerSession memoizes, so this reuses that lookup rather than repeating it.
	const result = presentedBearer ? await resolveBearerSession(c) : await validateSession(token);

	if (!result) {
		return c.json({ error: "Invalid or expired session" }, 401);
	}

	// Fire-and-forget: the Devices list wants a "last used" reading, but no user-facing
	// request should wait on (or fail because of) that bookkeeping write.
	void touchSession(result.session).catch(() => {});

	c.set("user", {
		id: result.user.id,
		handle: result.user.atprotoHandle,
		email: result.user.email,
		displayName: result.user.displayName,
		isCreator: result.user.isCreator,
		emailVerified: result.user.emailVerified,
	});
	c.set("sessionToken", token);

	await next();
});

/**
 * Who is calling, or null — for routes that serve a signed-out caller and serve a
 * signed-in one slightly differently.
 *
 * Not middleware, because there is nothing to gate: it answers a question rather than
 * refusing a request. It lives here anyway so that "how do we read an optional session?"
 * has one answer beside `requireAuth`'s. Two identical private copies had grown in
 * `routes/accounts.ts` and `routes/content.ts` before this existed.
 *
 * 🚨 **It reads the cookie AND the bearer header, because `requireAuth` does.** This
 * consulted only the cookie until 2026-08-28, so the packaged desktop Studio — which
 * cannot send the cookie at all, and presents its session as `Authorization: Bearer` for
 * exactly that reason — resolved as a signed-out visitor at every route that asks the
 * question rather than requiring an answer. That was survivable only while signing out
 * meant *more* access than signing in; the moment delivery requires an account, a
 * disagreement between the two readers becomes a bearer-authenticated request being told
 * to log in. Two ways to read one session must not answer differently.
 *
 * The `c.get("user")` check first is not an optimization for its own sake: on a route that
 * already ran `requireAuth`, re-validating would be a second database round trip **and** a
 * second chance to disagree with the middleware that just decided.
 */
export async function getOptionalUserId(c: Context): Promise<number | null> {
	const authenticated = (c as Context<AuthEnv>).get("user");
	if (authenticated?.id != null) return authenticated.id;

	// A presented bearer header IS the request's credential — the cookie is not consulted
	// and there is no fallback to it. Same rule as `requireAuth` and `csrfProtection`; see
	// `middleware/bearer.ts` for why all three have to agree.
	if (bearerToken(c)) {
		const result = await resolveBearerSession(c);
		return result?.user.id ?? null;
	}

	const token = getCookie(c, "session");
	if (!token) return null;
	const result = await validateSession(token);
	return result?.user.id ?? null;
}

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
 *
 * Posting is creator-only as a matter of what Anthers is rather than as a default: creators
 * post and everyone else reacts (Parker, 2026-09-12). It is also what keeps a reader from
 * writing an `org.anthers.post` record under the creator permission set.
 */
export const requireCreator = createMiddleware<AuthEnv>(async (c, next) => {
	const user = c.get("user");
	if (!user?.isCreator) {
		return c.json(
			{
				error: "Posting is for creators. Turn on creator mode in your account settings first.",
				code: "creator_required",
			},
			403,
		);
	}
	await next();
});

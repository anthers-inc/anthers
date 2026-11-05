// SPDX-License-Identifier: Apache-2.0
/**
 * The content surface's request-door helpers: reading a numeric route id, and the one
 * middleware that admits a session or a live share link for a Work.
 *
 * They live below the route modules because those modules hand the middleware to Hono while
 * they are being defined — a value a route module reads at registration time cannot live in a
 * module that imports the route modules in turn. The docblock on the middleware is the
 * original one, moved with its code from `routes/content.ts` on 2026-10-28.
 */
import { createMiddleware } from "hono/factory";
import { verifyMediaToken } from "../../lib/web-build.js";
import { requireAuth, setSessionUser } from "../../middleware/auth.js";
import { activeUserById } from "../../services/auth.js";
import { resolveShareToken } from "../../services/share-links.js";

/** A positive integer from a route param, or null — the shape every content id shares. */
export function parseNumericId(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Middleware for a delivery endpoint: a session, a media token, **or** a live share link
 * for this Work.
 *
 * 🚨 **The media token is the shell's `<video>` and `<audio>` credential, and it is
 * deliberately narrow.** A packaged webview serves from `tauri.localhost`, so the session
 * cookie is never sent and a media element cannot attach the bearer header every other
 * request carries. The Work payload a bearer-authenticated request receives therefore
 * names a signed, expiring token on its media URLs; this door verifies it, resolves the
 * account it names, and then runs exactly the same `workAccessFor` ladder a session does.
 * A token names one Work and is accepted only on a GET, so it cannot be replayed as a
 * session, against another Work, or on a mutating delivery route.
 *
 * 🚨 **The share-link exception is narrow by construction, and this is the only door it
 * opens.** A request that presents neither is refused here, before any work is done. A
 * request that presents a token is let *through the door* and then meets
 * `resolveAccessSync` exactly like everybody else, where a null user carrying `sharedBy`
 * can emerge only from the branch reached by universally-free work. So this middleware
 * decides *whether we will talk to you*; it decides nothing about what you may have.
 *
 * ⚠️ **The token must name the Work in the path.** Without that, a token minted for one free
 * Work would be a skeleton key to every delivery route on the platform — the recipient would
 * still be refused gated and Adult work by the resolver, but they would be drawing the
 * sharer's budget across a catalog the sharer never shared.
 */
export const requireUserOrShareLink = createMiddleware(async (c, next) => {
	const workId = parseNumericId(c.req.param("id") ?? "");
	if (workId != null) {
		const media = c.req.method === "GET" ? c.req.query("media") : undefined;
		if (media) {
			const payload = verifyMediaToken(media);
			if (payload && payload.w === workId && typeof payload.u === "number") {
				const user = await activeUserById(payload.u);
				if (user) {
					setSessionUser(c, user, `media:${workId}`);
					return next();
				}
			}
		}
		const token = c.req.query("share");
		if (token) {
			const link = await resolveShareToken(token);
			if (link && link.workId === workId) return next();
		}
	}
	return requireAuth(c, next);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The browser's half of share links — reading the token off the URL, and keeping it there.
 *
 * 🚨 **The token lives in the query string and nowhere else.** Not in `localStorage`, not in
 * a cookie, not in a context that outlives the page. A share link is a locator: it says which
 * Work somebody was pointed at, and it stops meaning anything the moment they navigate away.
 * Storing it would turn "you followed a link to this Work" into "you are browsing as somebody
 * else's guest", which is a session, and a session is the thing a share link deliberately is
 * not.
 *
 * ⚠️ **Which is why the canonical-URL rewrite has to preserve it.** `WorkPage` settles a bare
 * `/works/{slug}` onto `/works/{slug}-{publicId}`, and a rewrite that dropped the query would
 * take the recipient's only claim to the Work with it — the page would load, the player would
 * 401, and nothing would say why.
 */

import { useLocation } from "@anthers/web-shared/router";

/** The share token on the current URL, or null. */
export function useShareToken(): string | null {
	const location = useLocation();
	return shareTokenOf(location.search);
}

/** The share token in a query string, or null. Pure, so it can be read outside a component. */
export function shareTokenOf(search: string): string | null {
	const token = new URLSearchParams(search).get("share");
	// A token is 32 hex characters; anything else is somebody's stray parameter and must not
	// be forwarded to the API as though it were one.
	return token && /^[0-9a-f]{8,64}$/.test(token) ? token : null;
}

/** `?share=…` appended to a path, when there is a token to carry. */
export function withShareToken(path: string, token: string | null): string {
	if (!token) return path;
	const [base, query = ""] = path.split("?");
	const params = new URLSearchParams(query);
	params.set("share", token);
	return `${base}?${params.toString()}`;
}

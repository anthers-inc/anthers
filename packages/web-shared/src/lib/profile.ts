// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Profile URLs — the ONE place the `@` in `/@username` is written.
 *
 * A person is `/@name` and everything else on the site is `/name`, which is what keeps a
 * creator and a marketing page out of each other's way. The two shared one namespace until
 * 2026-09-03, and the router settled every collision in the page's favor: a creator holding
 * "about" had a profile nothing could reach, so `reserved-usernames.ts` had to hold back every
 * root path the site served and stay in step with `App.tsx` by hand.
 *
 * 🚨 **React Router cannot match a partial path segment, so the `@` is part of the VALUE and
 * never part of the pattern.** `compilePath` only recognizes `:param` where the colon
 * immediately follows a slash (`/\/:([\w-]+)(\?)?/g`), so `path="/@:username"` is not a
 * dynamic segment at all — it compiles to a literal `^/@:username` regexp, matches no real
 * URL, and reports nothing. The route stays `/:handle` and `usernameFromHandleParam` below is
 * what turns a matched segment into a username, or refuses it.
 *
 * ⭐ **The refusal is the point.** A `/:handle` catch-all still matches every unclaimed root
 * path, and a profile lookup renders a *real page* rather than erroring — which is how the
 * Studio's nav, Connect's `return_url` and four retired `/demo-*` cards each pointed somewhere
 * wrong for weeks without a single failure anywhere. A segment with no `@` is not a person, so
 * it gets a 404 instead of a lookup.
 *
 * `scripts/profile-url-guard.test.ts` scans for a profile path built anywhere but here.
 */

/** The character that marks a root path as a person rather than a page. */
export const HANDLE_PREFIX = "@";

/** A creator's profile: `/@username`. */
export function profileUrl(username: string): string {
	return `/${HANDLE_PREFIX}${username}`;
}

/** A project on a creator's site: `/@username/{slug}`. */
export function creatorProjectUrl(username: string, slug: string): string {
	return `${profileUrl(username)}/${slug}`;
}

/** A post on a creator's site: `/@username/posts/{slug}`. */
export function creatorPostUrl(username: string, slug: string | number): string {
	return `${profileUrl(username)}/posts/${slug}`;
}

/** A Work on a creator's site: `/@username/works/{slug}`. */
export function creatorWorkUrl(username: string, slug: string): string {
	return `${profileUrl(username)}/works/${slug}`;
}

/**
 * How a handle is written where it is read rather than followed — a byline, a menu, an
 * error message. Same `@`, so the printed name and the URL cannot drift apart.
 */
export function displayHandle(username: string): string {
	return `${HANDLE_PREFIX}${username}`;
}

/**
 * The username a `:handle` route param names, or `null` when the segment is not a handle.
 *
 * `null` is the answer for an unclaimed root path (`/nonsense`), for a bare `@`, and for a
 * missing param — three ways of not naming a person, all of which end at the same 404. The
 * username charset is `[a-zA-Z0-9_-]+`, so a handle can never contain a second `@` and this
 * needs no decoding.
 */
export function usernameFromHandleParam(param: string | undefined): string | null {
	if (!param?.startsWith(HANDLE_PREFIX)) return null;
	const username = param.slice(HANDLE_PREFIX.length);
	return username.length > 0 ? username : null;
}

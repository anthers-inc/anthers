// SPDX-License-Identifier: Apache-2.0
/**
 * Profile URLs — the ONE place the `@` in `/@handle` is written.
 *
 * A person is `/@<their atproto handle>` — there is no separate username anymore; the
 * account's address IS its ATProto handle. Everything else on the site is `/name`, and the
 * `@` prefix is what keeps a creator and a marketing page out of each other's way. That
 * structural guard replaced the old reserved-names list (`reserved-usernames.ts`), which
 * had to hold back every root path the site served and stay in step with `App.tsx` by hand.
 *
 * 🚨 **React Router cannot match a partial path segment, so the `@` is part of the VALUE and
 * never part of the pattern.** `compilePath` only recognizes `:param` where the colon
 * immediately follows a slash (`/\/:([\w-]+)(\?)?/g`), so `path="/@:handle"` is not a
 * dynamic segment at all — it compiles to a literal `^/@:handle` regexp, matches no real
 * URL, and reports nothing. The route stays `/:handle` and `handleFromParam` below is
 * what turns a matched segment into a handle, or refuses it.
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

/** A creator's profile: `/@handle`. */
export function profileUrl(handle: string): string {
	return `/${HANDLE_PREFIX}${handle}`;
}

/** A project on a creator's site: `/@handle/{slug}`. */
export function creatorProjectUrl(handle: string, slug: string): string {
	return `${profileUrl(handle)}/${slug}`;
}

/** A post on a creator's site: `/@handle/posts/{slug}`. */
export function creatorPostUrl(handle: string, slug: string | number): string {
	return `${profileUrl(handle)}/posts/${slug}`;
}

/** A Work on a creator's site: `/@handle/works/{slug}`. */
export function creatorWorkUrl(handle: string, slug: string): string {
	return `${profileUrl(handle)}/works/${slug}`;
}

/**
 * How a handle is written where it is read rather than followed — a byline, a menu, an
 * error message. Same `@`, so the printed name and the URL cannot drift apart.
 */
export function displayHandle(handle: string): string {
	return `${HANDLE_PREFIX}${handle}`;
}

/**
 * The handle a `:handle` route param names, or `null` when the segment is not a handle.
 *
 * `null` is the answer for an unclaimed root path (`/nonsense`), for a bare `@`, and for a
 * missing param — three ways of not naming a person, all of which end at the same 404. The
 * handle charset is `[a-zA-Z0-9_.-]+`, so a handle can never contain a second `@` and this
 * needs no decoding.
 */
export function handleFromParam(param: string | undefined): string | null {
	if (!param?.startsWith(HANDLE_PREFIX)) return null;
	const handle = param.slice(HANDLE_PREFIX.length);
	return handle.length > 0 ? handle : null;
}

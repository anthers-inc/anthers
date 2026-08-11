// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Paths into the Creator Studio.
 *
 * These returned absolute URLs at `studio.anthers.org` until 2026-08-11, because the Studio
 * was a separate origin and every entry point had to be a full-page cross-origin link. The
 * Studio is a section of this app now, so they are in-app paths and the whole
 * origin-sniffing branch (localhost:3001, `studio.<apex>`, stripping `www.`) is gone.
 *
 * They stay as helpers rather than being inlined so that the `/studio` prefix lives in one
 * place — and because the call sites still use them as `href`, which is correct but does a
 * full document load. Converting those to `<Link>` is a worthwhile follow-up and is not a
 * regression today: they were cross-origin navigations before, so same-origin is strictly
 * faster.
 */

/** The Studio's root path. */
export function studioOrigin(): string {
	return "/studio";
}

/** Path to the Studio's "new post" authoring page. */
export function studioNewPostUrl(): string {
	return "/studio/posts/new";
}

/** Path to the Studio's edit page for a given post slug. */
export function studioEditPostUrl(slug: string): string {
	return `/studio/posts/${slug}/edit`;
}

/** Path to a location within the Studio (e.g. "/", "/analytics", "/settings"). */
export function studioUrl(path = "/"): string {
	return path === "/" ? "/studio" : `/studio${path}`;
}

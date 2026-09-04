// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Paths into the Creator Studio — the ONE place the `/studio` prefix is written.
 *
 * 🚨 **The Studio's pages live in this package while its ROUTES are mounted by the consuming
 * app, so a page here cannot see where it was mounted.** That split is what made every
 * in-Studio link rot silently when the Studio stopped being its own app at
 * `studio.anthers.org`: the shell's nav was re-prefixed and the pages went on linking to
 * root-absolute paths like `/projects/new` and `/analytics`, which is a whole navigation
 * pointing outside the Studio with nothing anywhere reporting it.
 *
 * ⚠️ **A wrong in-app link need not 404, which is what makes this worth centralizing.**
 * `/settings`, `/library` and `/@somebody` are all real destinations a stale Studio path can
 * reach, and each renders a page rather than an error. So the prefix belongs in one exported
 * function rather than in ~10 string literals, and `apps/web/src/lib/studio.ts` re-exports
 * this module instead of keeping its own copy: a duplicated constant agrees with its original
 * right up until one of them moves.
 */

/** The Studio's root path. */
export const STUDIO_ROOT = "/studio";

/** Path to a location within the Studio (e.g. "/", "/analytics", "/settings"). */
export function studioUrl(path = "/"): string {
	return path === "/" ? STUDIO_ROOT : `${STUDIO_ROOT}${path}`;
}

/** The Studio's root path. Kept as a function for the call sites that read it as one. */
export function studioOrigin(): string {
	return STUDIO_ROOT;
}

/** Path to the Studio's "new post" authoring page. */
export function studioNewPostUrl(): string {
	return studioUrl("/posts/new");
}

/** Path to the Studio's edit page for a given post slug. */
export function studioEditPostUrl(slug: string): string {
	return studioUrl(`/posts/${slug}/edit`);
}

/** Path to the Studio's "new project" page. */
export function studioNewProjectUrl(): string {
	return studioUrl("/projects/new");
}

/** Path to the Studio's edit page for a given project slug. */
export function studioEditProjectUrl(slug: string): string {
	return studioUrl(`/projects/${slug}/edit`);
}

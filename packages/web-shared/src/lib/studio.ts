// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Paths into the Creator Studio — the ONE place the `/studio` prefix is written.
 *
 * 🚨 The Studio's pages live in this package while its ROUTES are mounted by the consuming
 * app, and that split is what made every in-Studio link rot silently on 2026-08-11. Until
 * then the Studio was its own app at `studio.anthers.org`, where the Dashboard was `/` and
 * the project form was `/projects/new`; the merge into `apps/web` moved every one of those
 * under `/studio` and re-prefixed the shell's nav — but the pages still linked to the old
 * root-absolute paths. Nothing 404'd, because `apps/web` has `/:username` and
 * `/:username/:slug` catch-alls that happily matched them: **"New Project" resolved to the
 * public project page for a creator named "projects" and rendered "Project not found"**,
 * and Import/Analytics/Settings each rendered a stranger's profile.
 *
 * That is the failure mode to design against here — a broken in-app link does not error, it
 * renders a *different real page*. So the prefix belongs in one exported function rather
 * than in ~10 string literals, and `apps/web/src/lib/studio.ts` re-exports this module
 * instead of keeping its own copy: a duplicated constant agrees with its original right up
 * until one of them moves.
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

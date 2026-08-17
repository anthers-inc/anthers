// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Paths into the Creator Studio.
 *
 * These returned absolute URLs at `studio.anthers.org` until 2026-08-11, because the Studio
 * was a separate origin and every entry point had to be a full-page cross-origin link. The
 * Studio is a section of this app now, so they are in-app paths and the whole
 * origin-sniffing branch (localhost:3001, `studio.<apex>`, stripping `www.`) is gone.
 *
 * 🚨 The definitions moved to `@anthers/web-shared/studio` on 2026-08-17 and this file is a
 * re-export, not a second copy. The Studio's PAGES live in that package and link to each
 * other; its ROUTES are mounted here. A prefix defined on this side of that boundary is one
 * the pages cannot reach, which is exactly how they spent six days linking to the pre-merge
 * root paths — see the header there for what that rendered instead.
 *
 * Some call sites still use these as `href`, which is correct but does a full document load.
 * Converting those to `<Link>` is a worthwhile follow-up and is not a regression today: they
 * were cross-origin navigations before, so same-origin is strictly faster.
 */

export {
	STUDIO_ROOT,
	studioEditPostUrl,
	studioEditProjectUrl,
	studioNewPostUrl,
	studioNewProjectUrl,
	studioOrigin,
	studioUrl,
} from "@anthers/web-shared/studio";

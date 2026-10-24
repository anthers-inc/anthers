// SPDX-License-Identifier: Apache-2.0
/**
 * What a crawler is told: the robots policy, and the pages worth indexing.
 *
 * The web origin answers every path with the application shell, so before this existed a
 * request for `/robots.txt` was told that the whole site is one page, and a request for
 * `/sitemap.xml` was handed the shell as HTML. Both are ordinary documents and are served
 * as such here, ahead of the shell fallback.
 *
 * ⚠️ **The sitemap lists the standing pages, not the catalog.** A Works, posts or profiles
 * sitemap needs a paginated public listing of each — `GET /open-works` is a twelve-item strip
 * for the homepage, not an index — and a listing that skipped the Adult allow-list would
 * publish the existence its rung withholds. Crawlers reach the catalog the ordinary way, by
 * following the links a person follows, and that is the right default until somebody decides
 * a catalog sitemap is worth its own read.
 *
 * The two documents are built from `page-meta.ts` rather than from a second list, so a page
 * that gains a card gains its sitemap entry, and a path that is a door stays out of both.
 */

import { indexablePaths } from "./page-meta.js";

/** The sitemap's address, named by the policy so the two cannot drift apart. */
export const SITEMAP_PATH = "/sitemap.xml";

/**
 * The robots policy.
 *
 * Everything public is allowed by default and the app's own surfaces are named, because a
 * policy written as a deny-list of what a crawler should skip is shorter and more stable than
 * an allow-list of what it may have. The two exceptions worth stating rather than leaving to
 * the default are the share link and the embed: both are locators for a Work rather than pages
 * of their own, and an indexed `/s/{token}` would put an address carrying no meaning into
 * search results.
 *
 * `/discovery` is deliberately absent from the list even though the page there is signed-in:
 * `robots.txt` matches by prefix, and `/discovery/{slug}` is a public project redirect that
 * shares it. What a crawler reaches at the bare path is a login prompt, which costs nothing.
 */
export function robotsTxt(siteOrigin: string): string {
	return `# Anthers answers every route with the same application shell, so a crawler that runs
# no JavaScript sees the shell. The pages with their own words are in the sitemap.
User-agent: *
Allow: /

# An account's own surfaces, and the doors into one.
Disallow: /studio
Disallow: /settings
Disallow: /notifications
Disallow: /basket
Disallow: /library
Disallow: /network
Disallow: /dashboard
Disallow: /login
Disallow: /signup
Disallow: /finish
Disallow: /welcome
Disallow: /unsubscribe
Disallow: /desktop/authorize
Disallow: /auth/
Disallow: /api/

# A share link is a locator and an embed is a player; neither is a page of its own.
Disallow: /s/
Disallow: /embed/

Sitemap: ${siteOrigin}${SITEMAP_PATH}
`;
}

/**
 * The sitemap: every standing page, at the address it is served from.
 *
 * Only `<loc>` is written. A `lastmod` we do not track would be a guess a crawler may believe,
 * and `changefreq` and `priority` are ignored by the engines that matter, so a document saying
 * less is a document saying only true things.
 */
export function sitemapXml(siteOrigin: string): string {
	const urls = indexablePaths()
		.map((path) => `\t<url>\n\t\t<loc>${siteOrigin}${path}</loc>\n\t</url>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

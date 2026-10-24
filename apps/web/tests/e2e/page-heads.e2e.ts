// SPDX-License-Identifier: Apache-2.0
/**
 * A standing page's link preview says what the page is, and names its own address.
 *
 * Every route shares the shell's one card, so a marketing or policy page used to preview as
 * the homepage: the site's title, the site's line, and `og:url` pointing at `/`. This walk
 * reads the served documents the way an unfurler does, with no script and no session, and
 * checks both halves at once — the words and the address they belong to.
 *
 * The two refusals matter as much as the pages that answer. The homepage keeps the shipped
 * block, because the shell's own card is already the homepage's; and a door keeps it too,
 * because a preview of a sign-in form describes nothing anybody meant to share.
 */

import { expect, test, WEB_ORIGIN } from "./fixtures";

const CREATORS_LINE =
	"Publish games, videos, music, and writing under one identity, with no platform cut on what your audience gives you.";

test("a marketing page previews as itself, at its own address", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/for-creators`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<title>For Creators — Anthers</title>");
	expect(html).toContain('<meta property="og:title" content="For Creators" />');
	expect(html).toContain(`<meta property="og:description" content="${CREATORS_LINE}" />`);
	// The plain description too, not only the og one: a search result reads that tag.
	expect(html).toContain(`<meta name="description" content="${CREATORS_LINE}" />`);
	// The address the recipient was given, not the site root that every route used to claim.
	expect(html).toContain('<link rel="canonical" href="https://anthers.org/for-creators" />');
	expect(html).toContain('<meta property="og:url" content="https://anthers.org/for-creators" />');
	// The image stays the site card, because a marketing page has no artwork of its own.
	expect(html).toContain('content="https://anthers.org/brand/og-card.png"');
});

test("a policy page previews with its own title and address", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/privacy`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<title>Privacy Policy — Anthers</title>");
	expect(html).toContain(
		'<meta property="og:description" content="What we collect, why, and what you can do about it." />',
	);
	expect(html).toContain('<meta property="og:url" content="https://anthers.org/privacy" />');
});

test("the homepage and a door keep the site card", async ({ page }) => {
	for (const path of ["/", "/login"]) {
		const res = await page.request.get(`${WEB_ORIGIN}${path}`);
		expect(res.status(), path).toBe(200);
		const html = await res.text();
		expect(html, path).toContain("<title>Anthers</title>");
		expect(html, path).toContain('<meta property="og:url" content="https://anthers.org/" />');
	}
});

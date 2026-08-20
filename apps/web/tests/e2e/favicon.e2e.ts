// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The tab icon: declared in the head, and actually fetchable.
//
// 🚨 Why a spec for three `<link>` tags. The icons are not committed under `public/` —
// they are referenced out of `@anthers/brand` and **bundled**, so Bun rewrites each href
// to a content-hashed output at build time. That is what keeps the marks in one place,
// and it also puts the tab icon behind the same machinery that has already failed
// silently twice on this entrypoint: `splitting` repointed the module script at the
// wrong chunk (blank page, clean console, HTTP 200), and the bundler inlines webfonts as
// base64 unless they are kept out of its reach. A dropped or mis-pointed icon href is
// quieter than either — the browser falls back to its default globe and reports nothing.
//
// So the load-bearing assertion is not "a link tag exists", it is **"the URL the tag
// names returns an image"**. The first half can pass against a build that emitted
// nothing.

import { expect, test } from "./fixtures";

test.describe("the site declares a tab icon", () => {
	test("every declared icon resolves to an image", async ({ page }) => {
		await page.goto("/");

		const icons = await page
			.locator('link[rel="icon"], link[rel="apple-touch-icon"]')
			.evaluateAll((links) =>
				links.map((l) => ({
					rel: l.getAttribute("rel") ?? "",
					href: (l as HTMLLinkElement).href,
				})),
			);

		// An SVG for browsers that take one, a PNG for those that don't, and the iOS
		// home-screen cut. Asserting the count rather than ">= 1" is deliberate: losing
		// the PNG fallback alone would be invisible in Chromium, which prefers the SVG.
		expect(icons.map((i) => i.rel).sort()).toEqual(["apple-touch-icon", "icon", "icon"]);

		for (const icon of icons) {
			const res = await page.request.get(icon.href);
			expect(res.status(), `${icon.rel} → ${icon.href}`).toBe(200);
			expect(res.headers()["content-type"] ?? "", `${icon.rel} → ${icon.href}`).toMatch(/^image\//);
		}
	});

	test("the icon is served from our own origin", async ({ page }) => {
		await page.goto("/");
		const hosts = await page
			.locator('link[rel="icon"], link[rel="apple-touch-icon"]')
			.evaluateAll((links) => links.map((l) => new URL((l as HTMLLinkElement).href).origin));

		// `third-party-requests.e2e.ts` holds the general rule; this is the one head asset
		// that would be trivial to "fix" one day by pointing at a CDN, which is the same
		// mistake the self-hosted fonts exist to undo.
		const pageOrigin = new URL(page.url()).origin;
		expect(new Set(hosts)).toEqual(new Set([pageOrigin]));
	});
});

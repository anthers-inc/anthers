// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "./fixtures";

/**
 * The site must not make requests to anyone but itself.
 *
 * This exists because it silently wasn't true. Until 2026-08-09 `index.html` pulled
 * four families from `fonts.googleapis.com`, which handed every visitor's IP,
 * user-agent and referring URL to Google on first paint — before consent could
 * exist, and before the visitor had done anything but open the page. It was found
 * while verifying the privacy policy's subprocessor list, not by anything failing.
 *
 * A third-party request is a disclosure of personal data whether or not anyone
 * intended it as one, so the fonts were self-hosted rather than disclosed
 * (apps/web/public/fonts/THIRD-PARTY.md). This test is the part that keeps it true:
 * the next CDN `<link>` or embed fails here rather than in a policy audit a year on.
 *
 * If a genuine third-party dependency is ever added, this test does not simply get
 * an entry in an allowlist — it also gets a row in `Privacy Policy`.
 */
test.describe("third-party requests", () => {
	// Marketing routes reachable with no API behind them (the preview is static).
	// Deliberately includes the heaviest ones — decor, charts, and the wiki's own
	// MDX pipeline are where an external asset would most plausibly sneak in.
	const ROUTES = ["/", "/about", "/for-creators", "/for-users", "/resources"];

	for (const route of ROUTES) {
		test(`${route} requests nothing off-origin`, async ({ page }) => {
			const offOrigin: string[] = [];
			let seen = 0;
			page.on("request", (req) => {
				seen++;
				const url = new URL(req.url());
				// data: and blob: carry no network request; localhost is us (the preview
				// on :4173 and the API on :8000 both count as first-party here).
				if (url.protocol !== "http:" && url.protocol !== "https:") return;
				if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return;
				offOrigin.push(req.url());
			});

			await page.goto(route, { waitUntil: "networkidle" });

			// 🚨 **An empty list is two different facts and this is what tells them apart.**
			// Nothing above proves the page made any request at all, so a navigation that
			// silently failed, a route answering an empty shell, or a listener attached too
			// late all read as a clean pass — the same vacuous absence a guard reports when
			// its corpus has gone empty. The font test below has always had this check; the
			// route loop did not.
			expect(seen, `${route} made no requests at all — the page did not load`).toBeGreaterThan(0);

			expect(
				offOrigin,
				`${route} made off-origin request(s). Every one is a third party receiving ` +
					`this visitor's IP and user-agent. Self-host it, or add it to the ` +
					`privacy policy's subprocessor table — not to this test.`,
			).toEqual([]);
		});
	}

	test("the four Meadow families load from our own origin", async ({ page }) => {
		const fontRequests: string[] = [];
		page.on("request", (req) => {
			if (req.resourceType() === "font") fontRequests.push(req.url());
		});

		await page.goto("/about", { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);

		// The display serif is the one visible on every marketing page, so it is the
		// honest canary: if the self-hosted CSS stops resolving, this fails rather
		// than the page quietly falling back to Georgia and looking almost right.
		const resolved = await page.evaluate(() => document.fonts.check('16px "Fraunces"'));
		expect(resolved, "Fraunces did not resolve — the site fell back to Georgia").toBe(true);

		expect(fontRequests.length, "no webfont was downloaded at all").toBeGreaterThan(0);
		for (const url of fontRequests) {
			expect(url, "a webfont came from somewhere other than our origin").toContain("/fonts/");
		}
	});
});

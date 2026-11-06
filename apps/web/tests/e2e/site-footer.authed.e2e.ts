// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in shell has no marketing-site footer (Parker, 2026-11-06).
 *
 * 🚨 **The footer used to render on Settings alone, on the reasoning that an account page
 * wanted the site's reference and legal columns.** It does not: the sidebar already carries
 * the reader's navigation and the settings sections, and the marketing footer under a page
 * a person is managing their own account on reads as a different site leaking in. This is
 * an absence, so nothing else in the repository can tell it from a footer that merely
 * renders hidden — hence the walk.
 *
 * ⚠️ **The logged-out marketing pages keep their own footer**, which is why this is a
 * signed-in-shell assertion rather than a repository-wide one.
 */
import { expect, type Page, test } from "@playwright/test";

const footer = (page: Page) => page.locator("[data-site-footer]");

for (const path of ["/settings", "/settings?tab=experience", "/library", "/discovery"]) {
	test(`no signed-in site footer on ${path}`, async ({ page }) => {
		await page.goto(path);
		await expect(footer(page), `a site footer is on ${path}`).toHaveCount(0);
	});
}

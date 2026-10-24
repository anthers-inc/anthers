// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in site-map footer renders on the account page — Settings — and nowhere else in
 * the signed-in shell. Badges & Purchases is a tab on Settings since 2026-10-23, so its old
 * address is a redirect that lands here rather than a second page carrying a second footer.
 *
 * 🚨 **Both halves are the contract.** A footer that vanishes from Settings has lost the
 * site's reference and legal entry points on a page where a person manages their own
 * account; a footer that reappears on Feed has put a site map below every surface again.
 * The element carries `data-site-footer` so the assertion cannot match a page's own
 * <footer> — a post's, for instance.
 */
import { expect, type Page, test } from "@playwright/test";

const footer = (page: Page) => page.locator("[data-site-footer]");

test.describe("the signed-in site footer", () => {
	// `/purchases` is visited as well: it forwards to Settings, and a redirect that lost the
	// footer's page would be a page in the set without one.
	for (const path of ["/settings", "/purchases"]) {
		test(`renders on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(footer(page), `no site footer on ${path}`).toBeVisible();
		});
	}

	for (const path of ["/library", "/discovery"]) {
		test(`is absent on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(footer(page), `a site footer is on ${path}`).toHaveCount(0);
		});
	}
});

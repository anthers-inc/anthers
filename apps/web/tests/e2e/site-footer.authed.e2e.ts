// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in site-map footer renders on the account pages only — Badges, Purchases
 * and Settings — and nowhere else in the signed-in shell.
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
	for (const path of ["/badges", "/purchases", "/settings"]) {
		test(`renders on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(footer(page), `no site footer on ${path}`).toBeVisible();
		});
	}

	for (const path of ["/network", "/library", "/discovery"]) {
		test(`is absent on ${path}`, async ({ page }) => {
			await page.goto(path);
			await expect(footer(page), `a site footer is on ${path}`).toHaveCount(0);
		});
	}
});

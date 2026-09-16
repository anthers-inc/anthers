// SPDX-License-Identifier: Apache-2.0
/**
 * The logged-in sidebar never squeezes the page on a phone.
 *
 * 🚨 **The squeeze is invisible to the overflow gate.** An open 16rem sidebar beside the page
 * leaves a 390px phone about 140px of page, and nothing in that page is wider than the
 * screen — it is simply narrow — so `mobile-overflow.e2e.ts` would pass it even if it could
 * sign in, which it cannot. This measures the thing itself instead: where `<main>` starts and
 * how wide it is.
 *
 * Three phone assertions, because each is a separate way back to the squeeze: the sidebar
 * starts closed, opening it lays it over the page rather than beside it, and navigating from
 * it closes it again (a drawer left open hides the page it just went to). The desktop test
 * pins the other side, since the easy fix — closed everywhere — would pass every phone test.
 */
import { expect, type Page, test } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** `<main>`'s left edge and width, and the sidebar's width, in CSS pixels. */
async function layout(page: Page) {
	return page.evaluate(() => {
		const main = document.querySelector("main")?.getBoundingClientRect();
		const aside = document.querySelector("aside")?.getBoundingClientRect();
		return {
			mainLeft: Math.round(main?.left ?? -1),
			mainWidth: Math.round(main?.width ?? -1),
			asideWidth: Math.round(aside?.width ?? -1),
		};
	});
}

const toggle = (page: Page) => page.getByRole("button", { name: "Toggle sidebar" });

test.describe("on a phone", () => {
	test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

	test("the sidebar starts closed and the page gets the whole width", async ({ page }) => {
		await page.goto("/feed");
		// Render proof: the assertions below are about geometry, which a page that never
		// mounted the layout would fail for the wrong reason or pass by accident.
		await expect(toggle(page)).toBeVisible();

		expect(await layout(page)).toEqual({ mainLeft: 0, mainWidth: PHONE.width, asideWidth: 0 });
	});

	test("opening the sidebar lays it over the page", async ({ page }) => {
		await page.goto("/feed");
		await toggle(page).click();

		// The width animates, so poll for the settled drawer rather than reading mid-transition.
		await expect.poll(async () => (await layout(page)).asideWidth).toBe(256);
		expect(await layout(page), "opening the sidebar squeezed the page").toMatchObject({
			mainLeft: 0,
			mainWidth: PHONE.width,
		});

		// The page it covers is one tap away — on the part the drawer leaves showing, since the
		// backdrop's own center is underneath the drawer.
		await page
			.getByRole("button", { name: "Close sidebar" })
			.click({ position: { x: PHONE.width - 30, y: 300 } });
		await expect.poll(async () => (await layout(page)).asideWidth).toBe(0);
	});

	test("navigating from the sidebar closes it", async ({ page }) => {
		await page.goto("/feed");
		await toggle(page).click();
		await expect.poll(async () => (await layout(page)).asideWidth).toBe(256);

		await page.locator("aside").getByRole("link", { name: "Library" }).click();
		await expect(page).toHaveURL(/\/library/);
		await expect
			.poll(async () => (await layout(page)).asideWidth, {
				message: "the drawer stayed open over the page it navigated to",
			})
			.toBe(0);
	});
});

test.describe("on a desktop", () => {
	test.use({ viewport: DESKTOP });

	test("the sidebar starts open beside the page", async ({ page }) => {
		await page.goto("/feed");
		await expect(toggle(page)).toBeVisible();

		const { mainLeft, asideWidth } = await layout(page);
		expect(asideWidth).toBe(256);
		expect(mainLeft, "the sidebar is over the page rather than beside it").toBe(256);
	});
});

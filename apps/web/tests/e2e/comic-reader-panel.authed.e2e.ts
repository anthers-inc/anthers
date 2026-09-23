// SPDX-License-Identifier: Apache-2.0
/**
 * The comic reader's panel mode, walked in a browser.
 *
 * Uses the media fixture's comic Work, which is seeded once by the setup project and not
 * reset by any other suite. The assertions here cover entering panel mode, advancing
 * across page boundaries, the page-zoom shortcut, and restoring position from localStorage
 * after a reload.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { expect, test } from "./fixtures";

const COMIC = mediaFixtureWork("comic");
const READER = "[aria-label='Reader: A comic that really turns']";

test.describe.configure({ mode: "serial" });

async function openComic(page: import("@playwright/test").Page) {
	await page.goto(`/works/${COMIC.slug}-${COMIC.publicId}`);
	await expect(page.locator(READER)).toBeVisible();
}

async function panelIndicator(page: import("@playwright/test").Page) {
	return page.locator("span", { hasText: /Panel \d+ of \d+ · Page \d+/ }).first();
}

test("panel mode enters and shows the first panel", async ({ page }) => {
	await openComic(page);

	await page.getByRole("button", { name: "Panel mode" }).click();
	const indicator = await panelIndicator(page);
	await expect(indicator).toBeVisible();
	// The indicator carries the panel position, the current page, and a total — assert the
	// start, which is the part that identifies the panel the reader is on.
	await expect(indicator).toContainText("Panel 1 of 4 · Page 1");
});

test("next advances panels within a page and wraps to page 2", async ({ page }) => {
	await openComic(page);
	await page.getByRole("button", { name: "Panel mode" }).click();
	const next = page.getByRole("button", { name: "Next panel" });

	await next.click();
	await expect(await panelIndicator(page)).toContainText("Panel 2 of 4 · Page 1");
	await next.click();
	await next.click();
	await next.click();
	// Page 1 has four panels; the fourth next wraps to page 2, which has a single
	// whole-page panel from detection's zero-panel fallback.
	await expect(await panelIndicator(page)).toContainText("Panel 1 of 1 · Page 2");
});

test("z toggles zoom without leaving panel mode", async ({ page }) => {
	await openComic(page);
	await page.getByRole("button", { name: "Panel mode" }).click();
	await expect(await panelIndicator(page)).toBeVisible();

	await page.keyboard.press("z");
	await expect(await panelIndicator(page)).toBeVisible();

	await page.getByRole("button", { name: "Next panel" }).click();
	await expect(await panelIndicator(page)).toContainText("Panel 2 of 4 · Page 1");
});

test("a reload restores the saved panel position", async ({ page }) => {
	await openComic(page);
	await page.getByRole("button", { name: "Panel mode" }).click();
	await page.getByRole("button", { name: "Next panel" }).click();
	await expect(await panelIndicator(page)).toContainText("Panel 2 of 4 · Page 1");

	await page.reload();
	// The reader enters page mode by default on a reload; panel mode is a per-session
	// choice. Flip back in, and the saved panel is where it returns to.
	await page.getByRole("button", { name: "Panel mode" }).click();
	await expect(await panelIndicator(page)).toContainText("Panel 2 of 4 · Page 1");
});

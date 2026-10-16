// SPDX-License-Identifier: Apache-2.0
/**
 * A layout change a toggle makes must not move the reader's scroll offset.
 *
 * Opening a field for edit makes the page taller; saving or canceling shrinks it back;
 * switching an Info or side tab swaps panels of different heights. The shell pages scroll
 * on a container (`LoggedInLayout`'s `<main>`), so the browser clamps an offset whose
 * page became too short and the reader lands elsewhere. `keepScroll`
 * (`components/work/scrollKeeper.ts`) captures and restores the offset at both moments;
 * this walk proves the place survives.
 *
 * 🚨 The clicks here are **raw `page.mouse` clicks on measured positions** — never
 * `locator.click()`. Playwright's actionability scrolls a below-the-fold target into
 * view before activating it, which is a scroll the keeper cannot undo (its captured
 * offset already carries it), so a locator-driven walk would be testing the harness's
 * own scrolling. A reader clicks only what they can already see; so does this walk,
 * and each click asserts its target was on screen before it was made.
 *
 * Runs on `media_fixture`'s own video, whose page is tall enough to scroll.
 */
import { expect, signInAsMediaFixture, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const OFFSET = 450;
const scrollTop = (page: import("@playwright/test").Page) =>
	page.evaluate(() => Math.round(document.querySelector("main")?.scrollTop ?? -1));

/** A raw mouse click at a target's center, refusing targets not currently on screen.
 *  On-screen is measured against the page's own scroll container's visible box — the
 *  viewport's dimensions belong to whichever project runs the walk, never to this file. */
async function clickAt(
	page: import("@playwright/test").Page,
	locator: import("@playwright/test").Locator,
) {
	const box = await locator.boundingBox();
	expect(box, "the toggle's target has a box").not.toBeNull();
	const onScreen = await page.evaluate(
		([x, y, w, h]) => {
			const main = document.querySelector("main");
			if (!main) return false;
			const r = main.getBoundingClientRect();
			return x >= r.left && y >= r.top && x + w <= r.right && y + h <= r.bottom;
		},
		[box.x, box.y, box.width, box.height],
	);
	expect(onScreen, `the target is on screen unscrolled (at ${JSON.stringify(box)})`).toBe(true);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("the creator's place survives every toggle that changes the page's height", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await page.goto("/works/media-fixture-video-910000001");
	await page.getByLabel("Edit Description").waitFor({ state: "visible", timeout: 15_000 });

	// Deep enough that both the growth and the shrink of the edit state are real.
	const scrollable = await page.evaluate(() => {
		const main = document.querySelector("main");
		return !!main && main.scrollHeight > main.clientHeight;
	});
	expect(scrollable, "the walk's page is expected to be scrollable").toBe(true);
	await page.evaluate(() => document.querySelector("main")?.scrollTo({ top: 450 }));
	await page.waitForTimeout(400);
	expect(await scrollTop(page)).toBe(OFFSET);

	// Open the description for edit: much taller.
	await clickAt(page, page.getByLabel("Edit Description"));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);

	// Enter-activated close: a keyboard path's close.
	await page.getByLabel("Cancel editing Description").focus({ preventScroll: true });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);

	// Re-open and close by pointer click, both directions.
	await clickAt(page, page.getByLabel("Edit Description"));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);
	await clickAt(page, page.getByLabel("Cancel editing Description"));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);

	// A save is a close too (the field's own save path, then the read).
	await clickAt(page, page.getByLabel("Edit Description"));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);
	await clickAt(page, page.getByRole("button", { name: "Save Description" }));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);

	// Tab switches of both groups.
	await clickAt(page, page.getByRole("tab", { name: "Rating" }));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);
	await clickAt(page, page.getByRole("tab", { name: "Details" }));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);
	await clickAt(page, page.getByRole("tab", { name: "Manage" }));
	await page.waitForTimeout(900);
	expect(await scrollTop(page)).toBe(OFFSET);
});

test("the read view shows the line breaks the edit textarea holds", async ({ page, context }) => {
	await signInAsMediaFixture(context);
	await page.goto("/works/media-fixture-video-910000001");
	await page.getByLabel("Edit Description").waitFor({ state: "visible", timeout: 15_000 });
	// The fixture description carries a timestamped chapter list on separate lines;
	// whitespace-pre-line is what keeps those breaks in the read view.
	const wrapped = await page
		.locator("section p")
		.filter({ hasText: "0:00 Opening" })
		.first()
		.evaluate((el) => getComputedStyle(el).whiteSpace);
	expect(wrapped).toBe("pre-line");
});

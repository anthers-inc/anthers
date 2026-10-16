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
 * own scrolling. A reader clicks only what they can already see; so does this walk:
 * each target is centered in its container by the walk's own JS scroll first, the
 * offset is measured immediately before the click, and the assertion is that the same
 * offset survives the toggle. The viewport's dimensions belong to whichever project
 * runs the walk, never to this file.
 *
 * Runs on `media_fixture`'s own video, whose page is tall enough to scroll.
 */
import { expect, signInAsMediaFixture, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const scrollTop = (page: import("@playwright/test").Page) =>
	page.evaluate(() => Math.round(document.querySelector("main")?.scrollTop ?? -1));

/** Center a target in its scroll container, by this walk's own JS scroll. */
async function centerIntoView(
	page: import("@playwright/test").Page,
	locator: import("@playwright/test").Locator,
): Promise<void> {
	await locator.evaluate((el) =>
		(el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" }),
	);
	await page.waitForTimeout(150);
}

/** A raw mouse click at a target's center, refusing targets not currently on screen.
 *  On-screen is measured against the page's own scroll container's visible box, with a
 *  small inset for the sticky header that sits over its top. */
async function mouseClickAt(
	page: import("@playwright/test").Page,
	locator: import("@playwright/test").Locator,
): Promise<void> {
	const box = await locator.boundingBox();
	expect(box, "the toggle's target has a box").not.toBeNull();
	const onScreen = await page.evaluate(
		([x, y, w, h]) => {
			const main = document.querySelector("main");
			if (!main) return false;
			const r = main.getBoundingClientRect();
			return x >= r.left && y >= r.top + 8 && x + w <= r.right && y + (h as number) <= r.bottom;
		},
		[box.x, box.y, box.width, box.height],
	);
	expect(onScreen, `the target is on screen (at ${JSON.stringify(box)})`).toBe(true);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** The toggle's whole rhythm: center the control, hold the offset measured there, click,
 *  and expect the offset the toggle started from to be the offset it left. */
async function clickHoldingPlace(
	page: import("@playwright/test").Page,
	locator: import("@playwright/test").Locator,
) {
	await centerIntoView(page, locator);
	const before = await scrollTop(page);
	await mouseClickAt(page, locator);
	await page.waitForTimeout(900);
	expect(await scrollTop(page), "the place survives the toggle").toBe(before);
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
		return !!main && main.scrollHeight - main.clientHeight > 200;
	});
	expect(scrollable, "the walk's page is expected to be scrollable").toBe(true);
	await page.evaluate(() => document.querySelector("main")?.scrollTo({ top: 300 }));
	await page.waitForTimeout(400);

	// Open the description for edit: much taller.
	await clickHoldingPlace(page, page.getByLabel("Edit Description"));

	// Enter-activated close: the keyboard path.
	const beforeEnter = await scrollTop(page);
	await page.getByLabel("Cancel editing Description").focus({ preventScroll: true });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(900);
	expect(await scrollTop(page), "the place survives the Enter close").toBe(beforeEnter);

	// Re-open and close by pointer click, both directions.
	await clickHoldingPlace(page, page.getByLabel("Edit Description"));
	await clickHoldingPlace(page, page.getByLabel("Cancel editing Description"));

	// A save is a close too (the field's own save path, then the read).
	await clickHoldingPlace(page, page.getByLabel("Edit Description"));
	await clickHoldingPlace(page, page.getByRole("button", { name: "Save Description" }));

	// Tab switches of both groups.
	await clickHoldingPlace(page, page.getByRole("tab", { name: "Rating" }));
	await clickHoldingPlace(page, page.getByRole("tab", { name: "Details" }));
	await clickHoldingPlace(page, page.getByRole("tab", { name: "Manage" }));
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

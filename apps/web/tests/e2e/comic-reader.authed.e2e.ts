// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The comic reader, walked in a browser.
 *
 * 🚨 **The assertion that justifies the whole design is the negative one**: no request the
 * reader makes ever returns the source PDF. Rasterizing on upload cost a job, a system
 * dependency and a table — and the entire return on that is that a book is delivered one
 * checked page at a time rather than as one file whose URL is the whole book. If a reader
 * ever fetched the PDF directly, every bit of that would be wasted and
 * `downloadEnabled: false` would be a lie for this medium, silently.
 *
 * The rest is page-turning: the thing a reader does, which had no way of happening before
 * (a Work of type `image` rendered as a single `<img>` and that was the entire experience).
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const COMIC = mediaFixtureWork("ebook");
const READER = 'section[aria-label^="Reader:"]';

async function openReader(page: Page) {
	await page.goto(`/works/${COMIC.slug}-${COMIC.publicId}`);
	await expect(page.locator(READER)).toBeVisible();
	// Page one has to actually decode — a broken <img> is still "visible" to Playwright,
	// and a reader full of alt text would pass every structural assertion below.
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const img = document.querySelector<HTMLImageElement>(
						'section[aria-label^="Reader:"] img',
					);
					return img?.complete === true && img.naturalWidth > 0;
				}),
			{ timeout: 15_000, message: "page one never decoded" },
		)
		.toBe(true);
}

/** Which page numbers the reader is currently showing, read off the images' alt text. */
async function shownPages(page: Page): Promise<number[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLImageElement>('section[aria-label^="Reader:"] img')]
			.map((img) => Number(/page (\d+)$/.exec(img.alt)?.[1] ?? 0))
			.filter((n) => n > 0),
	);
}

test.describe.configure({ mode: "serial" });

test("🚨 the source PDF is never fetched — pages are, one at a time", async ({ page }) => {
	const requested: string[] = [];
	page.on("request", (r) => requested.push(r.url()));

	await openReader(page);
	await page.locator(READER).getByRole("button", { name: "Next page" }).click();
	await expect.poll(() => shownPages(page)).toEqual([2]);

	// Nothing anywhere in the page load asked for a PDF. This is the property the whole
	// rasterization decision buys, and the only place it is checked end to end.
	expect(
		requested.filter((u) => u.includes(".pdf")),
		"the reader fetched a PDF — the single-file delivery hazard is back",
	).toEqual([]);

	// And what it DID ask for was the per-page endpoint, which re-resolves access on
	// every request. Asserted positively too: "no PDF" would also be satisfied by a
	// reader that fetched nothing at all.
	expect(requested.some((u) => /\/api\/content\/works\/\d+\/pages\/1$/.test(u))).toBe(true);
	expect(requested.some((u) => /\/api\/content\/works\/\d+\/pages\/2$/.test(u))).toBe(true);
});

test("pages turn, and the reader knows where it is", async ({ page }) => {
	await openReader(page);
	expect(await shownPages(page)).toEqual([1]);
	// "1 / 4" — the count comes from the serialized Work, which is what made the
	// Work-detail endpoint's own page count worth counting separately.
	await expect(page.locator(READER)).toContainText(`/ ${4}`);

	const reader = page.locator(READER);
	await reader.getByRole("button", { name: "Next page" }).click();
	await expect.poll(() => shownPages(page)).toEqual([2]);

	await reader.getByRole("button", { name: "Previous page" }).click();
	await expect.poll(() => shownPages(page)).toEqual([1]);

	// The first page has nowhere back to go, and the control says so rather than being
	// a button that quietly does nothing.
	await expect(reader.getByRole("button", { name: "Previous page" })).toBeDisabled();
});

test("arrow keys turn pages once the reader has focus", async ({ page }) => {
	await openReader(page);
	await page.locator(READER).focus();

	await page.keyboard.press("ArrowRight");
	await expect.poll(() => shownPages(page)).toEqual([2]);
	await page.keyboard.press("ArrowLeft");
	await expect.poll(() => shownPages(page)).toEqual([1]);

	// End/Home, because a reader who wants the last page should not click four times.
	await page.keyboard.press("End");
	await expect.poll(() => shownPages(page)).toEqual([4]);
	await page.keyboard.press("Home");
	await expect.poll(() => shownPages(page)).toEqual([1]);
});

test("the spread view shows two pages at once", async ({ page }) => {
	await openReader(page);
	await page.locator(READER).getByRole("button", { name: "Two-page spread" }).click();
	await expect.poll(() => shownPages(page)).toEqual([1, 2]);

	// And turns by two, the way a book opens.
	await page.locator(READER).getByRole("button", { name: "Next page" }).click();
	await expect.poll(() => shownPages(page)).toEqual([3, 4]);
});

test("it reopens where you stopped reading", async ({ page }) => {
	await openReader(page);
	await page.locator(READER).getByRole("button", { name: "Next page" }).click();
	await page.locator(READER).getByRole("button", { name: "Next page" }).click();
	await expect.poll(() => shownPages(page)).toEqual([3]);

	// A chapter is one Work, so "continue reading" ACROSS a book belongs to the library
	// experience — but reopening the chapter you were in the middle of is this reader's
	// job, and losing your place on a reload is the thing that makes a reader feel cheap.
	await openReader(page);
	expect(await shownPages(page)).toEqual([3]);
});

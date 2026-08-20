// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The basket is reachable from the header — the one conversion surface that was only
 * reachable from a Work page.
 *
 * 🚨 **This spec exists because `/basket` was linked from no layout or header component
 * at all.** A buyer who added an item and navigated anywhere had no way back except the
 * browser's back button — on the one surface where money changes hands. The header link
 * renders only when the basket has items, so the tight header costs nothing when empty;
 * this spec pins both halves (appears when non-empty, absent when empty) and the count.
 *
 * The basket is client-side `localStorage` (`lib/basket.ts`), so the spec seeds it
 * directly rather than driving through a Work page. That is faster, more robust, and
 * tests exactly the wiring under test: the header reads the same `useBasket` hook the
 * Work page writes through, and the cross-component event is what keeps them in sync.
 *
 * ⚠️ **Seeding uses `evaluate` + reload, not `addInitScript`.** The `authed` project's
 * `page` fixture already queues an `addInitScript` for the SiteGate flag, and a second
 * `addInitScript` from the test body did not fire reliably alongside it (verified by
 * console.log — the script never ran). Setting localStorage after the first load and
 * reloading is the same end state and does not depend on init-script ordering.
 */
import { expect, type Page, test } from "@playwright/test";

/** The `localStorage` key and shape `lib/basket.ts` reads — kept in sync with its `KEY`
 *  and `VERSION` rather than imported, because the spec should break loudly if the shape
 *  changes, not silently keep writing the old one. */
const BASKET_KEY = "anthers_basket";
const BASKET_VERSION = 1;

/**
 * Seed the basket into `localStorage` on an already-loaded page, then reload so the
 * `useBasket` hook reads it on mount. A basket with real items needs Work ids the server
 * recognizes; for the header-link assertion, the shape is what matters — the count
 * renders from `items.length` and the link goes to `/basket` regardless of whether the
 * ids resolve.
 */
async function seedBasketAndReload(page: Page, count: number): Promise<void> {
	const items = Array.from({ length: count }, (_, i) => ({
		workId: 990000000 + i,
		slug: `basket-test-${i}`,
		title: `Basket test ${i}`,
		price: "1.00",
		creatorUsername: "media_fixture",
	}));
	await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
		key: BASKET_KEY,
		value: JSON.stringify({ version: BASKET_VERSION, items }),
	});
	await page.reload();
}

// Scope to the header — the sidebar also carries a Basket entry when non-empty, so an
// unscoped `getByRole("link", { name: /Basket/ })` matches two and fails strict mode.
// This mirrors `header-account-menu.authed.e2e.ts`'s scoping for the same reason.
const header = (page: Page) => page.getByRole("banner");

test("the header shows a basket link with a count when the basket has items", async ({ page }) => {
	await page.goto("/feed");
	await seedBasketAndReload(page, 3);

	await expect(page.getByRole("heading", { name: "Feed" })).toBeVisible();
	const link = header(page).getByRole("link", { name: /Basket \(3 items\)/ });
	await expect(link, "the basket link did not appear in the header").toBeVisible();
	await expect(link).toHaveAttribute("href", "/basket");
	// The count badge is the load-bearing part — a link that is always there with no
	// count is a different, weaker control.
	await expect(header(page).locator(".badge").filter({ hasText: "3" })).toBeVisible();
});

test("the header hides the basket link when the basket is empty", async ({ page }) => {
	// No seed — empty basket is the default localStorage state.
	await page.goto("/feed");
	await expect(
		header(page).getByRole("link", { name: /Basket/ }),
		"the basket link appeared when the basket was empty",
	).toHaveCount(0);
});

test("the basket link reaches the basket page", async ({ page }) => {
	await page.goto("/feed");
	await seedBasketAndReload(page, 1);

	await header(page)
		.getByRole("link", { name: /Basket \(1 item\)/ })
		.click();
	await expect(page).toHaveURL("/basket");
});

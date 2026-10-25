// SPDX-License-Identifier: Apache-2.0
/**
 * Every public page wears the marketing chrome, signed in or not.
 *
 * 🚨 **The bug this pins is a shell choice, so nothing else can see it.** A page in the
 * auth-switching group still renders, still answers its address, and still passes every
 * assertion about its own content — it merely arrives inside the signed-in layout, a
 * sidebar of Discovery, Library and Settings over a page the reader is consulting. That is
 * the frame for *using* Anthers; a policy, a fee calculator or a changelog has no use for
 * it. `/resources`, its calculators and `/faq` sat there until 2026-10-25, linked from a
 * marketing nav that put the same pages in front of a signed-in reader wearing the app's
 * chrome instead.
 *
 * ⚠️ **The first test is what keeps the rest honest.** These routes look right signed out
 * too — the marketing chrome is what a signed-out visitor gets regardless — so a session
 * that stopped arriving signed in would leave every other assertion here passing on
 * nothing at all. The account button exists only behind a session, so it is the check.
 *
 * The list is the public half of `App.tsx`'s two route groups: the pages a reader consults
 * rather than uses. A page added to the shared group by mistake is what this file is for.
 */
import { expect, type Page, test } from "@playwright/test";

const PUBLIC_ROUTES = [
	"/faq",
	"/parents",
	"/release-notes",
	"/status",
	"/issues",
	"/abuse",
	"/copyright",
	"/privacy",
	"/terms",
	"/creator-terms",
	"/resources",
	"/resources/pay-comparison",
	"/resources/how-money-moves",
	"/resources/media-month",
	"/resources/creator-financials",
];

const header = (page: Page) => page.getByRole("banner");

test("this suite's session is signed in", async ({ page }) => {
	await page.goto("/discovery");
	await expect(
		header(page).getByRole("button", { name: "Your account" }),
		"the authed project's session is not signed in, so every other test in this file would pass vacuously",
	).toBeVisible();
});

for (const path of PUBLIC_ROUTES) {
	test(`${path} wears the marketing chrome while signed in`, async ({ page }) => {
		await page.goto(path);

		// The marketing header's primary door. The signed-in header carries the account menu
		// in that corner instead, so this one link tells the two shells apart.
		await expect(header(page).getByRole("link", { name: "Sign Up Free" })).toBeVisible();

		// The signed-in sidebar, named for what it navigates. `getByRole` sees only the
		// accessibility tree, so a shell that renders it hidden still counts as absent.
		await expect(
			page.getByRole("navigation", { name: "Anthers" }),
			"the signed-in sidebar rendered over a public page",
		).toHaveCount(0);
	});
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `/@name` is a person; `/name` is a page; anything else is a 404.
 *
 * 🚨 **This is the half of the guard that walks the real app.** Its partner,
 * `scripts/profile-url-guard.test.ts`, asserts that no profile path is typed inline — which
 * would still pass if the helper returned nonsense or the route stopped reading the prefix.
 * This one asserts the router actually behaves as the prefix promises, and it is the only
 * thing that would notice `path="/:handle"` being changed back.
 *
 * ⭐ **It needs no API, which is why it runs in the static `chromium` project.** The two
 * outcomes are told apart by which "not found" wording renders: `CreatorProfilePage` answers
 * *"This user doesn't exist"* once its fetch comes back empty, while a segment that is not a
 * handle never reaches that page at all and gets `NotFoundPage` instead. So the discriminator
 * is the route, not the data — exactly what is under test.
 */

import { expect, test } from "./fixtures";

/** `NotFoundPage`'s heading. Nothing else on the site renders it. */
const NOT_FOUND = "There's Nothing at This Address";

/** `CreatorProfilePage`'s own empty state, which only renders once the route matched. */
const NO_SUCH_USER = "This user doesn't exist.";

test.describe("@-prefixed profile URLs", () => {
	test("an @ handle reaches the profile page, even when no such creator exists", async ({
		page,
	}) => {
		await page.goto("/@nobody-by-this-name");
		// The profile page's own empty state — proof the route matched and the `@` was
		// stripped, rather than the segment being turned away as a non-handle.
		await expect(page.getByText(NO_SUCH_USER)).toBeVisible();
		await expect(page.getByRole("heading", { name: NOT_FOUND })).toHaveCount(0);
	});

	test("🚨 a bare root segment 404s instead of becoming a profile lookup", async ({ page }) => {
		// The whole point. Until 2026-09-03 this rendered a profile lookup, so a wrong link
		// navigated, rendered, and reported nothing.
		await page.goto("/nobody-by-this-name");
		await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
		await expect(page.getByText(NO_SUCH_USER)).toHaveCount(0);
	});

	test("a bare @ is not a handle either", async ({ page }) => {
		await page.goto("/@");
		await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
	});

	test("the paths that have actually been mis-linked here now say so", async ({ page }) => {
		// Each of these pointed somewhere real-looking for weeks. `/studio/payouts` is where
		// Connect's onboarding returned creators from the day it was written; `/projects/new`
		// is where the Studio's own "New Project" button pointed after the merge into
		// `apps/web`; `/demo-user` is one of four retired cards on `/resources`.
		for (const path of ["/studio/payouts", "/projects/new", "/demo-user"]) {
			await page.goto(path);
			await expect(
				page.getByRole("heading", { name: NOT_FOUND }),
				`${path} should 404 rather than render a page`,
			).toBeVisible();
		}
	});

	test("a real page still wins over a handle-shaped segment", async ({ page }) => {
		// The other direction: `/about` must keep rendering the About page now that "about"
		// is a claimable username. React Router ranks a static segment above a dynamic one,
		// and this is what says so out loud.
		await page.goto("/about");
		await expect(page.getByRole("heading", { name: NOT_FOUND })).toHaveCount(0);
	});
});

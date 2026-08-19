// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The account menu behind the header avatar — that it opens at all.
 *
 * 🚨 **This spec exists because the avatar was inert from the day it shipped.** Its
 * trigger was a bare `<label>` carrying no `tabIndex` and labelling no control, and
 * daisyUI's dropdown is CSS-only: `.dropdown-content` stays `display:none` until the
 * enclosing `.dropdown` matches `:focus-within`. Nothing could ever focus that label, so
 * clicking the avatar did nothing, and Profile, Settings, Subscription, Purchases and
 * Log out were all unreachable from the header for every signed-in person.
 *
 * Nothing caught it, and the reason is worth keeping: **every one of those destinations
 * has its own passing coverage.** `/settings` is walked by the data-rights spec, the
 * subscription and purchase routes by the ceremony specs. Each page worked perfectly. It
 * was only the door to them that was shut, and a suite that visits pages by `goto` can
 * never see a door — which is why this asserts the *opening*, not the destinations.
 *
 * The close assertion is not a nicety either. daisyUI suppresses pointer events on
 * `[tabindex]:first-child` while the menu is open, so the attribute is what lets the next
 * click land on the page and dismiss it. A trigger that focuses but never releases would
 * satisfy the open assertion alone and trap the menu open.
 */
import { expect, type Page, test } from "@playwright/test";

// Every destination in this menu is also a footer link, so an unscoped `getByRole` matches
// two elements and fails on strict mode. Scope to the header — which is the surface under
// test anyway, and the one the footer copies exist to make reachable in spite of.
const header = (page: Page) => page.getByRole("banner");

test("the header avatar opens the account menu", async ({ page }) => {
	await page.goto("/feed");

	const trigger = header(page).getByRole("button", { name: "Your account" });
	await expect(trigger, "no account button in the header").toBeVisible();

	// The items are in the DOM the whole time — daisyUI hides them with `display:none`
	// rather than unmounting them, so this has to assert visibility. A `toBeAttached`
	// check here would pass against the broken build.
	const profile = header(page).getByRole("link", { name: "Profile" });
	await expect(profile, "the menu was open before anyone clicked it").toBeHidden();

	await trigger.click();
	await expect(profile, "clicking the avatar did not open the account menu").toBeVisible();

	for (const name of ["Subscription", "Purchases", "Settings"]) {
		await expect(header(page).getByRole("link", { name }), `${name} missing`).toBeVisible();
	}
	await expect(header(page).getByRole("button", { name: "Log out" })).toBeVisible();

	// Clicking away must dismiss it; see the note above on why this is load-bearing.
	await page.locator("main").click({ position: { x: 5, y: 5 } });
	await expect(profile, "the account menu would not close again").toBeHidden();
});

test("Profile in the account menu reaches the viewer's own page", async ({ page }) => {
	await page.goto("/feed");

	await header(page).getByRole("button", { name: "Your account" }).click();
	const profile = header(page).getByRole("link", { name: "Profile" });

	// Assert the destination the link actually carries rather than a hardcoded handle:
	// the gauntlet viewer's username is fixture state, and duplicating it here would make
	// this spec fail for a reason that has nothing to do with the header.
	const href = await profile.getAttribute("href");
	expect(href, "Profile pointed at onboarding, so the viewer has no handle").not.toBe("/welcome");

	await profile.click();
	await expect(page).toHaveURL(new RegExp(`${href}$`));
});

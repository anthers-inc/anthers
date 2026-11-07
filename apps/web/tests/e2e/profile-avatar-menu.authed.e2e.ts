// SPDX-License-Identifier: Apache-2.0
/**
 * The avatar's edit menu opens above the page chrome, not inside the profile's stacking
 * context.
 *
 * 🚨 **The bug this pins:** the profile page's root is `relative z-30`, so any dropdown
 * inside it is trapped below the shell's `z-40` sticky header and beside its sidebar,
 * whatever its own `z-index` says. The menu is now portalled to the body as a manual
 * popover, which puts it in the top layer; a menu that goes back inside the page would
 * still look right on a wide screen and disappear under the chrome on a narrow one.
 *
 * Read-only: it opens and closes the fixture creator's own menu and writes nothing.
 */

import { GAUNTLET_CREATOR_USERNAME, gauntletHandle } from "@anthers/db/gauntlet";
import { profileUrl } from "@anthers/web-shared/profile";
import { API_URL, expect, signInAsCreator, test, WEB_ORIGIN } from "./fixtures";

test("the avatar's edit menu is portalled out of the page's stacking context", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	await signInAsCreator(context);
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}`);

	const trigger = page.getByRole("button", { name: "Edit avatar" });
	await expect(trigger).toBeVisible();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");

	await trigger.click();
	const menu = page.getByTestId("image-edit-menu");
	await expect(menu).toBeVisible();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");

	// The portal is the fix: the menu is a child of the body, in the top layer, positioned
	// against the viewport rather than against the page's `relative z-30` ancestor.
	expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);
	expect(await menu.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
	expect(await menu.evaluate((el) => el.matches(":popover-open"))).toBe(true);

	// The items are reachable, and the first one takes focus so the menu is usable from the
	// keyboard as well as the pointer.
	await expect(menu.getByRole("button", { name: "Upload New Image" })).toBeFocused();
	await expect(menu.getByRole("button", { name: "Reposition Image" })).toBeVisible();

	// Escape closes it and hands focus back to the trigger, so the menu is not a keyboard
	// trap standing between a creator and the page.
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

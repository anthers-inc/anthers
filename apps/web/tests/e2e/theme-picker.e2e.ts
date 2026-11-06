// SPDX-License-Identifier: Apache-2.0
/**
 * The marketing shell's theme picker, where a signed-out visitor chooses.
 *
 * ⭐ **The panel leads with the variant toggle and lists the palettes under it** (Parker,
 * 2026-11-06), and every palette carries a swatch of its primary color in the variant on
 * screen. This is the behavior the settings card shares through `ThemePicker`; the card's
 * own spec covers that surface, and this one keeps the signed-out dropdown honest.
 */
import { expect, test } from "@playwright/test";

test("the marketing theme picker leads with the variant, then swatches the palettes", async ({
	page,
}) => {
	await page.goto("/");
	const html = page.locator("html");
	await expect(html).toHaveAttribute("data-theme", "light");

	await page.getByRole("button", { name: "Color theme" }).click();

	const variant = page.getByRole("group", { name: "Variant" });
	const palette = page.getByRole("group", { name: "Palette" });
	await expect(variant).toBeVisible();
	await expect(palette).toBeVisible();
	await expect(variant.getByRole("button")).toHaveCount(2);
	await expect(palette.getByRole("button")).toHaveCount(4);
	await expect(
		palette.getByRole("button", { name: "Reef" }).locator("[data-theme]"),
		"the palette row has no color swatch",
	).toBeVisible();

	// The variant control comes first and applies immediately; the menu stays open so a
	// palette can follow it. The swatches re-render in the chosen variant.
	await variant.getByRole("button", { name: "Dark" }).click();
	await expect(html).toHaveAttribute("data-theme", "dark");
	await expect(variant.getByRole("button", { name: "Dark" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// A palette pick keeps the chosen variant and closes the menu.
	await palette.getByRole("button", { name: "Reef" }).click();
	await expect(html).toHaveAttribute("data-theme", "reef-dark");
	await expect(palette).toBeHidden();

	// Reopening keeps both choices; moving the variant keeps the family, and a palette
	// pick then keeps the new variant.
	await page.getByRole("button", { name: "Color theme" }).click();
	await page.getByRole("group", { name: "Variant" }).getByRole("button", { name: "Light" }).click();
	await expect(html).toHaveAttribute("data-theme", "reef-light");

	await page
		.getByRole("group", { name: "Palette" })
		.getByRole("button", { name: "Meadow" })
		.click();
	await expect(html).toHaveAttribute("data-theme", "light");
});

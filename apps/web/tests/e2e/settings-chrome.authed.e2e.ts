// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in header is for the page in front of you, and the account's theme and
 * sections are settings like the others.
 *
 * ⭐ **The header's account menu and corner theme picker both came out on 2026-10-26**
 * (Parker). Everything the menu held is reachable elsewhere — Settings is a sidebar row —
 * and the theme became a settings card. Both removals are absences, so nothing else in the
 * repository can tell them from a header that merely renders them hidden; that is why the
 * first test is here.
 *
 * ⭐ **The settings sections moved from a row at the top of the page into the sidebar on
 * 2026-11-06** (Parker). The second test pins that shape: the tablist lives inside the
 * `aside`, it carries the seven labels in order, and the page column no longer carries a
 * tab row of its own. The third test is the Experience tab's own behavior: a theme pick
 * reaches the document's `data-theme`, the attribute the whole palette keys on, rather than
 * only the control. It also proves the catalog reaches the card as four families, that the
 * variant toggle comes first, and that a palette pick keeps the variant it was made under.
 */
import { expect, type Page, test } from "@playwright/test";

const header = (page: Page) => page.getByRole("banner");

/** The family a stored value names, for restoring the fixture account's own choice. */
function familyOf(value: string): string {
	if (value === "light" || value === "dark") return "Meadow";
	const prefix = value.split("-")[0];
	return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

test("the signed-in header has neither an account menu nor a theme picker", async ({ page }) => {
	await page.goto("/discovery");
	await expect(header(page).getByRole("button", { name: "Your account" })).toHaveCount(0);
	await expect(header(page).getByRole("button", { name: "Color theme" })).toHaveCount(0);
});

test("the settings sections are a sidebar tablist, not a row at the top of the page", async ({
	page,
}) => {
	await page.goto("/settings");

	const sidebarTabs = page.locator("aside").getByRole("tablist", { name: "Settings sections" });
	await expect(sidebarTabs, "the sidebar carries no settings tablist").toBeVisible();

	const labels = await sidebarTabs.getByRole("tab").allTextContents();
	expect(labels).toEqual([
		"Account",
		"Experience",
		"Badges",
		"Purchases",
		"Identity & Devices",
		"Content & Safety",
		"Activity & Data",
		"Parents",
	]);
	await expect(sidebarTabs.getByRole("tab", { name: "Account" })).toHaveAttribute(
		"aria-selected",
		"true",
	);

	// The page column itself has no tablist left. The sidebar's is the only one on the page.
	await expect(page.getByRole("tablist")).toHaveCount(1);

	// The Creator Tools card was removed from user settings (Parker, 2026-11-06); the
	// Studio is the creator's tool surface and this page no longer advertises a second one.
	await expect(page.getByRole("heading", { name: "Creator Tools" })).toHaveCount(0);

	// Choosing a section writes the URL and selects the sidebar row.
	await sidebarTabs.getByRole("tab", { name: "Experience" }).click();
	await expect(page).toHaveURL(/tab=experience/);
	await expect(sidebarTabs.getByRole("tab", { name: "Experience" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("heading", { name: "Color Theme" })).toBeVisible();
});

test("Badges and Purchases are separate tabs, and each old address lands on its own half", async ({
	page,
}) => {
	await page.goto("/settings?tab=badges");
	await expect(page.getByRole("tab", { name: "Badges", exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("heading", { name: "Badges", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Purchases", exact: true })).toHaveCount(0);

	await page.goto("/settings?tab=purchases");
	await expect(page.getByRole("tab", { name: "Purchases", exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("heading", { name: "Purchases", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Badges", exact: true })).toHaveCount(0);

	// The two old addresses still resolve, each to the half that now owns its subject.
	await page.goto("/badges");
	await expect(page).toHaveURL(/\/settings\?tab=badges$/);
	await page.goto("/purchases");
	await expect(page).toHaveURL(/\/settings\?tab=purchases$/);
});

test("the Experience tab carries the theme card, and a pick changes the document", async ({
	page,
}) => {
	await page.goto("/settings?tab=experience");

	// The Account tab is where the theme used to live; it stays out of that surface.
	await page.goto("/settings?tab=account");
	await expect(page.getByRole("heading", { name: "Color Theme" })).toHaveCount(0);

	await page.goto("/settings?tab=experience");
	const card = page
		.locator(".card")
		.filter({ has: page.getByRole("heading", { name: "Color Theme" }) });
	await expect(card, "the Experience tab has no theme card").toBeVisible();

	// ⭐ The card leads with the variant and lists the palettes under it (Parker,
	// 2026-11-06), the same order the marketing dropdown uses, and each palette carries
	// its primary-color swatch.
	await expect(card).not.toContainText("Applies right away");
	const variantGroup = card.getByRole("group", { name: "Variant" });
	const paletteGroup = card.getByRole("group", { name: "Palette" });
	await expect(variantGroup).toBeVisible();
	await expect(paletteGroup).toBeVisible();

	await expect(variantGroup.getByRole("button")).toHaveCount(2);
	await expect(paletteGroup.getByRole("button")).toHaveCount(4);
	await expect(paletteGroup.getByRole("button", { name: "Meadow" })).toBeVisible();
	await expect(paletteGroup.getByRole("button", { name: "Reef" })).toBeVisible();
	await expect(paletteGroup.getByRole("button", { name: "Ember" })).toBeVisible();
	await expect(paletteGroup.getByRole("button", { name: "Heather" })).toBeVisible();
	await expect(
		paletteGroup.getByRole("button", { name: "Reef" }).locator("[data-theme]"),
		"the palette row has no color swatch",
	).toBeVisible();

	const html = page.locator("html");
	const before = (await html.getAttribute("data-theme")) ?? "light";
	const initialVariant = before.endsWith("dark") ? "Dark" : "Light";
	const otherVariant = initialVariant === "Dark" ? "Light" : "Dark";

	// A palette pick keeps the variant it was made under, and the variant toggle moves
	// the document without changing family.
	await paletteGroup.getByRole("button", { name: "Reef" }).click();
	await expect(html, "choosing Reef did not reach the document").toHaveAttribute(
		"data-theme",
		`reef-${initialVariant.toLowerCase()}`,
	);
	await expect(variantGroup.getByRole("button", { name: initialVariant })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await variantGroup.getByRole("button", { name: otherVariant }).click();
	await expect(html).toHaveAttribute("data-theme", `reef-${otherVariant.toLowerCase()}`);
	await expect(paletteGroup.getByRole("button", { name: "Reef" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Put the account back where it started: this fixture account is shared with every
	// other spec in the authed project, and the choice also saves to the account.
	await paletteGroup.getByRole("button", { name: familyOf(before) }).click();
	await variantGroup.getByRole("button", { name: initialVariant }).click();
	await expect(html).toHaveAttribute("data-theme", before);
});

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
 * only the radio. It also proves the catalog reaches the card as four families, and that
 * choosing one lands on that family's light variant before a variant pick moves it.
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
		"Badges & Purchases",
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

	// ⭐ A theme and a variant are separate choices now (Parker, 2026-11-06), and the
	// old one-line explanation is gone rather than reworded: the controls say what they do.
	await expect(card).not.toContainText("Applies right away");
	const themeGroup = card.getByRole("group", { name: "Theme" });
	const variantGroup = card.getByRole("group", { name: "Variant" });
	await expect(themeGroup).toBeVisible();
	await expect(variantGroup).toBeVisible();

	// The catalog reaches the card as families, not as a Light/Dark list.
	await expect(themeGroup.getByRole("radio")).toHaveCount(4);
	await expect(themeGroup.getByRole("radio", { name: "Meadow" })).toBeVisible();
	await expect(themeGroup.getByRole("radio", { name: "Reef" })).toBeVisible();
	await expect(themeGroup.getByRole("radio", { name: "Ember" })).toBeVisible();
	await expect(themeGroup.getByRole("radio", { name: "Heather" })).toBeVisible();
	await expect(variantGroup.getByRole("radio")).toHaveCount(2);

	const html = page.locator("html");
	const before = (await html.getAttribute("data-theme")) ?? "light";

	// A family pick lands on that family's light variant, and the variant pick moves it
	// without changing family.
	await themeGroup.getByRole("radio", { name: "Reef" }).check();
	await expect(html, "choosing Reef did not reach the document").toHaveAttribute(
		"data-theme",
		"reef-light",
	);
	await expect(variantGroup.getByRole("radio", { name: "Light" })).toBeChecked();

	await variantGroup.getByRole("radio", { name: "Dark" }).check();
	await expect(html).toHaveAttribute("data-theme", "reef-dark");
	await expect(themeGroup.getByRole("radio", { name: "Reef" })).toBeChecked();

	// Put the account back where it started: this fixture account is shared with every
	// other spec in the authed project, and the choice also saves to the account.
	await themeGroup.getByRole("radio", { name: familyOf(before) }).check();
	if (before.endsWith("dark")) {
		await variantGroup.getByRole("radio", { name: "Dark" }).check();
	}
	await expect(html).toHaveAttribute("data-theme", before);
});

// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in header is for the page in front of you, and the account's theme is a
 * setting like the others.
 *
 * ⭐ **The header's account menu and corner theme picker both came out on 2026-10-26**
 * (Parker). Everything the menu held is reachable elsewhere — Settings is a sidebar row,
 * and the account pages' footer carries Badges & Purchases — and the theme became a card
 * on the Account tab beside the account's other preferences. Both removals are absences,
 * so nothing else in the repository can tell them from a header that merely renders them
 * hidden; that is why the first test is here.
 *
 * The second test is the card's own behavior: a pick must reach the document's
 * `data-theme`, the attribute the whole palette keys on, rather than only the radio.
 */
import { expect, type Page, test } from "@playwright/test";

const header = (page: Page) => page.getByRole("banner");

test("the signed-in header has neither an account menu nor a theme picker", async ({ page }) => {
	await page.goto("/discovery");
	await expect(header(page).getByRole("button", { name: "Your account" })).toHaveCount(0);
	await expect(header(page).getByRole("button", { name: "Color theme" })).toHaveCount(0);
});

test("the Account tab carries the theme card, and a pick changes the document", async ({
	page,
}) => {
	await page.goto("/settings");

	const card = page
		.locator(".card")
		.filter({ has: page.getByRole("heading", { name: "Color Theme" }) });
	await expect(card, "the Account tab has no theme card").toBeVisible();

	const html = page.locator("html");
	const before = await html.getAttribute("data-theme");
	const other = before === "dark" ? "Light" : "Dark";

	await card.getByRole("group", { name: other }).getByRole("radio").check();
	await expect(html, `choosing ${other} did not reach the document`).toHaveAttribute(
		"data-theme",
		other.toLowerCase(),
	);
	await expect(card.getByRole("group", { name: other }).getByRole("radio")).toBeChecked();

	// Put the account back where it started: this fixture account is shared with every
	// other spec in the authed project, and the choice also saves to the account.
	const original = before === "dark" ? "Dark" : "Light";
	await card.getByRole("group", { name: original }).getByRole("radio").check();
	await expect(html).toHaveAttribute("data-theme", original.toLowerCase());
});

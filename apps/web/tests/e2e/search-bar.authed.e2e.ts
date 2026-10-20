// SPDX-License-Identifier: Apache-2.0
/**
 * The topbar search, both modes, and the setting that rebinds them.
 *
 * 🚨 **The keys are the feature.** A dropdown that only opens by mouse is the surface
 * people already had; these specs press the chords, cycle with Tab, and close with
 * Escape. The rebind spec is the one that proves the stored preference reaches the
 * listener rather than only the settings card.
 */
import { expect, type Page, test } from "@playwright/test";

// The rebind test changes account state, and `fullyParallel` would let it race the three
// tests that still expect the default chord. Serial keeps the file honest about sharing
// one fixture account.
test.describe.configure({ mode: "serial" });

const header = (page: Page) => page.getByRole("banner");
const input = (page: Page) => header(page).getByRole("combobox");
const listbox = (page: Page) => header(page).getByRole("listbox", { name: "Search results" });

test("Ctrl+K opens global search and finds a creator", async ({ page }) => {
	await page.goto("/feed");
	await expect(header(page).getByRole("button", { name: "Your account" })).toBeVisible();

	await page.keyboard.press("Control+k");
	await expect(input(page), "Ctrl+K did not focus the search bar").toBeFocused();

	await input(page).fill("gauntlet");
	await expect(listbox(page), "the results panel did not open").toBeVisible();
	await expect(listbox(page).getByRole("option").first()).toBeVisible();
	await expect(listbox(page).getByText("Best Matches")).toBeVisible();

	// The list must be reachable and dismissable from the keyboard.
	await page.keyboard.press("ArrowDown");
	await expect(listbox(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Escape");
	await expect(listbox(page)).toBeHidden();
});

test("a query with no name matches appends the slower body stage", async ({ page }) => {
	await page.goto("/feed");
	await page.keyboard.press("Control+k");
	// No creator or title says "free"; the free post's body does, so only the second
	// stage can answer — and it arrives under its own heading rather than as one list
	// that silently changed.
	await input(page).fill("free");
	await expect(listbox(page).getByText("More Results")).toBeVisible();
	await expect(listbox(page).getByText("Anyone can read this")).toBeVisible();
});

test("Tab cycles the type filter", async ({ page }) => {
	await page.goto("/feed");
	await page.keyboard.press("Control+k");
	await input(page).fill("gauntlet");
	await expect(listbox(page)).toBeVisible();

	const chips = header(page).getByRole("toolbar", { name: "Search types" });
	await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

	await page.keyboard.press("Tab");
	await expect(chips.getByRole("button", { name: "Creators" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.keyboard.press("Shift+Tab");
	await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

	// Backwards from All wraps to Settings, which is the local-only half of the index.
	await page.keyboard.press("Shift+Tab");
	await expect(chips.getByRole("button", { name: "Settings" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await input(page).fill("keyboard");
	await expect(listbox(page).getByText("Keyboard Shortcuts")).toBeVisible();
});

test("Ctrl+F on the Library filters the shelf and Escape restores it", async ({ page }) => {
	await page.goto("/library");
	// The view declares itself filterable when it mounts, not when the header does; the
	// page is lazy, so the heading is the signal that there is a view to filter.
	await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();

	await page.keyboard.press("Control+f");
	await expect(input(page), "Ctrl+F did not focus the search bar").toBeFocused();
	await expect(input(page), "the placeholder did not switch to Filter").toHaveAttribute(
		"placeholder",
		"Filter...",
	);

	await input(page).fill("zzzz-no-such-item");
	await expect(page).toHaveURL(/[?&]q=zzzz-no-such-item/);
	await expect(page.getByText("No matches in your Library")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page).not.toHaveURL(/[?&]q=/);

	// The toggle is the mouse path to the same two states, and it keeps focus in the input.
	await header(page)
		.getByRole("button", { name: /Filter/ })
		.click();
	await expect(input(page)).toBeFocused();
	await expect(input(page)).toHaveAttribute("placeholder", "Filter...");
	await header(page)
		.getByRole("button", { name: /Search/ })
		.click();
	await expect(input(page)).toHaveAttribute("placeholder", "Search...");
});

test("a rebound Search shortcut is the one the bar listens for", async ({ page }) => {
	await page.goto("/settings?tab=account");
	const card = page.locator(".card", {
		has: page.getByRole("heading", { name: "Keyboard Shortcuts" }),
	});
	await expect(card).toBeVisible();

	const patched = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/accounts/me") && response.request().method() === "PATCH",
	);
	await card.getByRole("button", { name: "Change" }).first().click();
	await page.keyboard.press("Alt+s");
	await patched;
	await expect(card.locator("kbd").first()).toHaveText(/Alt\+S/);

	const authed = page.waitForResponse(
		(response) => response.url().includes("/api/auth/me") && response.status() === 200,
	);
	await page.goto("/feed");
	await authed;
	// The response resolves a tick before React re-renders with it; the toggle's printed
	// chord is the signal that the bar itself has the stored map, not just the loader.
	const searchToggle = header(page).locator("kbd").first();
	await expect(searchToggle, "the account's rebound chord did not reach the bar").toHaveText(
		"Alt+S",
	);
	await page.keyboard.press("Alt+s");
	await expect(input(page), "the rebound chord did not open the bar").toBeFocused();
	await page.keyboard.press("Escape");

	// Put the fixture account back where it started; the shortcut is account state and
	// the rest of this session shares the account.
	await page.goto("/settings?tab=account");
	const again = page.locator(".card", {
		has: page.getByRole("heading", { name: "Keyboard Shortcuts" }),
	});
	const restored = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/accounts/me") && response.request().method() === "PATCH",
	);
	await again.getByRole("button", { name: "Reset" }).first().click();
	await restored;
	await expect(again.locator("kbd").first()).toHaveText(/Ctrl\+K|⌘K/);
});

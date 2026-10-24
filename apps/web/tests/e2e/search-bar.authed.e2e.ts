// SPDX-License-Identifier: Apache-2.0
/**
 * The topbar search, both modes, and the setting that rebinds them.
 *
 * 🚨 **The keys are the feature.** A dropdown that only opens by mouse is the surface
 * people already had; these specs press the chords, cycle with Tab, and close with
 * Escape. The rebind spec is the one that proves the stored preference reaches the
 * listener rather than only the settings card.
 *
 * 🚨 **This is the only spec file that touches the account's shortcut map.** The authed
 * project shares one fixture account, so a reader in another file races a rebind here
 * exactly as a second writer would; `serial` orders this file's own tests and nothing
 * more. Every spec that presses or asserts a stored chord belongs here, including the
 * sidebar's toggle, rather than in the spec that owns the surface the chord moves.
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
	await page.goto("/network");
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
	await page.goto("/network");
	await page.keyboard.press("Control+k");
	// No creator or title says "free"; the free post's body does, so only the second
	// stage can answer — and it arrives under its own heading rather than as one list
	// that silently changed.
	await input(page).fill("free");
	await expect(listbox(page).getByText("More Results")).toBeVisible();
	// A Work and its announcement share a title in the gauntlet fixture, so the same
	// words legitimately appear twice, distinguished by their type chips.
	await expect(listbox(page).getByText("Anyone can read this").first()).toBeVisible();
});

test("Tab cycles the type filter", async ({ page }) => {
	await page.goto("/network");
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

/**
 * The sidebar's own key is pinned here rather than in `sidebar-rail.authed.e2e.ts`, because
 * this file owns the account's shortcut map and nothing else may read it while a rebind is
 * in flight. The rail is where this chord is easiest to see: the aside's width says which
 * state the key put it in, with no drawer animation in the way.
 */
test("Ctrl+/ toggles the sidebar, even with a text field focused", async ({ page }) => {
	test.setTimeout(60_000);
	const asideWidth = () =>
		page.evaluate(() =>
			Math.round(document.querySelector("aside")?.getBoundingClientRect().width ?? -1),
		);

	await page.goto("/network");
	await expect.poll(asideWidth).toBe(256);

	// Ctrl+K puts the caret in the search field, which is the state the sidebar's key has
	// to survive: a page shortcut normally skips an editor, and this one does not.
	await page.keyboard.press("Control+k");
	const search = header(page).getByRole("combobox");
	await expect(search).toBeFocused();

	await page.keyboard.press("Control+/");
	await expect.poll(asideWidth, { message: "Ctrl+/ did not collapse the sidebar" }).toBe(64);
	await expect(search, "the toggle took the caret out of the field").toBeFocused();

	await page.keyboard.press("Control+/");
	await expect.poll(asideWidth, { message: "Ctrl+/ did not open it again" }).toBe(256);

	// The account's card offers the chord, which is where a person rebinds it.
	await page.goto("/settings?tab=account");
	const row = page
		.locator(".card", { has: page.getByRole("heading", { name: "Keyboard Shortcuts" }) })
		.locator(".flex-wrap")
		.filter({ hasText: "Toggle the sidebar" });
	await expect(row).toBeVisible();
	await expect(row.locator("kbd")).toHaveText(/Ctrl\+\/|⌃\//);
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
	await page.goto("/network");
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

/**
 * The sidebar's toggle is the card's third page shortcut, and it is the one whose binding
 * the *layout* reads rather than a component in the header — so this is the test that
 * proves a stored chord reaches the listener, not only the card that wrote it. It lives
 * here because this file owns the account's shortcut map; a reader in another file races
 * a rebind in flight just as surely as a second writer would.
 */
test("a rebound sidebar shortcut is the one the layout listens for", async ({ page }) => {
	const card = () =>
		page.locator(".card", { has: page.getByRole("heading", { name: "Keyboard Shortcuts" }) });
	const row = () => card().locator(".flex-wrap").filter({ hasText: "Toggle the sidebar" });
	const asideWidth = () =>
		page.evaluate(() =>
			Math.round(document.querySelector("aside")?.getBoundingClientRect().width ?? -1),
		);

	await page.goto("/settings?tab=account");
	await expect(row()).toBeVisible();
	await expect(row().locator("kbd")).toHaveText(/Ctrl\+\/|⌃\//);

	const patched = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/accounts/me") && response.request().method() === "PATCH",
	);
	await row().getByRole("button", { name: "Change" }).click();
	await page.keyboard.press("Alt+j");
	await patched;
	await expect(row().locator("kbd")).toHaveText(/Alt\+J/);

	const authed = page.waitForResponse(
		(response) => response.url().includes("/api/auth/me") && response.status() === 200,
	);
	await page.goto("/network");
	await authed;
	await expect.poll(asideWidth).toBe(256);

	await page.keyboard.press("Alt+j");
	await expect
		.poll(asideWidth, { message: "the account's rebound chord did not reach the layout" })
		.toBe(64);
	// The chord it replaced is the browser's again rather than a second binding.
	await page.keyboard.press("Control+/");
	await page.waitForTimeout(250);
	expect(await asideWidth(), "the default chord still toggled the sidebar").toBe(64);

	// Put the fixture account back where it started; the shortcut is account state and
	// the rest of this session shares the account.
	await page.goto("/settings?tab=account");
	const restored = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/accounts/me") && response.request().method() === "PATCH",
	);
	await row().getByRole("button", { name: "Reset" }).click();
	await restored;
	await expect(row().locator("kbd")).toHaveText(/Ctrl\+\/|⌃\//);
});

// SPDX-License-Identifier: Apache-2.0
/**
 * The merged Discovery tab's recipe memory (Parker, 2026-10-24).
 *
 * 🚨 **The account is the default layer and the URL is the override.** That two-layer
 * rule is the whole reason Network could retire: a reader who wants the chronological
 * feed chooses My Network once and keeps it across devices and sessions, while a link
 * that names a recipe answers that visit alone. A regression in either direction is
 * invisible to a source-text guard — one makes a stranger's shared link rewrite what
 * somebody opens on, the other makes the choice evaporate on the next visit — so both
 * are clicked here, in a browser.
 *
 * ⚠️ **The walker account is shared with every authed spec**, and the feed's own specs
 * read the network stream. This file writes the recipe and restores My Network on both
 * the success and failure paths.
 */
import { expect, test } from "@playwright/test";
import { API_URL, WEB_ORIGIN } from "./fixtures";

const chip = (page: import("@playwright/test").Page, name: string) =>
	page.getByRole("button", { name, exact: true });

const MY_NETWORK = { window: "all", candidates: "network", mix: "straight" };

/** The account's opening recipe, written through the same route the page uses. */
const setRecipe = (request: import("@playwright/test").APIRequestContext, data: unknown) =>
	request.patch(`${API_URL}/api/accounts/me`, {
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		data: { homeRecipe: data },
	});

/** The account's saved recipes, written whole the way the page writes them. */
const setSaved = (request: import("@playwright/test").APIRequestContext, rows: unknown[]) =>
	request.patch(`${API_URL}/api/accounts/me`, {
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		data: { savedRecipes: rows },
	});

/** The chips row, in render order. */
const chips = (page: import("@playwright/test").Page) =>
	page.getByRole("group", { name: "Recipes" }).getByRole("button");

/** The trailing chip that saves whatever recipe is on screen. */
const saveChip = (page: import("@playwright/test").Page) =>
	page.getByRole("group", { name: "Recipes" }).getByRole("button", { name: "Save recipe" });

test.describe.configure({ mode: "serial" });

test("a chosen recipe is remembered, and a link is only an override", async ({ page }) => {
	test.setTimeout(90_000);
	// Start from the preset rather than from whatever a previous run left behind.
	expect((await setRecipe(page.request, MY_NETWORK)).status()).toBe(200);

	await page.goto(`${WEB_ORIGIN}/discovery`);
	await expect(chip(page, "My Network")).toHaveAttribute("aria-pressed", "true");

	// Choosing a preset writes the whole recipe to the account, not just the stages that
	// differ from a built-in default.
	const saved = page.waitForResponse(
		(r) => r.url().endsWith("/api/accounts/me") && r.request().method() === "PATCH",
	);
	await chip(page, "Across Anthers").click();
	const save = await saved;
	await expect(chip(page, "Across Anthers")).toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL(/candidates=everyone/);
	expect(save.request().postDataJSON().homeRecipe).toEqual({
		window: "all",
		candidates: "everyone",
		mix: "spread",
	});

	// Sticky: a bare visit opens on what was chosen, across a fresh navigation.
	await page.goto(`${WEB_ORIGIN}/discovery`);
	await expect(chip(page, "Across Anthers")).toHaveAttribute("aria-pressed", "true");

	// A link that names a recipe answers that visit — and does not rewrite the account.
	await page.goto(`${WEB_ORIGIN}/discovery?window=all&candidates=network&mix=straight`);
	await expect(chip(page, "My Network")).toHaveAttribute("aria-pressed", "true");
	await page.goto(`${WEB_ORIGIN}/discovery`);
	await expect(chip(page, "Across Anthers")).toHaveAttribute("aria-pressed", "true");

	// A hand-set stage leaves every chip unlit rather than lighting the nearest one: a
	// chip promises it will reproduce its recipe, and this combination is not one.
	await page.getByLabel("Window").selectOption("week");
	await expect(chip(page, "Across Anthers")).toHaveAttribute("aria-pressed", "false");
	await expect(chip(page, "My Network")).toHaveAttribute("aria-pressed", "false");
	// That change is the reader's, so it is the one that reaches the account.
	await page.goto(`${WEB_ORIGIN}/discovery`);
	await expect(page.getByLabel("Window")).toHaveValue("week");
});

test("a saved recipe is named, colored, renamed and remembered", async ({ page }) => {
	test.setTimeout(120_000);
	// The saved list is this file's state, like the opening recipe above: start from none.
	expect((await setSaved(page.request, [])).status()).toBe(200);

	// A hand-built recipe: no chip names it, so the save affordance is offered.
	await page.goto(`${WEB_ORIGIN}/discovery?window=week&candidates=following&mix=straight`);
	await expect(chip(page, "My Network")).toHaveAttribute("aria-pressed", "false");
	await saveChip(page).click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const name = dialog.getByLabel("Name");
	// The suggestion names the candidate stage, so the field is useful before it is edited.
	await expect(name).toHaveValue("Creators I follow");
	await name.fill("Close friends");
	// The control is `sr-only` inside its swatch label, so the visible circle — the label
	// carrying the color's name — is what a reader clicks.
	await dialog.getByTitle("Rose").click();
	await dialog.getByRole("button", { name: "Save recipe" }).click();

	// The chip is the visible result of the save, and it is the active one.
	const saved = chip(page, "Close friends");
	await expect(saved).toHaveAttribute("aria-pressed", "true");
	await expect(dialog).toBeHidden();

	// Sticky like the built-ins: the list rides the account, so a fresh visit has it.
	await page.goto(`${WEB_ORIGIN}/discovery?window=week&candidates=following&mix=straight`);
	await expect(chip(page, "Close friends")).toHaveAttribute("aria-pressed", "true");

	// Rename and recolor from the pencil the active saved chip earns.
	await page.getByRole("button", { name: "Edit Close friends" }).click();
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Name").fill("Inner circle");
	await dialog.getByTitle("Sky").click();
	await dialog.getByRole("button", { name: "Save", exact: true }).click();

	await expect(chip(page, "Inner circle")).toHaveAttribute("aria-pressed", "true");
	await expect(chip(page, "Close friends")).toHaveCount(0);
	// The color is an accent on a stored token rather than a hex value: read the chip back
	// from the API so a palette change cannot silently rewrite a saved choice.
	const me = await (
		await page.request.get(`${API_URL}/api/accounts/me`, { headers: { Origin: WEB_ORIGIN } })
	).json();
	expect(me.user.savedRecipes).toEqual([
		{
			id: expect.any(String),
			label: "Inner circle",
			color: "sky",
			recipe: { window: "week", candidates: "following", mix: "straight" },
		},
	]);
});

test("saved recipes reorder, delete and join the keyboard cycle", async ({ page }) => {
	test.setTimeout(120_000);

	// Second recipe, from a different combination, so the two chips are distinguishable.
	await page.goto(`${WEB_ORIGIN}/discovery?window=all&candidates=saved&mix=spread`);
	await saveChip(page).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Saved collection");
	await dialog.getByRole("button", { name: "Save recipe" }).click();
	await expect(chip(page, "Saved collection")).toHaveAttribute("aria-pressed", "true");

	// Built-ins first, then the reader's own in their order.
	await expect(chips(page)).toHaveText([
		"My Network",
		"Across Anthers",
		"Inner circle",
		"Saved collection",
	]);

	// The cycle steps through both kinds, and wraps.
	await page.goto(`${WEB_ORIGIN}/discovery?window=all&candidates=network&mix=straight`);
	await expect(chip(page, "My Network")).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("Control+]");
	await expect(chip(page, "Across Anthers")).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("Control+]");
	await expect(chip(page, "Inner circle")).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("Control+]");
	await expect(chip(page, "Saved collection")).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("Control+]");
	await expect(chip(page, "My Network"), "the cycle wraps to the first chip").toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.keyboard.press("Control+[");
	await expect(chip(page, "Saved collection"), "the previous chord wraps backward").toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Reorder: earlier means the chip renders before the other saved one, not before a preset.
	await page.getByRole("button", { name: "Edit Saved collection" }).click();
	await page.getByRole("button", { name: "Move earlier" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(chips(page)).toHaveText([
		"My Network",
		"Across Anthers",
		"Saved collection",
		"Inner circle",
	]);

	// Delete is two-step, and the recipe itself stays on screen as a hand-built one.
	await chip(page, "Inner circle").click();
	await page.getByRole("button", { name: "Edit Inner circle" }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await page.getByRole("button", { name: "Delete for good?" }).click();
	await expect(chip(page, "Inner circle")).toHaveCount(0);
	await expect(saveChip(page)).toBeVisible();
});

test.afterAll(async ({ browser }) => {
	// The restore above runs only if the test reaches its end; this is the same write on
	// the failure path. The context carries the walker's own session cookie.
	const context = await browser.newContext({
		storageState: "tests/e2e/.auth/gauntlet-walker.json",
	});
	await setRecipe(context.request, MY_NETWORK);
	await setSaved(context.request, []);
	await context.close();
});

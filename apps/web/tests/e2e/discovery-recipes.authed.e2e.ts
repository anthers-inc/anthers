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
	await expect(chip(page, "Across Anthers")).toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL(/candidates=everyone/);
	expect((await saved.request().postDataJSON()).homeRecipe).toEqual({
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

test.afterAll(async ({ browser }) => {
	// The restore above runs only if the test reaches its end; this is the same write on
	// the failure path. The context carries the walker's own session cookie.
	const context = await browser.newContext({
		storageState: "tests/e2e/.auth/gauntlet-walker.json",
	});
	await setRecipe(context.request, MY_NETWORK);
	await context.close();
});

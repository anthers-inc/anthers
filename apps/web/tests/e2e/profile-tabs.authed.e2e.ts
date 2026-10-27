// SPDX-License-Identifier: Apache-2.0
/**
 * A creator's profile tabs: three groups, and a default that depends on who is reading.
 *
 * ⭐ **The row is grouped three ways** (Parker, 2026-10-27): the creator's own Dashboard
 * alone, the profile's own surfaces (Badges, Credits), and everything the creator has put
 * out (All Content, Posts, then a view per released Work type). The groups are visual only —
 * no tab behaves differently for the group it sits in — so what a spec can pin is the rules
 * that draw them and the one piece of behavior that does follow the grouping: the creator
 * lands on their Dashboard, a visitor on All Content.
 *
 * Read-only: it walks the fixture accounts' profiles and writes nothing.
 */

import {
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_WALKER_USERNAME,
	gauntletHandle,
} from "@anthers/db/gauntlet";
import { profileUrl } from "@anthers/web-shared/profile";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

/**
 * The tab row as a reader sees it left to right, with each group rule as a `|`. Read from the
 * row's own children rather than from screenshots, so a divider that moves is caught.
 */
async function rowShape(page: import("@playwright/test").Page): Promise<string[]> {
	return page
		.locator(".tabs.tabs-bordered")
		.evaluate((row) =>
			[...row.children].map((child) =>
				child.getAttribute("aria-hidden") === "true" ? "|" : (child.textContent ?? "").trim(),
			),
		);
}

test("the creator's own profile opens on the Dashboard", async ({ page }) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, GAUNTLET_WALKER_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}`);

	// The Dashboard's own heading is the strongest marker: the panel is mounted, not merely
	// the tab highlighted.
	await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toHaveClass(
		/tab-active/,
	);

	// And the group rules stand where the grouping says: after the Dashboard, and after
	// Credits to open the content group.
	const shape = await rowShape(page);
	expect(shape.slice(0, 3), "the Dashboard is not alone in the leading group").toEqual([
		"Dashboard",
		"|",
		"Badges",
	]);
	expect(shape[shape.indexOf("Credits") + 1], "Credits does not close its group").toBe("|");
});

test("a visitor's profile opens on All Content, and the Dashboard is not a door", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);

	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}`);
	await expect(page.getByRole("button", { name: "All Content", exact: true })).toHaveClass(
		/tab-active/,
	);
	// The creator's own tab is absent from a visitor's row entirely, and the row therefore
	// opens on Badges — with one rule, between the two content-side groups.
	await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toHaveCount(0);
	const shape = await rowShape(page);
	expect(shape.slice(0, 3), "a visitor's row does not open on the profile's own group").toEqual([
		"Badges",
		"Credits",
		"|",
	]);
	expect(
		shape.filter((part) => part === "|"),
		"a visitor's row carries more than the one group rule",
	).toHaveLength(1);

	// A query parameter is not a way around an absent tab.
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=dashboard`);
	await expect(page.getByRole("button", { name: "All Content", exact: true })).toHaveClass(
		/tab-active/,
	);
	await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toHaveCount(0);
});

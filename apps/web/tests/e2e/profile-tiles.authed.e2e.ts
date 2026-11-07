// SPDX-License-Identifier: Apache-2.0
/**
 * The creator profile's timeline renders the feed's tiles — the widget-uniformity
 * swap of 2026-10-17, walked in a browser.
 *
 * The profile used to render its own card family (`WorkCard`/`PostCard`), whose
 * fallbacks printed a literal "?" wherever a creator's avatar or name was missing,
 * because the catalog route attaches no per-work `creator` and the page is the join.
 * The page now renders `FeedTile` and splices the profile's own creator into every
 * entry, so the regression this spec pins is exactly that: a tile on a creator's
 * own page must never carry a "?" — not in the meta row, not as an avatar fallback —
 * and the project renders the tile's own album shape, so one grid holds every kind.
 *
 * Read-only: every Work and post it reads belongs to the fixture creators, which
 * nothing here seeds or deletes.
 */

import {
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_WALKER_USERNAME,
	gauntletHandle,
} from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { profileUrl } from "@anthers/web-shared/profile";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

const tiles = (page: import("@playwright/test").Page) => page.locator("[data-testid='feed-tile']");

test("the profile's timeline renders the feed's tiles carrying the creator's own identity", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, MEDIA_FIXTURE_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}`);

	// Nine fixture Works of six types, so the timeline carries several tiles.
	await expect(tiles(page).first(), "the timeline carries the feed's tiles").toBeVisible();
	expect(await tiles(page).count()).toBeGreaterThan(3);

	for (const tile of await tiles(page).all()) {
		const text = await tile.textContent();
		// The meta row names the creator — the splice's whole point. The pre-swap
		// cards read "?" here whenever the listing's creator join was missing.
		expect(text, "every tile names its creator").toContain("Media Fixture");
		expect(text, "no tile renders the missing-creator fallback").not.toContain("?");
	}

	// The album Project renders the same tile family's project shape and keeps its chip.
	const project = tiles(page).filter({ hasText: "An album that really plays" });
	await expect(project, "the project renders the shared tile").toHaveCount(1);
	await expect(project).toContainText("Project");
});

test("the timeline splits into month sections, each with a heading and a rule", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}`);

	const sections = page.locator("[data-testid='content-month']");
	const headings = page.locator("[data-testid='content-month-heading']");
	await expect(sections.first(), "the timeline renders month sections").toBeVisible();

	// Every tile sits inside a section: the flat run of tiles is gone rather than
	// merely decorated with headings beside it.
	expect(await sections.locator("[data-testid='feed-tile']").count()).toBe(
		await tiles(page).count(),
	);

	// One heading and one rule per section, and the heading names a real month.
	expect(await headings.count()).toBe(await sections.count());
	expect(await page.locator("[data-testid='content-month-rule']").count()).toBe(
		await sections.count(),
	);
	await expect(headings.first()).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
});

test("the posts tab renders the same tiles", async ({ page }) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=posts`);

	await expect(tiles(page).first(), "the posts tab carries tiles").toBeVisible();
	expect(await tiles(page).count()).toBeGreaterThan(0);
	await expect(
		page.locator("[data-testid='content-month-heading']").first(),
		"the posts tab groups by month too",
	).toBeVisible();
	for (const tile of await tiles(page).all()) {
		const text = await tile.textContent();
		expect(text, "every post tile names its creator").toContain("Gauntlet Creator");
		expect(text, "no post tile renders the missing-creator fallback").not.toContain("?");
	}
});

/**
 * The create tile is the owner's, and it leads the grid whether the profile has content
 * or not: the walker's own profile is the owner surface this suite can visit.
 */
test("the creator's own profile leads with a create tile", async ({ page }) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, GAUNTLET_WALKER_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}`);

	const tile = page.getByTestId("profile-create-tile");
	await expect(tile).toBeVisible();
	await expect(tile).toContainText("New Content");
	// It leads the grid: the first child of the first month's grid, or the only child of
	// the bare grid a profile with nothing renders. This walker may carry content from
	// other walks, so both shapes are legitimate here.
	const grid = page.locator("[data-testid='content-month'] .grid").first();
	if ((await grid.count()) > 0) {
		await expect(
			grid.locator(":scope > *").first().getByTestId("profile-create-tile"),
		).toBeVisible();
	}

	await tile.click();
	const menu = page.getByRole("menu", { name: "New content" });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "New Post" })).toHaveAttribute(
		"href",
		"/studio/posts/new",
	);
	await expect(menu.getByRole("menuitem", { name: "New Work" })).toHaveAttribute(
		"href",
		"/studio/works/new",
	);
	// The menu's backdrop is the click-outside dismiss; close it before switching tabs.
	await page.getByRole("button", { name: "Close the new content menu" }).click();
	await expect(menu).toHaveCount(0);

	// The Posts tab's tile is the direct one: one destination, named for the tab.
	await page.getByRole("button", { name: "Posts", exact: true }).click();
	await expect(page.getByTestId("profile-create-tile")).toContainText("New Post");
	await expect(page.getByTestId("profile-create-tile")).toHaveAttribute(
		"href",
		"/studio/posts/new",
	);
});

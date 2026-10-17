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
 * and the project, which has no tile shape, stays on ProjectCard.
 *
 * Read-only: every Work and post it reads belongs to the fixture creators, which
 * nothing here seeds or deletes.
 */

import { GAUNTLET_CREATOR_USERNAME, gauntletHandle } from "@anthers/db/gauntlet";
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

	// The album Project has no tile shape: it stays the column card and keeps its chip.
	const project = page.locator(".card").filter({ hasText: "An album that really plays" });
	await expect(project, "the project stays on ProjectCard").toHaveCount(1);
	await expect(project).toContainText("Project");
});

test("the posts tab renders the same tiles", async ({ page }) => {
	test.setTimeout(60_000);
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=posts`);

	await expect(tiles(page).first(), "the posts tab carries tiles").toBeVisible();
	expect(await tiles(page).count()).toBeGreaterThan(0);
	for (const tile of await tiles(page).all()) {
		const text = await tile.textContent();
		expect(text, "every post tile names its creator").toContain("Gauntlet Creator");
		expect(text, "no post tile renders the missing-creator fallback").not.toContain("?");
	}
});

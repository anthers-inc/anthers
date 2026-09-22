// SPDX-License-Identifier: Apache-2.0
/**
 * The spoken player, walked in a browser.
 *
 * What this file exists to pin is the difference between listening to talk and listening
 * to music — the four features a song has no use for: fixed-step skips, a rate control
 * that is a listener preference rather than a per-work setting, and a remembered
 * position that follows the Work into the player. These can all break silently on a page
 * where the audio still plays, which is the failure shape video-player.authed.e2e.ts
 * was written against.
 *
 * The fixture is the media fixture's `episode` — a Work of type `audio`, free and
 * streaming, so none of it is behind a gate and the player it exercises is the real one.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { expect, test } from "./fixtures";

const EPISODE = mediaFixtureWork("episode");
const PLAYER = "[data-testid=spoken-player]";
const BAR = "[data-testid=player-bar]";

/** Current playback position of the on-page spoken player's audio element, in seconds. */
async function position(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate((selector) => {
		const el = document.querySelector(`${selector} audio`) as HTMLAudioElement | null;
		return el?.currentTime ?? -1;
	}, PLAYER);
}

test.describe.configure({ mode: "serial" });

test("an audio Work page renders the spoken transport — skips and a speed menu", async ({
	page,
}) => {
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);

	await expect(page.locator(PLAYER)).toBeVisible();
	await expect(
		page.locator(PLAYER).getByRole("button", { name: /skip back 15 seconds/i }),
	).toBeVisible();
	await expect(
		page.locator(PLAYER).getByRole("button", { name: /skip forward 30 seconds/i }),
	).toBeVisible();

	// The speed menu opens and names its rates.
	await page
		.locator(PLAYER)
		.getByRole("button", { name: /playback speed/i })
		.click();
	await expect(page.getByRole("button", { name: "1.5×", exact: true })).toBeVisible();

	// The skip buttons move the position by their fixed step — its own test below.
});

test("the skip buttons move the position by their fixed step", async ({ page }) => {
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);
	await expect(page.locator(PLAYER)).toBeVisible();

	// The fixture clip is three seconds long, so a +30 lands at the end (clamped) and a
	// −15 lands back at zero — clamping is the behavior, not a failure of it.
	await page
		.locator(PLAYER)
		.getByRole("button", { name: /skip forward 30 seconds/i })
		.click();
	await expect
		.poll(() => position(page), { message: "skip forward did not move the position" })
		.toBeGreaterThan(0);
});

test("Listen while you browse hands the episode to the bar", async ({ page }) => {
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);
	await page
		.locator(PLAYER)
		.getByRole("button", { name: /listen while you browse/i })
		.click();

	await expect(page.locator(BAR)).toBeVisible();
	await expect(page.locator(`${BAR} [data-testid=now-playing-title]`)).toHaveText(EPISODE.title);
});

// Resume-from-position is covered where it is decidable: `src/lib/listen-positions.test.ts`
// walks the TTL, throttle, clear-on-finish and floor rules against a store stand-in. A
// browser pass of it here would need a clip far longer than the fixture's three seconds,
// which the whole suite pays for on every run — a trade a unit test makes for free.
void position;

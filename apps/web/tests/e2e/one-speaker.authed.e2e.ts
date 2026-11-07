// SPDX-License-Identifier: Apache-2.0
/**
 * One speaker at a time: the persistent bar and a page video stop each other.
 *
 * 🚨 **The bug this walks:** the bar owns a detached `<audio>`, every page player owns its
 * own element, and nothing arbitrated between them, so pressing play on a video left the
 * music running underneath it. The rule now lives in `apps/web/src/lib/playback.ts`; its
 * registry logic is covered cheaply in `playback.test.ts`, and this spec proves the players
 * that matter in a real browser are actually wired to it.
 *
 * ⚠️ **The fixture's tracks are three seconds long**, so the walk holds the bar paused
 * across the navigation rather than racing the track to the video page, and every resume
 * is the one assertion before the next click. The state is read from each surface's own
 * control rather than from the elements: the bar's `<audio>` is never in the document,
 * which is the tautology `music-player.authed` documents.
 *
 * Read-only: both Works belong to the media fixture, which nothing resets.
 */

import {
	MEDIA_FIXTURE_PROJECT,
	MEDIA_FIXTURE_USERNAME,
	mediaFixtureWork,
} from "@anthers/db/media-fixture";
import { creatorProjectUrl } from "@anthers/web-shared/profile";
import type { Page } from "@playwright/test";
import { expect, test, WEB_ORIGIN } from "./fixtures";

const ALBUM_URL = `${WEB_ORIGIN}${creatorProjectUrl(MEDIA_FIXTURE_USERNAME, MEDIA_FIXTURE_PROJECT.slug)}`;
const CLIP = mediaFixtureWork("video");
const BAR = "[data-testid=player-bar]";
const VIDEO_CONTROLS = "[data-testid=video-controls]";

/** The video's real duration, i.e. HLS attached rather than a dead source reporting paused. */
const videoDuration = (page: Page) =>
	page.evaluate(() => document.querySelector("video")?.duration ?? 0);

test("starting a video stops the bar, and the bar stops the video", async ({ page }) => {
	test.setTimeout(60_000);

	// Put one track in the bar and hold it paused, so the three-second fixture does not end
	// the queue while the page changes.
	await page.goto(ALBUM_URL);
	await page.getByRole("button", { name: "Play", exact: true }).first().click();
	const bar = page.locator(BAR);
	await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
	await bar.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();

	// ⚠️ **Navigate in-app, never with `page.goto`**: a full load remounts the provider and
	// the queue would be gone, and the bug is about a bar that survives routing. The search
	// result is an ordinary client-side link.
	await page.keyboard.press("Control+k");
	await page
		.getByRole("combobox", { name: "Search Anthers" })
		.fill("A short film that really plays");
	const results = page.getByRole("listbox", { name: "Search results" });
	await expect(results.getByRole("option").first()).toBeVisible();
	await results.getByRole("option").first().click();
	await expect(page.getByRole("heading", { name: CLIP.title, level: 1 })).toBeVisible();
	await expect(page.locator("video")).toBeVisible();
	await expect
		.poll(() => videoDuration(page), { timeout: 15_000, message: "HLS never attached" })
		.toBeGreaterThan(0);
	// The bar survives the route change, which is the whole premise of the bug.
	await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();

	// The music starts: the video is still, then the picture starts and the music yields.
	const controls = page.locator(VIDEO_CONTROLS);
	await bar.getByRole("button", { name: "Play", exact: true }).click();
	await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
	await controls.getByRole("button", { name: "Play", exact: true }).click();
	await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();

	// And the rule runs both ways: pressing play on the bar stops the picture's sound
	// mid-play, not by letting the clip run out.
	await bar.getByRole("button", { name: "Play", exact: true }).click();
	await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const video = document.querySelector("video");
				return video ? { paused: video.paused, ended: video.ended } : null;
			}),
		)
		.toEqual({ paused: true, ended: false });
});

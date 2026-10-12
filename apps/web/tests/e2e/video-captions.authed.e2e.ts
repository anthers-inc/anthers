// SPDX-License-Identifier: Apache-2.0
/**
 * Caption tracks on the video player, walked in a browser — the captions task.
 *
 * The fixture video carries an English WebVTT the media-fixture seed attaches (the seed
 * script, through the real attach service), so what walks here is the whole pipe: payload,
 * `<track>` children, the settings menu'sCaptions section, the `c` shortcut, and the shared
 * on/off preference.
 *
 * The **preference is the third test** and asserts on text-track MODES off the element —
 * a menu item highlighting its choice while the track stays disabled is precisely the
 * silent failure a CC affordance can commit, because the video keeps playing either way.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const CLIP = mediaFixtureWork("video");
const CONTROLS = "[data-testid=video-controls]";

/** Open the clip and wait for a real duration — i.e. HLS actually attached. */
async function openPlayer(page: Page) {
	await page.goto(`/works/${CLIP.slug}-${CLIP.publicId}`);
	await expect(page.locator("video")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => document.querySelector("video")?.duration ?? 0), {
			timeout: 15_000,
			message: "the video never reported a duration — HLS did not attach",
		})
		.toBeGreaterThan(0);
}

/** The text tracks off the element, as modes — the thing a CC control actually drives. */
const captionModes = (page: Page) =>
	page.evaluate(() => {
		const v = document.querySelector("video");
		if (!v) return null;
		return Array.from(v.textTracks).map((t) => ({ kind: t.kind, mode: t.mode, label: t.label }));
	});

async function openCaptionsMenu(page: Page) {
	const controls = page.locator(CONTROLS);
	await controls.getByRole("button", { name: "Playback settings" }).click();
	await expect(page.getByTestId("captions-menu")).toBeVisible();
	await expect(page.getByTestId("captions-off")).toBeVisible();
}

test("captions render as tracks, and the menu offers them", async ({ page }) => {
	await openPlayer(page);

	// The payload carried them, so the element has them — before touching a menu at all.
	const modes = await captionModes(page);
	expect(modes).not.toBeNull();
	expect(
		modes?.every((t) => t.mode === "disabled"),
		"nothing shows until it is chosen",
	).toBe(true);

	await openCaptionsMenu(page);
	await expect(page.getByTestId("captions-menu")).toBeVisible();
	// The fixture's one track, attached by the seed; the testid keys on its database id.
	await expect(page.locator('[data-testid^="captions-track-"]')).toBeVisible();
});

test("choosing a caption shows it, Off hides it, and the menu stays open between them", async ({
	page,
}) => {
	await openPlayer(page);
	await openCaptionsMenu(page);

	// Turning captions on: the menu stays open (a viewer trying languages is choosing,
	// not dismissing), and the element's track answers.
	const row = page.locator('[data-testid^="captions-track-"]');
	await row.click();
	await expect
		.poll(async () => (await captionModes(page))?.some((t) => t.mode === "showing"))
		.toBe(true);

	await page.getByTestId("captions-off").click();
	await expect
		.poll(async () => (await captionModes(page))?.some((t) => t.mode !== "disabled"))
		.toBe(false);
});

test("c toggles captions, and the choice survives the next video", async ({ page }) => {
	// This worker's context may carry a choice a sibling test left in the preference —
	// this test's subject is the no-choice default, so say nobody has chosen.
	await page.goto("/");
	await page.evaluate(() => localStorage.removeItem("anthers.captions"));
	await openPlayer(page);

	// Nothing shown yet (a fresh authed context carries the default).
	expect((await captionModes(page))?.every((t) => t.mode === "disabled")).toBe(true);

	await page.locator("video").click(); // focus the player
	await page.keyboard.press("c"); // on: the first track, remembered "on"
	await expect
		.poll(async () => (await captionModes(page))?.some((t) => t.mode === "showing"))
		.toBe(true);

	// Reload the page: the remembered preference re-lights the track without a menu visit.
	// The shortcut reaches the player only through it, so every press that follows a
	// navigation first focuses the player again.
	await page.reload();
	await openPlayer(page);
	await expect
		.poll(async () => (await captionModes(page))?.some((t) => t.mode === "showing"))
		.toBe(true);

	await page.locator("video").click();
	await page.keyboard.press("c"); // off: remembered "off"
	await expect
		.poll(async () => (await captionModes(page))?.some((t) => t.mode !== "disabled"))
		.toBe(false);
	await page.reload();
	await openPlayer(page);
	await expect
		.poll(async () => (await captionModes(page))?.some((t) => t.mode === "showing"))
		.toBe(false);
});

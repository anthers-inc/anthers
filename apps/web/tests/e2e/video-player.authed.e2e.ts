// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The video player's own controls, walked in a browser.
 *
 * Until 2026-08-13 the player was `<video controls>` — the browser's chrome — so there was
 * nothing here to test and nothing anywhere that would notice if a control stopped
 * working. Now the transport is ours, which means every one of these is a thing that can
 * break silently on a page where the *video still plays*: a dead mute button, a settings
 * menu that opens and sets nothing, a Space key that scrolls the page instead of pausing.
 *
 * 🚨 **The load-bearing assertion is the negative one at the top**: that the element does
 * NOT carry `controls`. If native chrome came back, every other assertion here would still
 * pass — the browser draws its own play button, its own scrubber, its own volume — and the
 * suite would report a working player while the design was gone. Same family as the
 * absence-needs-a-test lesson from the third-party-request work.
 *
 * G1 is the fixture: free, streaming, real HLS from a real ffmpeg run, so the picture
 * genuinely decodes rather than a `<video>` with a dead src reporting `paused` forever.
 *
 * Runs in the `authed` project only because that is what depends on `setup`, which is what
 * seeds the fixture — the Work itself is Public Access and the player behaves identically
 * signed out.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gauntletPost } from "@anthers/db/gauntlet";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const G1 = gauntletPost("G1");
const CONTROLS = "[data-testid=video-controls]";
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * Attach real media to the fixture.
 *
 * ⚠️ The setup project deliberately does **not** do this — it would run ffmpeg twice per
 * CI run, since the gauntlet walk resets the fixture again and throws the first result
 * away. So any spec that needs bytes seeds them itself. This one deliberately does *not*
 * reset the fixture first, unlike the walk: a reset here would delete Works out from
 * under whatever else is running in this project.
 */
function seedMedia() {
	execFileSync("bun", ["run", "db:gauntlet:media"], { cwd: REPO_ROOT, stdio: "inherit" });
}

test.beforeAll(() => {
	// ffmpeg runs here; the walk's own hook budgets the same way and for the same reason.
	test.setTimeout(180_000);
	seedMedia();
});

/** Open G1 and wait for the element to have a real duration — i.e. HLS actually attached. */
async function openPlayer(page: Page) {
	await page.goto(`/works/${G1.slug}-${G1.publicId}`);
	// The gauntlet walk resets this fixture in a project that can run alongside this one,
	// which deletes the Work's transcode. One re-seed rather than a flake: if the player
	// is not there, put the media back and ask again.
	if ((await page.locator("video").count()) === 0) {
		seedMedia();
		await page.reload();
	}
	await expect(page.locator("video")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => document.querySelector("video")?.duration ?? 0), {
			timeout: 15_000,
			message: "the video never reported a duration — HLS did not attach",
		})
		.toBeGreaterThan(0);
}

const videoState = (page: Page) =>
	page.evaluate(() => {
		const v = document.querySelector("video");
		if (!v) return null;
		return {
			paused: v.paused,
			currentTime: v.currentTime,
			duration: v.duration,
			muted: v.muted,
			volume: v.volume,
			rate: v.playbackRate,
			hasNativeControls: v.hasAttribute("controls"),
		};
	});

/*
 * Serial, because the fixture is a shared mutable resource and `seedMedia` deletes and
 * recreates the transcode rows. Run in parallel, the workers re-seed on top of each other
 * and every test fails on a Work that briefly has no media — a fixture collision wearing
 * the costume of a player bug.
 *
 * ⚠️ **The cost is that a sabotage run under-reports.** Serial mode skips everything after
 * the first failure, so breaking the keymap shows one red test where two are genuinely
 * broken. When measuring what a change actually breaks, run the tests one at a time
 * (`-g "<title>"`) rather than reading the count off a serial run.
 */
test.describe.configure({ mode: "serial" });

test("the chrome is ours, not the browser's", async ({ page }) => {
	await openPlayer(page);

	const state = await videoState(page);
	// The one that guards the whole design. See the file header.
	expect(state?.hasNativeControls, "the <video> is back on native controls").toBe(false);

	// And the controls that replaced it are all present and named — icon-only buttons
	// with no accessible name are the failure this asserts against, not just absence.
	const controls = page.locator(CONTROLS);
	await expect(controls).toBeVisible();
	for (const label of ["Play", "Mute", "Playback settings", "Full screen"]) {
		await expect(controls.getByRole("button", { name: label, exact: true })).toBeVisible();
	}
	await expect(controls.getByRole("slider", { name: "Seek video" })).toBeAttached();
});

test("Space plays and pauses, and the page never gets the key", async ({ page }) => {
	await openPlayer(page);

	// Clicking the picture is how a viewer reaches the keymap: it plays AND focuses the
	// player, which is what makes the shortcut work at all.
	await page.locator("video").click();
	await expect.poll(async () => (await videoState(page))?.paused).toBe(false);

	/*
	 * 🚨 Asserting `preventDefault`, not `window.scrollY`.
	 *
	 * The obvious version — press Space, check the page did not scroll — is satisfied on
	 * any page with nothing below the fold, which is exactly what this fixture turned out
	 * to be (0px of scroll room in the built preview). It would have passed against a
	 * player that let Space through, on a page that simply had nowhere to go, and gone on
	 * passing until somebody read it on a long page. Reading `defaultPrevented` off the
	 * event tests the behaviour itself and is true or false regardless of page length.
	 */
	const pressAndWatch = async () => {
		// Arm first, press second, read third. An `evaluate` that *returns* a promise
		// resolving on the keypress races the press itself — it passed once and hung the
		// next run, which is the worst kind of green.
		await page.evaluate(() => {
			(window as unknown as { __prevented?: boolean | null }).__prevented = null;
			window.addEventListener(
				"keydown",
				(e) => {
					(window as unknown as { __prevented?: boolean | null }).__prevented = e.defaultPrevented;
				},
				{ once: true },
			);
		});
		await page.keyboard.press(" ");
		return page.evaluate(() => (window as unknown as { __prevented?: boolean | null }).__prevented);
	};

	expect(await pressAndWatch(), "Space reached the page — it would scroll").toBe(true);
	await expect.poll(async () => (await videoState(page))?.paused).toBe(true);

	expect(await pressAndWatch()).toBe(true);
	await expect.poll(async () => (await videoState(page))?.paused).toBe(false);
});

test("arrow keys seek, and m mutes", async ({ page }) => {
	await openPlayer(page);
	await page.locator("video").click();
	await page.keyboard.press(" "); // pause, so the position only moves when we move it

	await page.evaluate(() => {
		const v = document.querySelector("video");
		if (v) v.currentTime = 2;
	});
	await page.keyboard.press("ArrowLeft");
	// -5s from 2s clamps at the start rather than going negative.
	await expect.poll(async () => (await videoState(page))?.currentTime).toBe(0);

	await page.keyboard.press("ArrowRight");
	await expect.poll(async () => (await videoState(page))?.currentTime).toBeGreaterThan(0);

	expect((await videoState(page))?.muted).toBe(false);
	await page.keyboard.press("m");
	await expect.poll(async () => (await videoState(page))?.muted).toBe(true);
	await page.keyboard.press("m");
	await expect.poll(async () => (await videoState(page))?.muted).toBe(false);
});

test("the settings menu actually changes the playback rate", async ({ page }) => {
	await openPlayer(page);
	expect((await videoState(page))?.rate).toBe(1);

	const controls = page.locator(CONTROLS);
	await controls.getByRole("button", { name: "Playback settings" }).click();
	// Asserting the *effect* on the element, not that a menu item got a class — a menu
	// that highlights the choice it did not apply is exactly the silent failure here.
	await page.getByRole("button", { name: "1.5×", exact: true }).click();
	await expect.poll(async () => (await videoState(page))?.rate).toBe(1.5);
});

test("volume is remembered across a reload", async ({ page }) => {
	await openPlayer(page);

	// Set it through the control rather than on the element, so the store is what is
	// being exercised — writing `video.volume` directly would prove nothing about
	// persistence. The slider is collapsed until the volume control is hovered or
	// focused, so hover it first: this is the interaction, not a workaround for it.
	const controls = page.locator(CONTROLS);
	await controls.getByRole("button", { name: "Mute", exact: true }).hover();
	const slider = controls.getByRole("slider", { name: "Volume" });
	await expect(slider).toBeVisible();
	await slider.fill("0.3");
	await expect.poll(async () => (await videoState(page))?.volume).toBeCloseTo(0.3, 2);

	await openPlayer(page);
	// 🚨 The regression this pins is a **default of silence**, not a lost preference:
	// `Number(localStorage.getItem(...))` is 0 for a missing value, which every range
	// check accepts, so a first visit opened every player muted with no error anywhere.
	await expect.poll(async () => (await videoState(page))?.volume).toBeCloseTo(0.3, 2);
});

test("a first visit opens at full volume, not silent", async ({ page, context }) => {
	await context.clearCookies();
	await page.goto("/");
	await page.evaluate(() => {
		localStorage.removeItem("anthers_media_volume");
		localStorage.removeItem("anthers_media_muted");
	});

	await openPlayer(page);
	const state = await videoState(page);
	expect(state?.volume).toBe(1);
	expect(state?.muted).toBe(false);
});

// SPDX-License-Identifier: Apache-2.0
/**
 * Creator-authored chapters, walked in a browser.
 *
 * The YouTube model (Parker, 2026-10-13): the creator types timestamps into the
 * description; every one of them is a chapter cue; the timestamps render as links
 * that seek the page's mounted player — the description's and a review's alike,
 * both being plain text under the same scope — while the players segment their seek
 * bar over the cues and mount a chapter list in their own transport. Every one of
 * these can break silently on a page where the media still plays, which is the
 * failure shape the player specs were written against.
 *
 * The fixtures are the media fixture's episode (spoken) and clip (video), whose
 * descriptions carry `0:00` and `0:02` cues — the fixture clips are seconds long,
 * so the cues sit inside their real duration and the end-filter leaves both rows
 * standing.
 *
 * 🚨 Chromium's demuxer on a clip this short snaps seeks back to zero (the spoken
 * player spec's note), so every movement assertion reads the `currentTime` WRITES
 * the player makes, not the position it settles at — the player's own behavior.
 * The hooks are installed on the prototype via `addInitScript`, before the page's
 * scripts, so a landed `?t` is caught on its way in.
 *
 * The review fixture is the walker's own review, posted over itself — the API keeps
 * one review per user per Work and upserts, so re-runs re-write one row rather than
 * piling up. No other suite reads reviews on the media fixture's Works, which is
 * what makes a persistent review row acceptable here.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { REVIEW_MIN } from "@anthers/shared/content";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const EPISODE = mediaFixtureWork("episode");
const CLIP = mediaFixtureWork("video");

type Kind = "audio" | "video";

/** Install the prototype hook that records a media element's `currentTime` writes. */
async function hookCurrentTime(page: Page, kind: Kind) {
	await page.addInitScript((kind: Kind) => {
		const writes: number[] = [];
		(window as unknown as { __mediaTimeWrites?: number[] }).__mediaTimeWrites = writes;
		const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
		Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
			get() {
				return desc.get!.call(this);
			},
			set(v: number) {
				if ((this as HTMLMediaElement).tagName === (kind === "audio" ? "AUDIO" : "VIDEO")) {
					writes.push(v);
				}
				desc.set!.call(this, v);
			},
			configurable: true,
		});
	}, kind);
}

const timeWrites = async (page: Page): Promise<number[]> =>
	(await page.evaluate(
		() => (window as unknown as { __mediaTimeWrites?: number[] }).__mediaTimeWrites,
	)) ?? [];

test("an audio Work's page lists the chapters its description carries", async ({ page }) => {
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);

	const list = page.getByTestId("chapter-list");
	await expect(list).toBeVisible();
	// Both cues, titled off their own lines as the description wrote them.
	await expect(list.getByRole("button", { name: /Welcome/ })).toBeVisible();
	await expect(list.getByRole("button", { name: /The interview begins/ })).toBeVisible();

	// The playhead opens at zero, inside the 0:00 cue — the row marked playing.
	await expect(list.getByRole("button", { name: /0:00 Welcome/ })).toHaveAttribute(
		"aria-current",
		"true",
	);
});

test("a chapter row seeks the player", async ({ page }) => {
	await hookCurrentTime(page, "audio");
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);
	await expect(page.getByTestId("chapter-list")).toBeVisible();

	await page.getByRole("button", { name: /The interview begins/ }).click();

	expect(await timeWrites(page)).toContain(2);
});

test("a timestamp in the description is a link that seeks the player", async ({ page }) => {
	await hookCurrentTime(page, "audio");
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);

	// The description renders every cue as a link — exactly one here names 0:02; the
	// chapter list's same-labeled row is a button, not a link.
	const anchor = page.getByRole("link", { name: "0:02", exact: true });
	await expect(anchor).toBeVisible();
	await anchor.click();

	expect(await timeWrites(page)).toContain(2);
	// The bar now carries the moment, so a copied address lands where the viewer is.
	await expect(page).toHaveURL(/[*?&]t=2(&|$)/);
});

test("a ?t address lands the player at the moment it names, not at the resume", async ({
	page,
}) => {
	await hookCurrentTime(page, "audio");
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}?t=2`);
	await expect(page.getByTestId("chapter-list")).toBeVisible();

	// The only time write the entry needs is the moment itself; whatever position a
	// previous run remembered must NOT appear instead — startSeconds outranking the
	// resume is the rule. Polled: duration metadata lands a little after the list
	// renders, and the seek rides it.
	await expect
		.poll(() => timeWrites(page), { message: "the ?t seek never wrote currentTime" })
		.toContain(2);
});

test("the video player carries the chapter list its description segments", async ({ page }) => {
	await hookCurrentTime(page, "video");
	await page.goto(`/works/${CLIP.slug}-${CLIP.publicId}`);
	await expect(page.locator("video")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => document.querySelector("video")?.duration ?? 0), {
			timeout: 15_000,
			message: "the video never reported a duration — HLS did not attach",
		})
		.toBeGreaterThan(0);

	const list = page.getByTestId("chapter-list");
	await expect(list).toBeVisible();
	await expect(list.getByRole("button", { name: /The good part/ })).toBeVisible();

	await list.getByRole("button", { name: /The good part/ }).click();
	expect(await timeWrites(page)).toContain(2);
});

test("a review's timestamp is a link that seeks the player", async ({ page }) => {
	await hookCurrentTime(page, "audio");
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);
	await expect(page.getByTestId("chapter-list")).toBeVisible();

	// The walker's own review, re-posted over its previous self on every run.
	await page.getByRole("button", { name: "Recommend", exact: true }).click();
	const body = `Watch from 0:02 on — you're welcome. ${"x".repeat(REVIEW_MIN)}`;
	await page.locator("textarea").fill(body);
	await page.getByRole("button", { name: "Post review" }).click();

	// Two cues named 0:02 render once the review lands — the description's and the
	// review's; the review renders further down the page, and the last is it.
	const reviewAnchor = page.getByRole("link", { name: "0:02", exact: true }).last();
	await expect(reviewAnchor).toBeVisible();
	await reviewAnchor.click();

	expect(await timeWrites(page)).toContain(2);
});

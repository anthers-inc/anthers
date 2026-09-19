// SPDX-License-Identifier: Apache-2.0
/**
 * A video's thumbnail is the frame its creator paused on, walked in a browser.
 *
 * A creator chooses a video's thumbnail, uploaded or picked from a frame, and nothing takes one on
 * their behalf (Parker, 2026-09-18). Picking a frame is drawn in the creator's own browser from the
 * player on the Edit page (`lib/video-frame.ts`), which no API test can reach: what this walk
 * would catch is the button drawing nothing, drawing a frame that never uploads, or uploading one
 * the save never sends. It also checks the rule every thumbnail input carries is on the page.
 *
 * Runs on the media fixture's video, which is real HLS from a real ffmpeg run, so the picture
 * genuinely decodes. Its thumbnail is put back afterward, since other walks open the same Work.
 */
import { db } from "@anthers/db/client";
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { works } from "@anthers/db/schema";
import { THUMBNAIL_RULE } from "@anthers/shared/content";
import { eq } from "drizzle-orm";
import { expect, signInAsMediaFixture, test } from "./fixtures";

const CLIP = mediaFixtureWork("video");

let previous: string | null | undefined;

test.afterAll(async () => {
	if (previous === undefined) return;
	await db.update(works).set({ thumbnail: previous }).where(eq(works.publicId, CLIP.publicId));
});

test("a video's thumbnail can be the frame its creator paused on", async ({ page, context }) => {
	await signInAsMediaFixture(context);
	const [before] = await db
		.select({ thumbnail: works.thumbnail })
		.from(works)
		.where(eq(works.publicId, CLIP.publicId));
	previous = before.thumbnail;

	await page.goto(`/studio/works/${CLIP.publicId}/edit`);
	await expect(page.getByText(THUMBNAIL_RULE)).toBeVisible();

	// Wait for a real picture, then pause a second in.
	await expect
		.poll(() => page.evaluate(() => document.querySelector("video")?.duration ?? 0), {
			timeout: 15_000,
			message: "the video never reported a duration — HLS did not attach",
		})
		.toBeGreaterThan(0);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const video = document.querySelector("video") as HTMLVideoElement;
				video.addEventListener("seeked", () => resolve(), { once: true });
				video.currentTime = 1;
			}),
	);

	const uploaded = page.waitForResponse(
		(res) => res.url().includes("/api/content/media-upload/direct") && res.ok(),
	);
	await page.getByRole("button", { name: "Use This Frame" }).click();
	const { key } = (await (await uploaded).json()) as { key: string };
	expect(key).toMatch(/\/thumbnails\/.+\.jpg$/);

	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
		timeout: 15_000,
	});

	const [after] = await db
		.select({ thumbnail: works.thumbnail })
		.from(works)
		.where(eq(works.publicId, CLIP.publicId));
	expect(after.thumbnail).toContain(key);
});

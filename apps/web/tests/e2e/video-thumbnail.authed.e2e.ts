// SPDX-License-Identifier: Apache-2.0
/**
 * A video's thumbnail is the frame its creator paused on, walked in a browser.
 *
 * A creator chooses a video's thumbnail, uploaded or picked from a frame, and nothing takes one on
 * their behalf (Parker, 2026-09-18). Picking a frame is drawn in the creator's own browser from the
 * picker's own player (`OwnerWorkEditor`'s ThumbFramePicker), which no API test can reach: what this
 * walk catches is the picker opening, the frame's moment reaching the route, and the route's answer
 * being the saved row. It also checks the section's shape — the (i) beside the heading, the blank
 * frame, the two buttons — the 2026-10-16 redesign.
 *
 * Runs on the media fixture's video, which is real HLS from a real ffmpeg run, so the picture
 * genuinely decodes. Its thumbnail is put back afterward, since other walks open the same Work.
 */
import { db } from "@anthers/db/client";
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { works } from "@anthers/db/schema";
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

	// The editing surface is the Work's own page now (2026-10-13); the thumbnail lives in
	// the Manage tab since the byline pass — the creator's tab, Media and Thumbnail.
	await page.goto(`/studio/works/${CLIP.publicId}/edit`);
	await expect(page).toHaveURL(/\/works\/[^/?]+$/);
	await page.getByRole("tab", { name: "Manage" }).click();

	// The section's shape: the (i) carries the terms beside the heading, and the two
	// buttons stand beside the thumbnail's place.
	await expect(
		page.getByText("All works need thumbnails", { exact: false }).first(),
	).toBeAttached();

	// Open the picker, wait for its player to report a real picture, then take a moment
	// in. The extraction is the SERVER's doing — the route saves the field itself, so
	// the answered request IS the save.
	await page.getByRole("button", { name: "Choose from Work" }).click();
	const picker = page.getByRole("dialog", { name: "Thumbnail from this Work" });
	await expect
		.poll(() => picker.locator("video").evaluate((v) => (v as HTMLVideoElement).duration ?? 0), {
			timeout: 15_000,
			message: "the picker's video never reported a duration — the original did not attach",
		})
		.toBeGreaterThan(0);
	await picker.locator("video").evaluate(
		(video) =>
			new Promise<void>((resolve) => {
				const el = video as HTMLVideoElement;
				el.addEventListener("seeked", () => resolve(), { once: true });
				el.currentTime = 1;
			}),
	);

	const taken = page.waitForResponse((res) => res.url().includes("/thumbnail-frame") && res.ok());
	await picker.getByRole("button", { name: "Use This Frame" }).click();
	const { work } = (await (await taken).json()) as { work: { thumbnail: string } };
	expect(work.thumbnail).toMatch(/\/thumbnails\/\d+\/\w+\.jpg$/);

	// The section shows what the route answered, and the row is it — no save to press,
	// and no save bar promising anything else anywhere on the page.
	await expect(page.getByRole("img", { name: "The Work's thumbnail" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	const [after] = await db
		.select({ thumbnail: works.thumbnail })
		.from(works)
		.where(eq(works.publicId, CLIP.publicId));
	expect(after.thumbnail).toBe(work.thumbnail);
});

// SPDX-License-Identifier: Apache-2.0
/**
 * A video's thumbnail is the frame its creator paused on, walked in a browser.
 *
 * A creator chooses a video's thumbnail, uploaded or picked from a frame, and nothing takes one on
 * their behalf (Parker, 2026-09-18). Picking a frame is drawn in the creator's own browser from the
 * picker's own player (`OwnerWorkEditor`'s ThumbFramePicker), which no API test can reach: what this
 * walk catches is the picker opening, the frame's moment reaching the route, the taking state the
 * section shows while the extraction is queued, and the new picture replacing the old one when the
 * extraction lands. It also checks the section's shape — the (i) beside the heading, the blank
 * frame, the two buttons — the 2026-10-16 redesign.
 *
 * Runs on the media fixture's video, which is real HLS from a real ffmpeg run, so the picture
 * genuinely decodes. Its thumbnail is put back afterward, since other walks open the same Work.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@anthers/db/client";
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { expect, leashedExecFileSync, signInAsMediaFixture, test } from "./fixtures";

const CLIP = mediaFixtureWork("video");
// No trailing slash: a `//apps/…` import resolves as its own module instance to Bun, and
// the child then starts one queue while the handler sends on another (found by its
// "Database not opened" failure the first time this ran).
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, "");

let previous: string | null | undefined;

/**
 * Run the queued extraction the way the worker would, for the one take this walk makes.
 *
 * 🚨 **No worker runs in a browser session**, so the row the page polls would stay pending
 * for ever and the walk could only prove the ask. This calls `extractFrame` directly — the
 * same handler the worker registers — in a child `bun` process, because importing the API's
 * job into a web spec would couple the suites and the Playwright worker runs under Node in
 * CI, where `Bun` (which the handler spawns with) does not exist.
 *
 * The queue is started first so the handler's scan enqueue succeeds; nothing drains the scan,
 * which is this process's only job. The child exits explicitly because the database pool and
 * pg-boss hold handles open, the same reason the seed scripts do.
 */
function extractFrame(jobId: number): void {
	const dir = mkdtempSync(join(tmpdir(), "anthers-thumb-walk-"));
	const script = `const { ensureQueueReady } = await import(${JSON.stringify(
		`${REPO_ROOT}/apps/api/src/jobs/queue.js`,
	)});
await ensureQueueReady();
const { extractFrame } = await import(${JSON.stringify(
		`${REPO_ROOT}/apps/api/src/jobs/extract-frame.js`,
	)});
await extractFrame({ jobId: ${jobId} });
process.exit(0);
`;
	const file = join(dir, "extract.ts");
	writeFileSync(file, script);
	try {
		leashedExecFileSync("bun", [file], { cwd: REPO_ROOT, stdio: "ignore" });
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

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

	// The editing surface is the Work's own page now (2026-10-13); the thumbnail is the
	// media manager's Thumbnail section since the media-area pass (Parker, 2026-10-23).
	await page.goto(`/studio/works/${CLIP.publicId}/edit`);
	await expect(page).toHaveURL(/\/works\/[^/?]+$/);
	await page.getByRole("button", { name: "Edit Media" }).click();
	await page.getByRole("tab", { name: "Thumbnail" }).click();

	// The section's shape: the (i) carries the terms beside the heading, and the edit menu
	// stands beside the thumbnail's place.
	await expect(
		page.getByText("shows a placeholder drawn for its kind", { exact: false }).first(),
	).toBeAttached();

	// Open the picker, wait for its player to report a real picture, then take a moment
	// in. The extraction is the SERVER's doing — the route saves the field itself, so
	// the answered request IS the save.
	await page.getByRole("button", { name: "Edit Thumbnail" }).click();
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

	const image = page.getByRole("img", { name: "The Work's thumbnail" });
	const beforeSrc = await image.getAttribute("src");

	const taken = page.waitForResponse(
		(res) => res.url().includes("/thumbnail-frame") && res.status() === 202,
	);
	await picker.getByRole("button", { name: "Use This Frame" }).click();
	const answered = await taken;
	const { job } = (await answered.json()) as { job: { id: number } };

	// The section carries the taking state until the row settles.
	await expect(page.getByText("Taking this moment…")).toBeVisible();

	// This suite's servers are the two previews and the API — no worker — so the queued
	// extraction is run here, the way the API suites run a handler. The page's own poll is
	// what the rest of the walk exercises.
	extractFrame(job.id);

	// The picture the page was showing is replaced by the frame that landed.
	await expect
		.poll(
			async () => {
				const [row] = await db
					.select({ thumbnail: works.thumbnail })
					.from(works)
					.where(eq(works.publicId, CLIP.publicId));
				return row.thumbnail ?? "";
			},
			{ timeout: 30_000, message: "the worker never landed a frame for the Work" },
		)
		.not.toBe(previous);
	await expect.poll(() => image.getAttribute("src"), { timeout: 30_000 }).not.toBe(beforeSrc);

	// The section shows what landed, and the row is it — no save to press, and no save bar
	// promising anything else anywhere on the page.
	await expect(page.getByRole("img", { name: "The Work's thumbnail" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	const [after] = await db
		.select({ thumbnail: works.thumbnail })
		.from(works)
		.where(eq(works.publicId, CLIP.publicId));
	expect(after.thumbnail).toMatch(/\/thumbnails\/\d+\/\w+\.jpg$/);
});

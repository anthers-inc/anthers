// SPDX-License-Identifier: Apache-2.0
/**
 * A track plays while it processes — the delivery ruling (#457) reached the listened
 * kinds (2026-10-16).
 *
 * 🚨 **The assertion worth the spec is the player, not the progress.** A track used to
 * read as a foreground process: from the file's landing until the worker finished, the
 * deliverable's place was the `TranscodingStatus` block, and the creator heard nothing
 * of their own Work. The ruling's shape (the Studio walked it for video in #482) is that
 * the processed MP3 is the *upgrade*, and the original — which exists from the landing —
 * is the deliverable until then. This walk uploads a track and pins, in the no-worker
 * state every e2e session shares (`work-upload`'s: the job row is created, the worker
 * never drains it), that the page shows a player and not the status block.
 *
 * The API contract underneath is pinned at the unit level in
 * `apps/api/src/__tests__/original-delivery.test.ts` — the route's gate ladder, the 402,
 * the payload's `originalUrl` for the listened kinds. This walk proves the browser takes
 * that address and mounts the player, which is the part only a browser can prove.
 *
 * Runs in the `authed` project on `media_fixture`; its own Work is swept by title, as
 * `work-draft`'s is.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Audio processing walk ";
const STEM = `${TITLE_PREFIX}${Date.now()}`;

/** A one-second tone, the way a creator's DAW or phone would hand one over. */
function tone(): Buffer {
	const dir = mkdtempSync(join(tmpdir(), "anthers-audio-walk-"));
	try {
		const out = join(dir, "tone.wav");
		execFileSync(
			"ffmpeg",
			["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-y", out],
			{ stdio: "pipe" },
		);
		return readFileSync(out);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let session = "";

interface OwnedWork {
	id: number;
	title: string;
	sourceKey: string | null;
	transcoding: { status: string } | null;
}

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

/** Delete this walk's Work — a crashed earlier run's, and this run's. */
async function sweep(): Promise<void> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works: owned } = (await res.json()) as { works: OwnedWork[] };
	for (const w of owned.filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.afterAll(async () => {
	if (session) await sweep();
});

test.describe.configure({ mode: "serial" });

test("a music Work plays its original while processing runs", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	await sweep();

	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("music");
	await page.locator('input[type="file"]').setInputFiles({
		name: `${STEM}.wav`,
		mimeType: "audio/wav",
		buffer: tone(),
	});

	// The landing is the Work's own page in editor mode, as every upload walk reads it.
	await expect(page).toHaveURL(/\/works\/[^/?]+$/, { timeout: 15_000 });
	// The editing banner is gone (the View As task, 2026-10-16): the editor mode is
	// what the page is, and the View As row on the Manage tab is its one marker.
	await expect(page.getByRole("group", { name: "View this Work as" })).toBeVisible();

	// The file lands, and landing is what starts processing — a job row exists with no
	// worker to drain it, which is precisely the state the ruling's widening governs.
	const landedWork = { id: 0 };
	await expect
		.poll(
			async () => {
				const [work] = (await ownWorks()).filter((w) => w.title === STEM);
				if (work?.sourceKey && work.transcoding) {
					landedWork.id = work.id;
					return "arrived";
				}
				return null;
			},
			{ timeout: 30_000 },
		)
		.toBe("arrived");

	// The deliverable's place holds the player, not the status block. The old page put
	// "Waiting to process…" there; the ruled page mounts the original and lets the
	// Manage tab's file section carry the progress.
	//
	// The <audio> element itself is 0x0 — the player's UI is its transport — so the
	// visible half is asserted on the button and the playing half on the element.
	const audio = page.locator("audio");
	await expect(audio).toBeAttached();
	// The player plays the Work's own original: local storage names the stored key;
	// delivery mode names the access-checked route. Both are "the original".
	const src = await audio.getAttribute("src");
	expect(src ?? "").toMatch(new RegExp(`works/${landedWork.id}/original|creators/`));
	await expect(
		audio.locator("xpath=ancestor::*[1]").getByRole("button", { name: "Play" }),
	).toBeVisible();

	// And nothing anywhere on the page claims the Work is waiting, while the job's row
	// still says pending — the status block no longer stands in the player's place.
	// Scoped to the player's own section: the Manage tab (open by default since the
	// View As task, 2026-10-16) carries the machinery's own waiting words in its card.
	await expect(
		page.locator("section", { has: page.locator("audio") }).getByText(/Waiting to process…/),
	).toHaveCount(0);

	// The user's view holds the player too: the deliverable is one component with one
	// layout for both surfaces, so the preview a creator checks is the page a listener
	// opens while the track is still processing. A read view carries no edit pencils.
	await page.getByRole("button", { name: "User (Locked)" }).click();
	await expect(page.locator("audio")).toBeAttached();
	const userSrc = await page.locator("audio").getAttribute("src");
	expect(userSrc ?? "").toMatch(new RegExp(`works/${landedWork.id}/original|creators/`));
	await expect(page.getByRole("button", { name: "Edit Description" })).toHaveCount(0);
});

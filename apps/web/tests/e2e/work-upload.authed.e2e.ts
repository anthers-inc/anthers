// SPDX-License-Identifier: Apache-2.0
/**
 * Uploading a video Work, walked in a browser: the Work exists the moment its file is picked,
 * the creator is on its Edit page while the file is still going up, and a save made after the
 * file lands keeps the file.
 *
 * 🚨 **The save is the assertion worth the spec.** The Edit page is opened before the file
 * arrives, so everything it loaded says the Work has no file, and a save that sent what it
 * loaded would erase the file the upload attached a moment earlier. Nothing on screen would
 * show it — the save succeeds and lands on the Catalog — until the Work turned out to have no
 * file to release. So the walk holds the upload open, edits during it, lets the file land while
 * the page is still open, saves, and then asks the server what the Work holds.
 *
 * ⚠️ **The upload is held with `page.route`, not raced against.** A real clip small enough to
 * keep the suite quick uploads in milliseconds, which would make "the page opened before the
 * file arrived" true only on a slow machine. Holding the request makes it true on every run.
 *
 * Runs in the `authed` project on `media_fixture`, which nothing else resets — see
 * `signInAsMediaFixture` in `fixtures.ts`. The clip comes from ffmpeg's synthetic source, which
 * this project already needs, so nothing binary is committed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Upload walk ";
const STEM = `${TITLE_PREFIX}${Date.now()}`;

interface OwnedWork {
	id: number;
	title: string;
	description: string;
	sourceKey: string | null;
	transcoding: { status: string } | null;
}

let session = "";

/** A one-second test pattern, encoded the way a creator's phone would hand one over. */
function clip(): Buffer {
	const dir = mkdtempSync(join(tmpdir(), "anthers-upload-walk-"));
	try {
		const out = join(dir, "clip.mp4");
		execFileSync(
			"ffmpeg",
			[
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc=duration=1:size=160x90:rate=10",
				"-pix_fmt",
				"yuv420p",
				"-y",
				out,
			],
			{ stdio: "pipe" },
		);
		return readFileSync(out);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

/** Delete this spec's Works — a crashed earlier run's, and this run's. */
async function sweep(): Promise<void> {
	if (!session) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

// In `afterAll`, so a walk that fails halfway still takes its Work back.
test.afterAll(sweep);

const cardFor = (page: import("@playwright/test").Page) =>
	page.locator(".card").filter({ hasText: STEM });

test("a video Work is made from its file and edited while the file uploads", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await sweep();

	// Hold the bytes until the walk says so.
	let letUploadThrough: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		letUploadThrough = resolve;
	});
	await page.route("**/api/content/media-upload/direct", async (route) => {
		await held;
		await route.continue();
	});

	await page.goto("/studio/works/new");
	await expect(page.getByRole("heading", { name: "Upload a Work" })).toBeVisible();

	// Video is the default kind, and picking the file is the whole of creating the Work.
	await page.locator('input[type="file"]').setInputFiles({
		name: `${STEM}.mp4`,
		mimeType: "video/mp4",
		buffer: clip(),
	});

	// ── On the Work's page, while the file is still going up ────────────────
	await expect(page).toHaveURL(/\/studio\/works\/\d+\/edit$/, { timeout: 15_000 });
	// No title was typed, so the file's name became one.
	await expect(page.getByPlaceholder("Work title")).toHaveValue(STEM);
	await expect(page.getByText(/keep this tab open until it finishes/i)).toBeVisible();
	// A Work whose file has not arrived cannot be released (`media_missing`), and the control
	// says so rather than earning the refusal.
	await expect(
		page.getByRole("checkbox", { name: /released to my public catalog/i }),
	).toBeDisabled();

	await page.getByPlaceholder("Describe this Work…").fill("Written while it uploaded.");

	// ── The file lands while the page is open ───────────────────────────────
	letUploadThrough();
	await expect(page.getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 30_000 });

	// ── And a save made afterwards keeps it ─────────────────────────────────
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page).toHaveURL(/\/studio\/catalog$/, { timeout: 15_000 });
	await expect(cardFor(page)).not.toContainText("No file");

	const [work] = (await ownWorks()).filter((w) => w.title === STEM);
	expect(work, "the Work the Upload page made is not in the creator's own listing").toBeTruthy();
	expect(work.description).toBe("Written while it uploaded.");
	expect(work.sourceKey, "the save erased the file that had just arrived").toBeTruthy();
	// Arriving is what starts processing, so a job exists whatever state the worker has it in.
	expect(work.transcoding).not.toBeNull();
});

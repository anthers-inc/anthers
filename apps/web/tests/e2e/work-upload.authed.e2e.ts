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
import { db } from "@anthers/db/client";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
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

// 🚨 **Serial, because the sweep is by title prefix.** Run in parallel workers, the first walk's
// `afterAll` deleted the second walk's Work partway through it, and the symptom was a page that
// stopped updating — every re-read answered 404 — which reads as a polling bug.
test.describe.configure({ mode: "serial" });

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

/**
 * An ebook is made from one PDF, the same way a video is made from its file.
 *
 * The Studio could not make an ebook at all until 2026-09-16, though everything downstream of the
 * upload — the rasterizer, the page route, the reader — already existed. What this walk proves is
 * the join: the kind is offered, the file goes up as a private asset, and arriving starts the
 * rendering. No worker runs here, so the pages themselves are the seed fixture's business.
 */
test("an ebook is made from its PDF", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);

	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("ebook");
	await page.locator('input[type="file"]').setInputFiles({
		name: `${STEM} ebook.pdf`,
		mimeType: "application/pdf",
		buffer: Buffer.from(
			"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
		),
	});

	await expect(page).toHaveURL(/\/studio\/works\/\d+\/edit$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: "Edit Ebook" })).toBeVisible();
	await expect(page.getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 30_000 });

	await expect
		.poll(async () => {
			const [work] = (await ownWorks()).filter((w) => w.title === `${STEM} ebook`);
			return work?.transcoding ? `${work.sourceKey?.includes("/assets/")}` : null;
		})
		.toBe("true");
});

/**
 * The page a creator lands on after uploading follows the processing it started.
 *
 * ⚠️ **The job's progress is written straight to the database, not produced by a worker.** No
 * worker runs in a browser session, and a real encode of a clip small enough for the suite
 * finishes before a page could show it moving. What is under test is that the page reads the
 * job again while it runs and says what it says — the wiring a unit test of the wording cannot
 * reach — so the walk moves the job itself and watches the page catch up.
 */
test("a Work's page and the Dashboard follow its processing", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);

	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "video", title: `${STEM} processing` }),
	});
	const { work } = (await created.json()) as { work: { id: number; publicId: number } };
	await db
		.update(works)
		.set({ sourceKey: `creators/0/video/upload-walk-${work.id}.mp4` })
		.where(eq(works.id, work.id));
	await db.insert(transcodingJobs).values({
		workId: work.id,
		mediaType: "video",
		status: "processing",
		progress: 43,
		etaSeconds: 150,
	});

	await page.goto(`/studio/works/${work.publicId}/edit`);
	await expect(page.getByText("43%", { exact: true })).toBeVisible();
	await expect(page.getByText("About 3 minutes left")).toBeVisible();

	// The Catalog card gives the estimate a line of its own, because its badge has no room for it:
	// the longest estimate wrapped inside the badge's one fixed-height line and spilled out of it.
	await page.goto("/studio/catalog");
	const card = page.locator(".card").filter({ hasText: `${STEM} processing` });
	await expect(card.locator(".badge").filter({ hasText: "Processing" })).toHaveText(
		"Processing 43%",
	);
	await expect(card.getByText("About 3 minutes left")).toBeVisible();
	await page.goto(`/studio/works/${work.publicId}/edit`);

	// The page re-reads the job on its own. An audio or ebook job has no estimate, and the page
	// says nothing about one rather than an empty "left".
	await db
		.update(transcodingJobs)
		.set({ progress: 80, etaSeconds: null })
		.where(eq(transcodingJobs.workId, work.id));
	await expect(page.getByText("80%", { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText(/ left$/)).toHaveCount(0);

	await db
		.update(transcodingJobs)
		.set({ status: "completed", progress: 100, updatedAt: new Date() })
		.where(eq(transcodingJobs.workId, work.id));
	await expect(page.getByText("Processing…")).toHaveCount(0, { timeout: 15_000 });

	// And the Dashboard keeps it for the day, as ready.
	await page.getByRole("navigation").getByRole("link", { name: "Dashboard", exact: true }).click();
	const panel = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Processing" }) });
	await expect(panel.getByRole("listitem").filter({ hasText: `${STEM} processing` })).toContainText(
		"Ready",
	);
});

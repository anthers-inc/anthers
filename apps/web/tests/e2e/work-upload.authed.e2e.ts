// SPDX-License-Identifier: Apache-2.0
/**
 * Uploading a video Work, walked in a browser: the Work is drafted from a name and a kind,
 * its file arrives on its own page from the empty media card, the creator edits while the
 * file is still going up, and a save made after the file lands keeps the file.
 *
 * 🚨 **The save is the assertion worth the spec.** The page is opened before the file
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	API_URL,
	createDraftWork,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE_PREFIX = "Upload walk ";
const STEM = `${TITLE_PREFIX}${Date.now()}`;

interface OwnedWork {
	id: number;
	title: string;
	description: string;
	sourceKey: string | null;
	transcoding: { status: string } | null;
}

/** A Work's hosted builds, as the owner's detail shape carries them. */
interface OwnedBuild {
	entryPath: string;
	isPrimary: boolean;
	files: { path: string }[];
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

/** The hosted builds of one Work, from the owner's detail shape. */
async function ownBuilds(workId: number): Promise<OwnedBuild[] | null> {
	const res = await fetch(`${API_URL}/api/content/works/${workId}`, {
		headers: { Cookie: `session=${session}` },
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { work?: { webBuilds?: OwnedBuild[] } };
	return body.work?.webBuilds ?? null;
}

/** The files a tiny engine export carries — the entry and what a browser loads beside it. */
const EXPORT_FILES = [
	["index.html", "<!doctype html><html><body>a game</body></html>"],
	["index.js", "globalThis.boot = true;"],
	["index.pck", "pack"],
	["index.wasm", "wasm"],
	["index.audio.worklet.js", "// worklet"],
] as const;

function writeExport(folder: string): void {
	mkdirSync(folder, { recursive: true });
	for (const [name, body] of EXPORT_FILES) writeFileSync(join(folder, name), body);
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

/**
 * The card under the picker follows the kind, and a build's card follows its platform.
 *
 * The page used to state every accepted format at once, above the form: four media a creator
 * had to sort through for the one they chose, and nothing at all about a build's platform.
 * The card now names the kind on screen (Parker, 2026-10-19) and lives in the Work's media
 * area (Parker, 2026-10-23), so this walk asserts the fact a creator needs at the moment of
 * filling the Work — and that it sits under the picker it explains.
 */
test("the media card states what the chosen kind takes, under its picker", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);

	// Video: its card carries the accepted set and the cap, below the dropper.
	await page.goto((await createDraftWork(page, { type: "video", title: `${STEM} facts` })).url);
	const videoCard = page.getByRole("region", { name: "What Anthers accepts for a video" });
	await expect(videoCard).toBeVisible();
	await expect(videoCard).toContainText("H.264");
	await expect(videoCard).toContainText("VP9");
	await expect(videoCard).toContainText("2 GB");

	const picker = page.getByRole("button", { name: "Drop a video file or click to browse" });
	const pickerBox = await picker.boundingBox();
	const cardBox = await videoCard.boundingBox();
	expect(pickerBox, "the video picker is not on the page").not.toBeNull();
	expect(cardBox, "the card is not on the page").not.toBeNull();
	expect(cardBox?.y ?? 0).toBeGreaterThan(pickerBox?.y ?? 0);

	// A game's card is about builds, and its middle fact follows the Platform select.
	await page.goto((await createDraftWork(page, { type: "game", title: `${STEM} game` })).url);
	const gameCard = page.getByRole("region", { name: "What Anthers accepts for a game" });
	await expect(gameCard).toBeVisible();
	await expect(gameCard).toContainText(".exe");
	await page.getByRole("combobox", { name: "Platform" }).selectOption("mac");
	await expect(gameCard).toContainText(".dmg");
	await expect(gameCard).not.toContainText(".exe");

	// A comic's card no longer offers a PDF, and says how to prepare the pages.
	await page.goto((await createDraftWork(page, { type: "comic", title: `${STEM} comic` })).url);
	const comicCard = page.getByRole("region", { name: "What Anthers accepts for a comic" });
	await expect(comicCard).toContainText("JPG or PNG");
	await expect(comicCard).toContainText("PDF or a CBZ isn't taken");
});

/**
 * A Web build goes up from the Work's media area as the hosted lane — the export's files,
 * with the entry the picker guessed, answered where the build row fixes them.
 *
 * What this walk proves is the join: the pick becomes a completed hosted build, its files
 * reach the hosted-build rows with the paths the export wrote, and the Work's page shows the
 * build rather than an empty section. The folder picker is the one the Work page carries;
 * the `.zip` unpacker that the retired Upload page offered has no caller now.
 */
test("a folder of an export becomes a hosted build from the media card", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const title = `${STEM} web folder`;
	await sweep();

	const dir = mkdtempSync(join(tmpdir(), "anthers-webbuild-"));
	try {
		const folder = join(dir, "web");
		writeExport(folder);

		await page.goto((await createDraftWork(page, { type: "game", title })).url);

		// The card tells the creator what a browser build needs, and the downloadable
		// lane's picker is not what Web offers.
		await page.getByRole("combobox", { name: "Platform" }).selectOption("web");
		await expect(page.getByRole("region", { name: "What a browser build needs" })).toContainText(
			"index.html",
		);
		await expect(page.getByText("Drop a build or click to browse")).toHaveCount(0);

		// The Hosted Build section takes the export folder and guesses its entry.
		await page.getByRole("button", { name: "Add browser build" }).click();
		await page.locator('input[type="file"][webkitdirectory]').setInputFiles(folder);
		await expect(page.getByPlaceholder("index.html")).toHaveValue("web/index.html");
		await page.getByRole("button", { name: "Upload build" }).click();

		await expect(page.getByRole("heading", { name: "Hosted Build", exact: true })).toBeVisible();

		// The build lands with the export's own paths, the entry it guessed, and every
		// file the folder carried.
		await expect
			.poll(
				async () => {
					const work = (await ownWorks()).find((w) => w.title === title);
					if (!work) return null;
					const builds = await ownBuilds(work.id);
					const build = builds?.find((b) => b.isPrimary);
					return build ? `${build.entryPath}|${build.files.length}` : null;
				},
				{ timeout: 30_000 },
			)
			.toBe("web/index.html|5");

		const work = (await ownWorks()).find((w) => w.title === title)!;
		const [build] = (await ownBuilds(work.id)) ?? [];
		expect(build.files.map((f) => f.path).sort()).toEqual(
			[
				"web/index.audio.worklet.js",
				"web/index.html",
				"web/index.js",
				"web/index.pck",
				"web/index.wasm",
			].sort(),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const rowFor = (page: import("@playwright/test").Page) =>
	page.locator("tbody tr").filter({ hasText: STEM });

test("a video Work takes its file on the page and edits while the file uploads", async ({
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

	const draft = await createDraftWork(page, { type: "video", title: STEM });
	await page.goto(draft.url);

	// The empty media card is the intake now: the dropper rides inside the box the Work
	// will fill (the media-area task, 2026-10-23).
	const box = page.getByRole("status").filter({ hasText: /player starts here/i });
	await box.locator('input[type="file"]').setInputFiles({
		name: `${STEM}.mp4`,
		mimeType: "video/mp4",
		buffer: clip(),
	});

	// ── On the Work's own page, while the file is still going up ────────────
	// The page is the editing surface a creator meets while the file is still on the
	// wire, and the View As row is its one mode marker.
	await expect(page).toHaveURL(/\/works\/[^/?]+$/, { timeout: 15_000 });
	await expect(page.getByRole("group", { name: "View this Work as" })).toBeVisible();
	await expect(page.locator("h1").filter({ hasText: STEM })).toBeVisible();
	// The in-flight upload says where it is — in the box the file is arriving into, since
	// the page carries no banner above it (2026-10-25) — and that the tab's life is the
	// upload's.
	const climbing = page.getByRole("status").filter({ hasText: /It's uploading now/ });
	await expect(climbing).toBeVisible();
	await expect(climbing.getByText(/keep this tab open/)).toBeVisible();
	await expect(climbing.locator("progress")).toBeVisible();
	// A Work whose file has not arrived cannot be released (`media_missing`), and the
	// control says so rather than earning the refusal.
	await page.getByRole("button", { name: "Edit Release" }).click();
	await page.getByRole("button", { name: "Now", exact: true }).click();
	await expect(page.getByRole("button", { name: "Save Release" })).toBeDisabled();

	// The per-field model is what this walk is about: the description saves THROUGH the
	// upload, not after it — one field, one save, whatever else is in flight.
	await page.getByRole("button", { name: "Edit Description" }).click();
	await page.getByPlaceholder("Describe this Work…").fill("Written while it uploaded.");
	await page.getByRole("button", { name: "Save Description" }).click();
	await expect(page.getByText("Written while it uploaded.")).toBeVisible();

	// ── The file lands while the page is open ───────────────────────────────
	// The chips are the states now, so arrival is read from the row itself — the same
	// poll the paged walks use.
	letUploadThrough();
	await expect
		.poll(
			async () => {
				const [work] = (await ownWorks()).filter((w) => w.title === STEM);
				return work?.sourceKey ? "arrived" : null;
			},
			{ timeout: 30_000 },
		)
		.toBe("arrived");

	// And what the page holds after a reload is what the saves made (Parker's per-field
	// model, 2026-10-13): the description that saved through the upload, and the file.
	await page.reload();
	await expect(page.getByText("Written while it uploaded.")).toBeVisible();

	// ── And the server holds the same ───────────────────────────────────────
	await page.goto("/studio/works");
	await expect(rowFor(page)).not.toContainText("No file");

	const [work] = (await ownWorks()).filter((w) => w.title === STEM);
	expect(work, "the Work the Upload page made is not in the creator's own listing").toBeTruthy();
	expect(work.description).toBe("Written while it uploaded.");
	expect(work.sourceKey, "the save erased the file that had just arrived").toBeTruthy();
	// Arriving is what starts processing, so a job exists whatever state the worker has it in.
	expect(work.transcoding).not.toBeNull();
});

/**
 * A comic is made from page images and a book from a PDF — the two paged kinds' sources,
 * through the same pick, upload and render join.
 *
 * The Studio could not make an ebook at all until 2026-09-16, though everything downstream of the
 * upload — the rasterizer, the page route, the user — already existed. What this walk proves is
 * the join: the kind is offered, the file goes up as a private asset, and arriving starts the
 * rendering. A comic takes JPG or PNG (Parker, 2026-10-19); a book still takes a PDF. No worker
 * runs here, so the pages themselves are the seed fixture's business.
 */
const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
for (const source of [
	{
		type: "comic",
		label: "Comic",
		name: `${STEM} comic.png`,
		mimeType: "image/png",
		buffer: PIXEL_PNG,
	},
	{
		type: "ebook",
		label: "Book",
		name: `${STEM} ebook.pdf`,
		mimeType: "application/pdf",
		buffer: Buffer.from(
			"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
		),
	},
] as const) {
	test(`a ${source.label.toLowerCase()} takes its ${source.type === "comic" ? "page image" : "PDF"} on the page`, async ({
		page,
		context,
	}) => {
		session = await signInAsMediaFixture(context);
		const title = `${STEM} ${source.type}`;

		// Drafted with a kind and a name, then filled from the empty media card's set
		// editor — the intake the media-area task put there (2026-10-23).
		await page.goto((await createDraftWork(page, { type: source.type, title })).url);
		await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
		const box = page
			.getByRole("status")
			.filter({ hasText: source.type === "comic" ? /pages open here/i : /book opens here/i });
		await box.locator('input[type="file"]').setInputFiles({
			name: source.name,
			mimeType: source.mimeType,
			buffer: source.buffer,
		});

		// Arrival is the file's row in the set — the label from its filename, extension
		// stripped by the rowLabel rule. The set editor is the manager's Source section
		// once the set exists.
		await page.getByRole("button", { name: "Manage This Work's Media" }).click();
		await page.getByRole("tab", { name: "Source" }).click();
		await expect(
			page
				.getByRole("tabpanel")
				.locator("span.flex-1.truncate")
				.filter({ hasText: new RegExp(`${STEM} ${source.type}`) }),
		).toBeVisible({ timeout: 30_000 });

		await expect
			.poll(async () => {
				const [work] = (await ownWorks()).filter((w) => w.title === title);
				return work?.transcoding ? `${work.sourceKey?.includes("/assets/")}` : null;
			})
			.toBe("true");
	});
}

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
	// The editing surface is the Work's own page (2026-10-13); the processing reads in the
	// media manager's Source section, where the file's machinery lives (2026-10-23).
	await expect(page).toHaveURL(/\/works\/[^/?]+$/);
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await page.getByRole("tab", { name: "Source" }).click();
	await expect(page.getByText("43%", { exact: true })).toBeVisible();
	await expect(page.getByText("About 3 minutes left")).toBeVisible();

	// The row shows the same chips the Manage tab does (Parker, 2026-10-17): the original,
	// the audio rendition and the ladder — each yellow while the run has not produced it —
	// and the estimate a line of its own, because a chip has no room for it.
	await page.goto("/studio/works");
	const row = page.locator("tbody tr").filter({ hasText: `${STEM} processing` });
	await expect(row.getByText("Original", { exact: true })).toBeVisible();
	await expect(row.getByText("Audio", { exact: true })).toBeVisible();
	await expect(row.getByText("Ladder", { exact: true })).toBeVisible();
	await expect(row.getByText("About 3 minutes left")).toBeVisible();
	await page.goto(`/studio/works/${work.publicId}/edit`);
	// The fresh page opens on the Work's own page; the processing lives in the media
	// manager's Source section, which each visit opens on Delivery.
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await page.getByRole("tab", { name: "Source" }).click();

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

	// And the Dashboard keeps it for the day, as ready. It is a tab on the creator's own
	// profile since 2026-10-23, and `/studio` forwards there with that tab open.
	await page.goto("/studio");
	const panel = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Processing" }) });
	await expect(panel.getByRole("listitem").filter({ hasText: `${STEM} processing` })).toContainText(
		"Ready",
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rasterize an **ebook** Work: one uploaded PDF in, one private page image out per page.
 *
 * 🚨 **Why this job exists at all, when the creator already uploaded a perfectly good
 * PDF.** The delivery rule is that every derived media object is stored private and every
 * URL to one is minted per request at an endpoint that re-resolves access — and a PDF is
 * *one* object. A reader pointed at a signed URL for it has the whole book the moment page
 * one opens, which makes `downloadEnabled: false` a lie for this medium specifically and
 * would surprise a creator who deliberately turned downloads off. Pages are to a book what
 * HLS segments are to a video: the unit that can actually be checked.
 *
 * The happy side effect is that the *client* gets simpler, not heavier — the reader shows
 * images, so no PDF parser (~1 MB) ships to the browser at all.
 *
 * Uses **poppler** (`pdfinfo` + `pdftoppm`), which is a new system dependency alongside
 * ffmpeg. Absent, this fails the job with a legible message rather than half-rendering: a
 * book missing pages 40–96 is worse than one that plainly did not process.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, workPages, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { storage } from "../services/storage/index.js";

export interface RasterizeEbookData {
	jobId: number;
}

/**
 * Render at 150 DPI.
 *
 * Comic art is the demanding case: 150 DPI on a US-letter page is ~1275×1650, which is
 * sharp on a retina display at reading width and still a sane file size. Going to 300
 * quadruples the bytes for detail nobody sees on a screen, and this is *reading* rather
 * than archival — the creator's original stays untouched as the source, and a download,
 * where enabled, hands over that rather than these.
 */
const RENDER_DPI = 150;

/** Hard ceiling, so one pathological upload cannot fill the bucket or the job queue. */
const MAX_PAGES = 2000;

async function popplerAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["pdftoppm", "-v"], { stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/** Page count, from `pdfinfo`. Also the first thing that fails on a file that isn't a PDF. */
async function pageCount(path: string): Promise<number> {
	const proc = Bun.spawn(["pdfinfo", path], { stdout: "pipe", stderr: "pipe" });
	if ((await proc.exited) !== 0) {
		throw new Error(
			`Not a readable PDF: ${(await new Response(proc.stderr).text()).trim() || "pdfinfo failed"}`,
		);
	}
	const out = await new Response(proc.stdout).text();
	const match = /^Pages:\s+(\d+)$/m.exec(out);
	if (!match) throw new Error("Could not read the page count from this PDF");
	return Number(match[1]);
}

async function updateProgress(jobId: number, progress: number) {
	await db
		.update(transcodingJobs)
		.set({ progress, updatedAt: new Date() })
		.where(eq(transcodingJobs.id, jobId));
}

export async function rasterizeEbook(data: RasterizeEbookData) {
	const { jobId } = data;

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	// Idempotency: a late pg-boss retry of a job already finished (e.g. by the worker's
	// startup-resume path) is a no-op, exactly as the other two jobs treat it.
	if (job.status === "completed") {
		console.log(`[rasterize-ebook] job ${jobId} already completed; skipping`);
		return;
	}

	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0 })
		.where(eq(transcodingJobs.id, jobId));

	const [work] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!work) throw new Error(`Work ${job.workId} not found`);

	const sourceKey = work.sourceKey ?? "";
	if (!sourceKey) throw new Error("No source file on this Work");

	let localPath: string | null = null;
	let outDir: string | null = null;

	try {
		if (!(await popplerAvailable())) {
			throw new Error(
				"poppler (pdftoppm) is not installed on this host — an ebook cannot be rendered",
			);
		}

		localPath = await storage.downloadToTemp(sourceKey);
		const pages = await pageCount(localPath);
		if (pages < 1) throw new Error("This PDF has no pages");
		if (pages > MAX_PAGES) {
			throw new Error(`This PDF has ${pages} pages; the limit is ${MAX_PAGES}`);
		}
		await updateProgress(jobId, 5);

		/*
		 * Render the whole document in one `pdftoppm` invocation rather than page by page.
		 *
		 * Poppler parses the document once and writes `page-001.jpg`, `page-002.jpg`, …
		 * Spawning it per page re-parses the file every time, which on a 200-page graphic
		 * novel is the difference between one pass and two hundred.
		 */
		outDir = await mkdtemp(join(tmpdir(), "ebook_"));
		const proc = Bun.spawn(
			["pdftoppm", "-jpeg", "-r", String(RENDER_DPI), localPath, join(outDir, "page")],
			{ stdout: "ignore", stderr: "pipe" },
		);
		if ((await proc.exited) !== 0) {
			throw new Error(`pdftoppm failed: ${(await new Response(proc.stderr).text()).trim()}`);
		}
		await updateProgress(jobId, 40);

		// Sorted by name, which poppler zero-pads — so lexical order IS page order. Reading
		// the directory rather than assuming the filenames means a document poppler numbered
		// differently than expected still lands in the right sequence.
		const files = (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
		if (files.length === 0) throw new Error("pdftoppm produced no pages");

		// A re-run replaces the pages rather than appending to them. Without this, a job
		// retried after a partial upload leaves the book with two copies of page one and a
		// unique-index violation on the second.
		await db.delete(workPages).where(eq(workPages.workId, work.id));

		const prefix = `creators/${work.creatorId}/ebook/${work.id}/${randomUUID().replace(/-/g, "")}`;
		for (const [i, file] of files.entries()) {
			const bytes = new Uint8Array(await readFile(join(outDir, file)));
			const key = `${prefix}/page-${String(i + 1).padStart(4, "0")}.jpg`;
			// 🚨 PRIVATE, like every other derived object. The whole reason for this job is
			// that pages can be checked one at a time; a public page defeats it entirely.
			await storage.upload(key, bytes, "image/jpeg", "private");
			await db.insert(workPages).values({ workId: work.id, pageNumber: i + 1, file: key });

			// 40 → 95 across the upload, which is where the wall-clock actually goes.
			if (i % 5 === 0 || i === files.length - 1) {
				await updateProgress(jobId, 40 + Math.round(((i + 1) / files.length) * 55));
			}
		}

		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100, etaSeconds: null, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		console.log(`[rasterize-ebook] work ${work.id} → ${files.length} page(s)`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		if (localPath) await rm(localPath, { force: true });
		if (outDir) await rm(outDir, { recursive: true, force: true });
	}
}

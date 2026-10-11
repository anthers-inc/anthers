// SPDX-License-Identifier: Apache-2.0
/**
 * Rasterize an **ebook** Work: its source set in, one private page image out per rendered page.
 *
 * 🚨 **Why this job exists at all, when the creator already uploaded a perfectly good
 * PDF.** The delivery rule is that every derived media object is stored private and every
 * URL to one is minted per request at an endpoint that re-resolves access — and a PDF is
 * *one* object. A user pointed at a signed URL for it has the whole book the moment page
 * one opens, which makes `downloadEnabled: false` a lie for this medium specifically and
 * would surprise a creator who deliberately turned downloads off. Pages are to a book what
 * HLS segments are to a video: the unit that can actually be checked.
 *
 * The happy side effect is that the *client* gets simpler, not heavier — the user shows
 * images, so no PDF parser (~1 MB) ships to the browser at all.
 *
 * 🚨 **The source is a SET since the multi-PDF ruling** (Parker, 2026-10-10): every file's
 * rendered pages become a contiguous run, in the set's order. Each file renders with its own
 * `pdftoppm` invocation — one per file, never per page, for the same reason the single-file
 * shape used one per document: one invocation parses the document once. The pages are
 * numbered across the whole set, so a comic's page 1 is wherever the creator put it.
 *
 * Uses **poppler** (`pdfinfo` + `pdftoppm`), a system dependency alongside ffmpeg. Absent,
 * this fails the job with a legible message rather than half-rendering: a book missing pages
 * 40–96 is worse than one that plainly did not process.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, workPages, workPanels, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { detectPanels, sampleInkColor } from "../lib/panel-detection.js";
import { storage } from "../services/storage/index.js";
import { listSourceFiles } from "../services/work-source-files.js";

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
		.set({ status: "processing", progress: 0, updatedAt: new Date() })
		.where(eq(transcodingJobs.id, jobId));

	const [work] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!work) throw new Error(`Work ${job.workId} not found`);

	const sources = await listSourceFiles(work);
	if (sources.length === 0) throw new Error("No source file on this Work");

	/** Per-source temp dirs, plus each source's downloaded bytes; cleaned in `finally`. */
	const scratch: string[] = [];
	const downloaded: string[] = [];
	/** The already-rendered page files, per source, in page order — uploaded after all render. */
	const rendered: string[][] = [];

	try {
		if (!(await popplerAvailable())) {
			throw new Error(
				"poppler (pdftoppm) is not installed on this host — an ebook cannot be rendered",
			);
		}

		// Pre-count every source before rendering any: the ceiling is the SET's page total,
		// and refusing an over-ceiling set before the first pdftoppm runs is what keeps one
		// pathological upload from spending an hour rendering two thousand pages it will
		// not keep. (Also the moment a file that is not a PDF fails, with its name.)
		// 5% is pre-flight; nothing has rendered.
		let totalPages = 0;
		for (const source of sources) {
			const path = await storage.downloadToTemp(source.file);
			downloaded.push(path);
			const count = await pageCount(path);
			if (count < 1) {
				throw new Error(`A source file has no pages: ${source.filename || source.file}`);
			}
			totalPages += count;
			if (totalPages > MAX_PAGES) {
				throw new Error(`This set would render ${totalPages} pages; the limit is ${MAX_PAGES}`);
			}
		}
		await updateProgress(jobId, 5);

		for (const [i, source] of sources.entries()) {
			/*
			 * Render this file in one `pdftoppm` invocation rather than page by page.
			 *
			 * Poppler parses the document once and writes `page-001.jpg`, `page-002.jpg`, ….
			 * Spawning it per page re-parses the file every time, which on a 200-page graphic
			 * novel is the difference between one pass and two hundred.
			 */
			const dir = await mkdtemp(join(tmpdir(), `ebook_${i}_`));
			scratch.push(dir);
			const proc = Bun.spawn(
				["pdftoppm", "-jpeg", "-r", String(RENDER_DPI), downloaded[i], join(dir, "page")],
				{ stdout: "ignore", stderr: "pipe" },
			);
			if ((await proc.exited) !== 0) {
				throw new Error(
					`pdftoppm failed for ${source.filename || source.file}: ${(await new Response(proc.stderr).text()).trim()}`,
				);
			}
			// Sorted by name, which poppler zero-pads — so lexical order IS page order.
			// Reading the directory rather than assuming the filenames means a document that
			// poppler numbered differently than expected still lands in the right sequence.
			const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
			if (files.length === 0) {
				throw new Error(`pdftoppm produced no pages for ${source.filename || source.file}`);
			}
			rendered.push(files.map((f) => join(dir, f)));
		}
		// 🚨 The source's temp copy dies HERE — the moment poppler's pass ends — not in the
		// finally below. Everything after this line is uploads and database writes; holding
		// a delivered PDF's whole copy through them is residency the caps have no reason
		// to pay for. (Poppler reads a file, so this job cannot read in place the way the
		// ffmpeg jobs can; the one thing it never does is keep the copy a moment past its
		// only reader's death.)
		await rm(localPath, { force: true }).catch(() => {});
		localPath = null;
		await updateProgress(jobId, 40);

		// A re-run replaces the pages rather than appending to them. Without this, a job
		// retried after a partial upload leaves the book with two copies of page one and a
		// unique-index violation on the second.
		await db.delete(workPages).where(eq(workPages.workId, work.id));

		const prefix = `creators/${work.creatorId}/ebook/${work.id}/${randomUUID().replace(/-/g, "")}`;
		const flat = rendered.flat();
		for (const [i, file] of flat.entries()) {
			const bytes = new Uint8Array(await readFile(file));
			const key = `${prefix}/page-${String(i + 1).padStart(4, "0")}.jpg`;
			// 🚨 PRIVATE, like every other derived object. The whole reason for this job is
			// that pages can be checked one at a time; a public page defeats it entirely.
			await storage.upload(key, bytes, "image/jpeg", "private");
			// This page is off the disk the moment its upload lands, same as the
			// transcode's segments — the directory holds only pages not yet uploaded.
			await rm(join(outDir, file)).catch(() => {});

			const metadata = await sharp(bytes).metadata();
			const width = metadata.width ?? 0;
			const height = metadata.height ?? 0;

			const [page] = await db
				.insert(workPages)
				.values({ workId: work.id, pageNumber: i + 1, file: key, width, height })
				.returning({ id: workPages.id });

			// Panel detection runs on every page. Comics need regions; prose books gracefully
			// degrade to one whole-page panel. The detector is fast enough on 150 DPI pages that
			// doing it inline adds no separate job.
			try {
				const inkColor = await sampleInkColor(bytes);
				const panels = await detectPanels(bytes, { inkColor });
				if (panels.length > 0 && page) {
					await db.insert(workPanels).values(
						panels.map((p, panelNumber) => ({
							pageId: page.id,
							panelNumber: panelNumber + 1,
							x: p.x,
							y: p.y,
							width: p.width,
							height: p.height,
							auto: true,
						})),
					);
				}
			} catch (detectionError) {
				const message =
					detectionError instanceof Error ? detectionError.message : String(detectionError);
				console.warn(
					`[rasterize-ebook] panel detection failed for work ${work.id} page ${i + 1}: ${message}`,
				);
				// A detection failure leaves the page without panels, which the user treats as
				// whole-page fallback. The job continues.
			}

			// 40 → 95 across the upload, which is where the wall-clock actually goes.
			if (i % 5 === 0 || i === flat.length - 1) {
				await updateProgress(jobId, 40 + Math.round(((i + 1) / flat.length) * 55));
			}
		}

		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100, etaSeconds: null, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		console.log(
			`[rasterize-ebook] work ${work.id} → ${flat.length} page(s) from ${sources.length} file(s)`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		for (const path of downloaded) await rm(path, { force: true });
		for (const dir of scratch) await rm(dir, { recursive: true, force: true });
	}
}

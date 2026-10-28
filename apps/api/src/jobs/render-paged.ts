// SPDX-License-Identifier: Apache-2.0
/**
 * Render a **paged** Work's source set — a comic or a book — into private per-page images.
 *
 * 🚨 **Why pages at all, when the creator uploaded a perfectly good file.** The delivery
 * rule is that every derived media object is stored private and every URL to one is minted
 * per request at an endpoint that re-resolves access — and a PDF or a page set handed over
 * as *one* object defeats that. A user pointed at a signed URL for the whole book has the
 * whole book the moment page one opens, which makes `downloadEnabled: false` a lie for this
 * medium specifically and would surprise a creator who deliberately turned downloads off.
 * Pages are to a book what HLS segments are to a video: the unit that can actually be
 * checked.
 *
 * 🚨 **The source is a SET** (Parker, 2026-10-10): every file's pages become a contiguous
 * run, in the set's order. The pages are numbered across the whole set, so a comic's page 1
 * is wherever the creator put it. An image leaf (Parker, 2026-10-11: images are the lead
 * path) *is* one page — it normalizes rather than renders; a PDF renders with one
 * `pdftoppm` invocation per file, never per page, because one invocation parses the
 * document once. A download, where enabled, hands over the source files rather than these;
 * the hosted pages are the reader's artifact, the sources the provenance.
 *
 * Uses **poppler** (`pdfinfo` + `pdftoppm`), a system dependency alongside ffmpeg, and
 * `sharp` for the image path. Absent poppler, this fails the job with a legible message
 * rather than half-rendering: a book missing pages 40–96 is worse than one that plainly
 * did not process.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, workPages, works } from "@anthers/db/schema";
import { and, desc, eq, gt } from "drizzle-orm";
import sharp from "sharp";
import { isEpubSource } from "../lib/paged-ingest.js";
import { detectPanels, sampleInkColor } from "../lib/panel-detection.js";
import { storage } from "../services/storage/index.js";
import { listSourceFiles } from "../services/work-source-files.js";
import { withAdvisoryLock } from "./advisory-lock.js";
import { MAX_TRANSCODE_RESUMES } from "./resume-orphans.js";

export interface RenderPagedData {
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

/**
 * The longest side a hosted page image may have. An image leaf arrives at whatever
 * dimensions its creator's export wrote; without a bound, one 200-megapixel upload would
 * pay for its own decode forever in every reader's bandwidth. 4096 answers more detail
 * than a retina reading surface shows, and `withoutEnlargement` leaves anything smaller
 * alone — the bound is a ceiling on the pathological, never a downscaler of the honest.
 */
const PAGE_MAX_PIXELS = 4096;

/**
 * The source mime types the job takes as image leaves — one page, normalized by `sharp`.
 * Anything else that claims to be a page is a PDF; anything else at all fails the job
 * with the file's name, rather than half a set.
 */
function isPageImage(mimeType: string): boolean {
	return mimeType === "image/jpeg" || mimeType === "image/png";
}

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

/**
 * Whether the job's row still reads `processing` — the run's own claim state. Anything
 * else means the outside world settled the row (the creator's cancel route marks it
 * `canceled`), and a run that discovers this stops quietly rather than finishing on its
 * own schedule.
 */
async function stillProcessing(jobId: number): Promise<boolean> {
	const [row] = await db
		.select({ status: transcodingJobs.status })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	return row?.status === "processing";
}

/**
 * The paged renderer's lock is keyed on the **Work**, not the job.
 *
 * 🚨 **A page-by-page upload is one mutation per file, and the queue held 120 jobs for
 * one comic** (Work 66, 2026-10-19). They were delivered two at a time, and two runs for
 * the same Work interleaved `delete(work_pages)` with `insert(page)` until
 * `uq_work_pages` refused the second — eleven failed queue rows, ten failed job rows.
 * A job-keyed lock would not have helped: the colliding handlers held different jobs.
 *
 * Namespaced above the serial id space and above `TRANSCODE_LOCK_KEY_BASE`, so neither
 * family can collide with the other. The waiting mechanics are the shared
 * `withAdvisoryLock` in `./advisory-lock.ts`; the re-read after acquiring is this job's
 * own, because a delivery that waited may find its row already finished.
 */
export const PAGED_RENDER_LOCK_KEY_BASE = 9_100_000_000_000;

export function withPagedRenderLock<T>(
	workId: number,
	fn: () => Promise<T>,
	pollMs?: number,
): Promise<T> {
	return withAdvisoryLock(
		PAGED_RENDER_LOCK_KEY_BASE + workId,
		`[render-paged] work ${workId}`,
		fn,
		pollMs,
	);
}

export async function renderPaged(data: RenderPagedData) {
	const { jobId } = data;

	const [claimed] = await db
		.select({ workId: transcodingJobs.workId })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!claimed) throw new Error(`TranscodingJob ${jobId} not found`);

	return withPagedRenderLock(claimed.workId, () => runPagedRender(jobId));
}

async function runPagedRender(jobId: number) {
	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	// Idempotency: a late pg-boss retry of a job already finished (e.g. by the worker's
	// startup-resume path) is a no-op, exactly as the other two jobs treat it. A row the
	// boot sweep finally failed — its crash-resume ceiling spent — is equally final, and
	// must not be resurrected by a stale redelivery; a failed row BELOW the bound stays
	// re-runnable on purpose, as the queue's ordinary self-healing within its budget.
	if (job.status === "completed") {
		console.log(`[render-paged] job ${jobId} already completed; skipping`);
		return;
	}
	// 🚨 A canceled row is final: the creator stopped it, and a stale redelivery must
	// not resume what they stopped.
	if (job.status === "canceled") {
		console.log(`[render-paged] job ${jobId} canceled; skipping`);
		return;
	}
	if (job.status === "failed" && job.resumeCount >= MAX_TRANSCODE_RESUMES) {
		console.log(`[render-paged] job ${jobId} failed past its resume bound; skipping`);
		return;
	}

	// 🚨 **One render wins per Work; every earlier job settles without rendering.** A
	// 120-page upload enqueued 120 full-set renders, and the queue delivered them two at
	// a time — the storm this lock and this check exist for. The newest job reads the set
	// as it stands when it runs, so the older ones have nothing to add. A newest job that
	// is `failed` is the exception: it is not going to render, so this one may be the only
	// chance left and runs. A newest job that is `canceled` carries the creator's stop
	// forward, so this one settles canceled rather than resurrecting the work.
	const [newest] = await db
		.select({ id: transcodingJobs.id, status: transcodingJobs.status })
		.from(transcodingJobs)
		.where(
			and(
				eq(transcodingJobs.workId, job.workId),
				eq(transcodingJobs.mediaType, "ebook"),
				gt(transcodingJobs.id, jobId),
			),
		)
		.orderBy(desc(transcodingJobs.id))
		.limit(1);
	if (newest && newest.status !== "failed") {
		const settled = newest.status === "canceled" ? "canceled" : "completed";
		console.log(
			`[render-paged] job ${jobId} superseded by job ${newest.id}; settling ${settled} without rendering`,
		);
		if (settled === "canceled") {
			await db
				.update(transcodingJobs)
				.set({ status: "canceled", etaSeconds: null, errorMessage: "", updatedAt: new Date() })
				.where(eq(transcodingJobs.id, jobId));
		} else {
			await db
				.update(transcodingJobs)
				.set({
					status: "completed",
					progress: 100,
					etaSeconds: null,
					errorMessage: "",
					updatedAt: new Date(),
				})
				.where(eq(transcodingJobs.id, jobId));
		}
		return;
	}

	// The claim spends any benign-interruption flag the previous stop left: a run
	// reaching the row has consumed the excuse, so whatever kills THIS run says for
	// itself.
	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0, interruptedGracefully: false, updatedAt: new Date() })
		.where(eq(transcodingJobs.id, jobId));

	const [work] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!work) throw new Error(`Work ${job.workId} not found`);

	const sources = await listSourceFiles(work);
	if (sources.length === 0) throw new Error("No source file on this Work");

	/** Per-source temp dirs, plus each source's downloaded bytes; cleaned in `finally`. */
	const scratch: string[] = [];
	const downloaded: string[] = [];
	/** The already-rendered normalized pages, per source, in page order — uploaded after all render. */
	const rendered: { file: string; mime: "image/jpeg" | "image/png" }[][] = [];

	try {
		if (!(await popplerAvailable())) {
			throw new Error(
				"poppler (pdftoppm) is not installed on this host — an ebook cannot be rendered",
			);
		}

		// An EPUB in the set is not this job's input — it extracts on the reflow path
		// (`ingest-ebook`). Failing legibly and INSIDE the try (so the refusal lands on
		// the row the status badge reads, not stranding it at "processing" — the same
		// shape the ingest's own shape guards hold), this catches the paths that bypass
		// routing: a legacy `.epub` attach, a resume resolved before the ingest split.
		const epubSource = sources.find((s) => isEpubSource(s));
		if (epubSource) {
			throw new Error(
				`This set contains an EPUB (${epubSource.filename || epubSource.file}), and the page renderer takes PDFs and page images — an EPUB processes as a reflow ebook; replace the source or remove the EPUB`,
			);
		}

		// Pre-count every source before rendering any: the ceiling is the SET's page total,
		// and refusing an over-ceiling set before the first render runs is what keeps one
		// pathological upload from spending an hour rendering two thousand pages it will
		// not keep. (Also the moment anything unreadable fails, with its name.)
		// 5% is pre-flight; nothing has rendered.
		let totalPages = 0;
		for (const source of sources) {
			const path = await storage.downloadToTemp(source.file);
			downloaded.push(path);
			if (isPageImage(source.mimeType)) {
				// An image leaf IS one page. Reading its metadata rather than counting
				// pages both fixes the count and is the moment a corrupt image fails —
				// with its name, the way `pdfinfo` fails an unreadable PDF.
				const metadata = await sharp(path).metadata();
				if (!metadata.width || !metadata.height) {
					throw new Error(`A source image is unreadable: ${source.filename || source.file}`);
				}
				totalPages += 1;
			} else {
				const count = await pageCount(path);
				if (count < 1) {
					throw new Error(`A source file has no pages: ${source.filename || source.file}`);
				}
				totalPages += count;
			}
			if (totalPages > MAX_PAGES) {
				throw new Error(`This set would render ${totalPages} pages; the limit is ${MAX_PAGES}`);
			}
		}
		await updateProgress(jobId, 5);

		for (const [i, source] of sources.entries()) {
			// ⭐ The cancel checkpoint, one per source render — the render pass is the long
			// pole of this job, and pages render into temp files that the `finally` frees,
			// so a run stopped here abandons cheaply: workPages untouched, nothing uploaded.
			// Anything no longer `processing` (the creator's cancel route marks it
			// `canceled`) stops the run, the same shape the video job's supersession checks
			// take.
			if (!(await stillProcessing(jobId))) {
				console.log(`[render-paged] job ${jobId} no longer processing; abandoning at source ${i}`);
				return;
			}
			const dir = await mkdtemp(join(tmpdir(), `ebook_${i}_`));
			scratch.push(dir);
			if (isPageImage(source.mimeType)) {
				/*
				 * An image leaf IS its page, so it normalizes rather than renders: one `sharp`
				 * pass, then straight into the pages. What the pass is for — the hosted page is
				 * the artifact the reader gets, so it must not come out dependent on how the
				 * creator's camera or export tool happened to write it: orientation baked in
				 * and its metadata (which reads orientation, location, sometimes the tool's
				 * profile) stripped, decoded dimensions bounded so a pathological upload costs
				 * bounded decode and bandwidth, and the format kept (PNG stays PNG; line art
				 * keeps its crispness, and the source's own quality is what is served —
				 * creator-controlled, as the set story promises).
				 */
				const normalized = sharp(downloaded[i]).rotate().resize({
					width: PAGE_MAX_PIXELS,
					height: PAGE_MAX_PIXELS,
					fit: "inside",
					withoutEnlargement: true,
				});
				const ext = source.mimeType === "image/png" ? "png" : "jpg";
				const leafPage = join(dir, `leaf-001.${ext}`);
				await (ext === "png" ? normalized.png() : normalized.jpeg({ quality: 85 })).toFile(
					leafPage,
				);
				rendered.push([{ file: leafPage, mime: ext === "png" ? "image/png" : "image/jpeg" }]);
			} else {
				/*
				 * Render this file in one `pdftoppm` invocation rather than page by page.
				 *
				 * Poppler parses the document once and writes `page-001.jpg`, `page-002.jpg`, ….
				 * Spawning it per page re-parses the file every time, which on a 200-page graphic
				 * novel is the difference between one pass and two hundred.
				 */
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
				rendered.push(files.map((f) => ({ file: join(dir, f), mime: "image/jpeg" })));
			}
			// 🚨 This source's temp copy dies HERE — the moment its processing pass ends — not
			// in the finally below. Everything after the render loop is uploads and database
			// writes; holding a delivered file's copy through them is residency the caps have
			// no reason to pay for. (pdftoppm and sharp both read files, so neither reads in
			// place the way the ffmpeg jobs can; the one thing this job never does is keep a
			// copy a moment past its only reader's death.)
			await rm(downloaded[i], { force: true }).catch(() => {});
			downloaded[i] = "";
		}
		await updateProgress(jobId, 40);

		// A re-run replaces the pages rather than appending to them. Without this, a job
		// retried after a partial upload leaves the book with two copies of page one and a
		// unique-index violation on the second.
		//
		// ⭐ This is also the point of no return for a cancel: the pages' rows are about to
		// be cleared and rewritten, so a cancel that arrives after it takes effect at the
		// run's next render rather than here — past this line the run finishes and writes
		// `completed`, the settlement that is consistent with the pages it is replacing.
		if (!(await stillProcessing(jobId))) {
			console.log(
				`[render-paged] job ${jobId} no longer processing; abandoning before the page pass`,
			);
			return;
		}
		// 🚨 **The pages this run replaces leave storage with their rows.** Only the current
		// version keeps rendered pages (the 2026-10-23 version ruling), so a re-render after a
		// set replacement must not leave the prior version's page images behind: the version
		// archive holds the originals, and these are derived copies nothing points at again.
		const priorPages = await db
			.select({ file: workPages.file })
			.from(workPages)
			.where(eq(workPages.workId, work.id));
		await db.delete(workPages).where(eq(workPages.workId, work.id));
		for (const page of priorPages) await storage.delete(page.file).catch(() => {});

		const prefix = `creators/${work.creatorId}/ebook/${work.id}/${randomUUID().replace(/-/g, "")}`;
		const flat = rendered.flat();
		for (const [i, page_] of flat.entries()) {
			const bytes = new Uint8Array(await readFile(page_.file));
			// The extension and content type follow the page's own format: JPEG for what the
			// pdftoppm pass wrote and for JPEG leaves, PNG for PNG leaves — which is also
			// what the reader's <img> serves and what a download of "just this page" gets.
			const ext = page_.mime === "image/png" ? "png" : "jpg";
			const key = `${prefix}/page-${String(i + 1).padStart(4, "0")}.${ext}`;
			// 🚨 PRIVATE, like every other derived object. The whole reason for this job is
			// that pages can be checked one at a time; a public page defeats it entirely.
			await storage.upload(key, bytes, page_.mime, "private");
			// This page is off the disk the moment its upload lands, same as the
			// transcode's segments — the scratch dirs hold only pages not yet uploaded.
			await rm(page_.file, { force: true }).catch(() => {});

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
					await db
						.update(workPages)
						.set({
							panels: panels.map((p, panelNumber) => ({
								panelNumber: panelNumber + 1,
								x: p.x,
								y: p.y,
								width: p.width,
								height: p.height,
								auto: true,
							})),
						})
						.where(eq(workPages.id, page.id));
				}
			} catch (detectionError) {
				const message =
					detectionError instanceof Error ? detectionError.message : String(detectionError);
				console.warn(
					`[render-paged] panel detection failed for work ${work.id} page ${i + 1}: ${message}`,
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
			.set({
				status: "completed",
				progress: 100,
				etaSeconds: null,
				// A retry that lands after an earlier attempt failed must not leave its
				// error text on a row that is now finished — that is what the Studio reads.
				errorMessage: "",
				updatedAt: new Date(),
			})
			.where(eq(transcodingJobs.id, jobId));
		console.log(
			`[render-paged] work ${work.id} → ${flat.length} page(s) from ${sources.length} file(s)`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		// Rendered sources were emptied at each pass's end; a failure before that still
		// leaves the copy holding — the guard keeps the finally from rm-ing empty strings.
		for (const path of downloaded) if (path) await rm(path, { force: true });
		for (const dir of scratch) await rm(dir, { recursive: true, force: true });
	}
}

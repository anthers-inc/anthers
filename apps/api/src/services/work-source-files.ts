// SPDX-License-Identifier: Apache-2.0
/**
 * The source set of a paged Work — the one writer of `work_source_files` rows.
 *
 * 🚨 **A comic's pages are JPG or PNG images, and a book's are images, a PDF or an EPUB**
 * (Parker, 2026-10-19 for the comic half; the multi-PDF ruling of 2026-10-10 for the rest).
 * A comic no longer takes a PDF: its pages are already pages, so each keeps its own
 * resolution and one `sharp` normalize replaces a `pdftoppm` rasterization. A book still
 * takes a PDF beside its EPUB because a prose document without one is a harder ask, and a
 * page image set is its third shape. The PDF branch in `render-paged` stays for books and
 * for every comic whose pages already arrived that way — this refusal is on new sources,
 * never a re-read of an existing set. This service owns every write to the table — append,
 * remove, reorder and the legacy attach sync — the way `services/quarantine.ts` owns its
 * domain: routes stay thin, and the invariants (dense positions, one re-render enqueued per
 * mutation) live here where they can be seen.
 *
 * 🚨 **One mutation, one re-render — and a pick is one mutation.** The rasterizer renders
 * the whole current set each time and replaces the Work's pages wholesale, so the re-render
 * the last mutation enqueued is always the correct response to the set a creator sees; two
 * mutations in quick succession enqueue two jobs, and the later one wins on rendering (they
 * serialize on the queue) — never re-order around this, and never skip it for what looks like
 * a no-op change. ⚠️ **A multi-file add arrives as ONE mutation** ({@link appendSourceFiles}):
 * a hundred-file pick sent as a hundred appends would enqueue a hundred renders, each
 * re-uploading the whole set, which is quadratic work for a set that grew by one.
 *
 * **The image kind's set is the gallery the Work displays** (2026-10-18): an image Work that
 * carries more than one source renders them all, in position order, and the set admits only
 * images. Its mutations render nothing and enqueue nothing — the files ARE the deliverable —
 * so `askRerender`'s no-op for them is the whole pipeline. What follows the legacy column
 * differs by family instead: a paged set leaves its Work's `source_key` on the newest file
 * (the old readers read it only as presence), while an image set updates it to the **first**
 * file on every mutation, because for an image Work the column is the cover — the thumbnail,
 * the listing image, the release gate's media presence — and "the Work's image" means the set's
 * first picture.
 *
 * ⚠️ **The legacy `works.source_key` column stays the truth for every other kind** and is
 * synced INTO this table for the set kinds by {@link syncFromSourceKey}, so an old client or a
 * raw PATCH that attaches a source the old way still produces the row the pipeline reads.
 */

import { db } from "@anthers/db/client";
import { transcodingJobs, workSourceFiles, works } from "@anthers/db/schema";
import { hasSourceSet, isPaged } from "@anthers/shared/content";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { routePagedIngest } from "../lib/paged-ingest.js";
import { removeSourceFileStorage } from "./media-purge.js";

export type WorkSourceFileRow = typeof workSourceFiles.$inferSelect;
export type TranscodingJobRow = typeof transcodingJobs.$inferSelect;
export type WorkRow = typeof works.$inferSelect;

/** The fields of a Work `listSourceFiles` reads — what a caller holding only ids and keys passes. */
type WorkSourceRef = Pick<WorkRow, "id" | "type" | "sourceKey">;

/** The image extensions the display half reads, mapped to the mimes a set row stores. */
const IMAGE_MIMES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
};

/** The image mime an uploaded file or legacy column value carries, read off its extension. */
function imageMimeFromUrl(urlOrKey: string): string {
	const name = urlOrKey.split(/[?#]/)[0].split("/").pop() ?? "";
	const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
	return IMAGE_MIMES[ext] ?? "image";
}

/**
 * Whether a source may stand in an image Work's set: an image mime, the `image` marker a
 * legacy row stores when its extension says nothing, or a file whose extension is one the
 * display half reads. A PDF or an EPUB is the ordinary refusal — the guard exists so a
 * mixed upload cannot hand a gallery a file no browser renders.
 */
function looksLikeImage(source: { mimeType: string; file: string }): boolean {
	const mime = source.mimeType ?? "";
	if (mime.startsWith("image/") || mime === "image") return true;
	return IMAGE_MIMES[(source.file.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase()] != null;
}

/**
 * Whether a source is a PDF, by the mime the client reported or the name the file carries.
 * The key's extension is what a legacy attach has to go on; a paged row's own mime is the
 * client's answer.
 */
function isPdfSource(source: { mimeType?: string; filename?: string; file: string }): boolean {
	if (source.mimeType === "application/pdf") return true;
	if (/\.pdf$/i.test(source.filename ?? "")) return true;
	return /\.pdf$/i.test(source.file.split(/[?#]/)[0]);
}

/**
 * Why a comic cannot take this file, or null when it may.
 *
 * 🚨 **A comic's pages are images now** (Parker, 2026-10-19): a 1.31 GB, 119-page PDF took
 * 25m53s on production, 20 minutes of it in one `pdftoppm` pass, while an image leaf is
 * already a page and needs one `sharp` normalize. The refusal is on a NEW source only —
 * a comic already carrying PDF pages keeps them, and `render-paged` keeps its PDF branch —
 * so this is a rule about what a creator can add, never a retroactive re-read.
 *
 * ⚠️ Books are deliberately left out: a prose book is still practical as a PDF, and the
 * same route serves both kinds, so the check is by Work type rather than by format alone.
 */
export function comicSourceProblem(
	workType: string,
	source: { mimeType?: string; filename?: string; file: string },
): string | null {
	if (workType !== "comic" || !isPdfSource(source)) return null;
	const name = source.filename || "That file";
	return `${name} is a PDF, and a comic's pages are JPG or PNG images now. Export its pages as images and add them in order.`;
}

/** The Work's sources, from the table when it has rows and from the legacy column when not. */
export async function listSourceFiles(work: WorkSourceRef): Promise<WorkSourceFileRow[]> {
	const stored = await db
		.select()
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, work.id))
		.orderBy(asc(workSourceFiles.position));
	if (stored.length > 0) return stored;
	if (!work.sourceKey) return [];
	// A Work with a legacy column value and no rows yet: not yet backfilled or not yet
	// synced — read as the one-file set it represents. The mime is the PDF default a paged
	// file carries, or the image mime the URL's extension names for the image kind.
	return [
		{
			id: 0,
			workId: work.id,
			position: 0,
			file: work.sourceKey,
			filename: "",
			fileSize: null,
			mimeType: isPaged(work.type) ? "application/pdf" : imageMimeFromUrl(work.sourceKey),
			createdAt: new Date(),
		},
	];
}

/**
 * Sync a legacy attach (the `source_key` column, still the shape the Upload form's first
 * upload uses) into the table as the set's single row, and ask a re-render unless the table
 * already stands at exactly that file. The set REPLACEs on this sync: a set-kind Work
 * attaching by the old way says "this is the work", not "add it to the pages".
 */
export async function syncFromSourceKey(work: WorkRow): Promise<void> {
	if (!work.sourceKey) return;
	const rows = await listSourceFiles(work);
	if (rows.length === 1 && rows[0].id !== 0 && rows[0].file === work.sourceKey) return;
	// The replaced set's objects leave with its rows — the remove path follows the same
	// rule (`removeSourceFileStorage`), and a set replaced wholesale retires its files
	// the same way rather than leaving orphaned originals in the creator's prefix.
	for (const row of rows) {
		if (row.id !== 0) await removeSourceFileStorage(row, work.creatorId);
	}
	await db.delete(workSourceFiles).where(eq(workSourceFiles.workId, work.id));
	// An image row's stored value is the display URL the kind has always stored, and its
	// mime is what that URL's extension names; a paged row keeps the column's PDF default.
	await db.insert(workSourceFiles).values({
		workId: work.id,
		position: 0,
		file: work.sourceKey,
		...(isPaged(work.type) ? {} : { mimeType: imageMimeFromUrl(work.sourceKey) }),
	});
	await askRerender(work);
}

/** One file a pick is adding — the shape the `files` array of an append carries. */
export interface SourceFileInput {
	file: string;
	filename?: string;
	fileSize?: number | null;
	mimeType?: string;
}

/**
 * Append one or more owned files at the end of the set, renumber nothing, and re-render a
 * paged set ONCE for the whole pick.
 *
 * 🚨 **The pick is the mutation** (2026-10-19). `render-paged` renders the whole current set
 * and replaces the Work's pages each run, so appending a hundred-page comic one file at a
 * time enqueued a hundred renders — the first rendering one page, the last a hundred, and
 * every run re-uploading every page — quadratic work over a set that grows by one. The set
 * editors already upload a pick a file at a time for its progress and cancel; they hand the
 * whole pick over here in one request instead of one append per file.
 *
 * 🚨 **The whole pick is validated against the set it would produce before anything is
 * written**, so a pick carrying one refused file — a PDF in a comic, a non-image in a
 * gallery, an EPUB beside page images — writes nothing and enqueues no render rather than
 * half-landing.
 */
export async function appendSourceFiles(
	work: WorkRow,
	inputs: SourceFileInput[],
): Promise<{
	rows: WorkSourceFileRow[];
	job: TranscodingJobRow | null;
	code?: string;
	error?: string;
}> {
	if (!hasSourceSet(work.type)) {
		return { rows: [], job: null, error: "This kind of Work carries no file set." };
	}
	if (inputs.length === 0) {
		return { rows: [], job: null, error: "No files were given to add." };
	}

	const existing = await db
		.select()
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, work.id))
		.orderBy(asc(workSourceFiles.position));
	// 🚨 A comic's pages are images now, and the refusal is the service's so every writer
	// takes it (Parker, 2026-10-19). Existing PDF pages are untouched; this is a new source.
	for (const input of inputs) {
		const pdfProblem = comicSourceProblem(work.type, {
			mimeType: input.mimeType,
			filename: input.filename,
			file: input.file,
		});
		if (pdfProblem) {
			return { rows: existing, job: null, code: "comic_sources_are_images", error: pdfProblem };
		}
	}
	// 🚨 **The set is one shape** (the two-shape ingest of 2026-10-11): one EPUB makes the
	// set reflow, one PDF or page image makes it fixed, and mixing them lands nowhere.
	// Checked before anything is written, so a refused add leaves the set exactly as it was.
	const wouldBe = [
		...existing.map((r) => ({ mimeType: r.mimeType, filename: r.filename, file: r.file })),
		...inputs.map((input) => ({
			mimeType: input.mimeType ?? "",
			filename: input.filename ?? "",
			file: input.file,
		})),
	];
	// A legacy column file with no row joins the considered set the append would seed it
	// as — the list fallback's row, whose mime reads as the PDF default it has always read as
	// for the paged kinds, and as the image mime the URL's extension names for the image kind.
	const fallback =
		existing.length === 0 && work.sourceKey
			? [
					{
						mimeType: isPaged(work.type) ? "application/pdf" : imageMimeFromUrl(work.sourceKey),
						filename: "",
						file: work.sourceKey,
					},
				]
			: [];

	// 🚨 **An image Work's set admits only images.** Nothing renders a PDF inside a gallery,
	// and no ingest would process it — the guard is the whole pipeline's image check. It reads
	// the set the append would stand at, including the legacy seed, so a set that arrived
	// honest is never corrupted by one non-image row.
	if (work.type === "image" && ![...fallback, ...wouldBe].every(looksLikeImage)) {
		const offender = [...fallback, ...wouldBe].find((s) => !looksLikeImage(s));
		return {
			rows: existing,
			job: null,
			code: "sources_not_images",
			error: `An image gallery holds only images, and ${
				offender?.filename || offender?.file
			} isn't one. Pick an image file, or make a comic or a book of it instead.`,
		};
	}

	// The paged ingest routes by composition and refuses mixed shapes legibly; an image set
	// renders nothing, so it never reaches the router at all.
	if (isPaged(work.type)) {
		try {
			routePagedIngest([...fallback, ...wouldBe]);
		} catch (error) {
			return { rows: existing, job: null, error: error instanceof Error ? error.message : "mixed" };
		}
	}
	// 🚨 **A set that has grown past its legacy column carries the column's file with it.**
	// A Work with a legacy `source_key` and no rows (a fixture, or any source attached
	// before its first add) reads as the one-file set through the list fallback — so an
	// appending route seeds that file as position 0 rather than letting the set grow while
	// the column's file silently drops out of every render.
	//
	// ⚠️ **One transaction, and the Work's row is locked first.** Positions are dense and
	// unique per Work (`uq_work_source_files`), so two picks landing on one set at once — a
	// second tab beside this one — would otherwise race for the position the other just took.
	// The lock makes them queue; the unique index remains the backstop.
	await db.transaction(async (tx) => {
		await tx.select({ id: works.id }).from(works).where(eq(works.id, work.id)).for("update");
		if (existing.length === 0 && work.sourceKey) {
			await tx.insert(workSourceFiles).values({
				workId: work.id,
				position: 0,
				file: work.sourceKey,
				// The seed's mime: what the file's extension names for the image kind; the PDF
				// default for the paged kinds, whose legacy rows the 0138 backfill wrote the same way.
				...(isPaged(work.type) ? {} : { mimeType: imageMimeFromUrl(work.sourceKey) }),
			});
		}
		const [{ highest }] = await tx
			.select({ highest: max(workSourceFiles.position) })
			.from(workSourceFiles)
			.where(eq(workSourceFiles.workId, work.id));
		const first = (highest ?? -1) + 1;
		await tx.insert(workSourceFiles).values(
			inputs.map((input, i) => ({
				workId: work.id,
				position: first + i,
				file: input.file,
				filename: input.filename ?? "",
				fileSize: input.fileSize ?? null,
				mimeType:
					input.mimeType ?? (isPaged(work.type) ? "application/pdf" : imageMimeFromUrl(input.file)),
			})),
		);
	});
	const rows = await listSourceFiles(work);
	// The legacy column follows the set — it is what the old readers (the serializer's
	// resolution paths, storage-usage) read, and an empty column under a Work whose set is
	// non-empty is a lie those readers would tell. The two families follow differently, and
	// the difference is load-bearing: a paged column points at the set's NEWEST file (it is
	// read only as presence), while an image column points at the set's FIRST — for an image
	// Work the column IS the cover ("the Work's image" for listings, thumbnails and the
	// release gate), so it moves when the first row moves.
	await db
		.update(works)
		.set({ sourceKey: isPaged(work.type) ? inputs[inputs.length - 1].file : rows[0].file })
		.where(eq(works.id, work.id));
	const job = await askRerender(work);
	return { rows, job };
}

/** Remove one source by id, renumber the rest densely, and re-render. */
export async function removeSourceFile(
	work: WorkRow,
	fileId: number,
): Promise<TranscodingJobRow | null> {
	const [deleted] = await db
		.delete(workSourceFiles)
		.where(and(eq(workSourceFiles.workId, work.id), eq(workSourceFiles.id, fileId)))
		.returning();
	if (!deleted) return null;
	// The object leaves with the row: this mutation is the enumeration the sweep follows,
	// because the Work delete path reads only keys the Work still names.
	await removeSourceFileStorage(deleted, work.creatorId);
	const remaining = await db
		.select({ id: workSourceFiles.id })
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, work.id))
		.orderBy(asc(workSourceFiles.position));
	for (const [position, row] of remaining.entries()) {
		await db.update(workSourceFiles).set({ position }).where(eq(workSourceFiles.id, row.id));
	}
	// The set emptied: the Work has no media again. The legacy column follows it (an
	// empty set with a non-empty column would read as "file present, never processed",
	// one lie instead of none), and nothing is asked to render: an empty set renders
	// no pages, and the job the mutation would enqueue would only fail on the read.
	if (remaining.length === 0) {
		await db.update(works).set({ sourceKey: "" }).where(eq(works.id, work.id));
		return null;
	}
	// An image Work's column is its cover, so a removal that takes the first file moves
	// the cover to the set's new first image (and out of the column entirely when the
	// set emptied above). The paged kinds touch nothing here: their column points at
	// the newest file, which a removal of an earlier file does not change.
	if (work.type === "image") {
		const [first] = await db
			.select({ file: workSourceFiles.file })
			.from(workSourceFiles)
			.where(eq(workSourceFiles.workId, work.id))
			.orderBy(asc(workSourceFiles.position))
			.limit(1);
		if (first) await db.update(works).set({ sourceKey: first.file }).where(eq(works.id, work.id));
	}
	return askRerender(work);
}

/**
 * Reorder the set to an explicit id list and re-render. The order says MORE than any single
 * mutation: the client sends the whole arrangement it is showing, so the renumber is dense by
 * construction and a stale id list (one naming a file the set has lost) is refused rather than
 * partially written.
 */
export async function reorderSourceFiles(
	work: WorkRow,
	order: number[],
): Promise<{ rows?: WorkSourceFileRow[]; error?: string }> {
	const current = await db
		.select({ id: workSourceFiles.id })
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, work.id));
	const byId = new Set(current.map((r) => r.id));
	if (
		order.length !== current.length ||
		!order.every((id) => byId.has(id)) ||
		new Set(order).size !== order.length
	) {
		return { error: "That order doesn't match this Work's files." };
	}
	// 🚨 Renumbering into occupied positions collides with the unique index — moving the
	// first file to second, alone, would briefly hold two rows at position 1. So the whole
	// set is shifted out of the way first (every position rises past the list's length,
	// where no row currently sits), and the new order is written into the emptied range.
	await db
		.update(workSourceFiles)
		.set({ position: sql`${workSourceFiles.position} + ${current.length}` })
		.where(eq(workSourceFiles.workId, work.id));
	for (const [position, id] of order.entries()) {
		await db
			.update(workSourceFiles)
			.set({ position })
			.where(and(eq(workSourceFiles.id, id), eq(workSourceFiles.workId, work.id)));
	}
	// An image Work's column is its cover, and a reorder moves it when (and only when) the
	// arrangement puts a different image first — paged sets keep their newest-file column.
	const rows = await listSourceFiles(work);
	if (work.type === "image" && rows[0]) {
		await db.update(works).set({ sourceKey: rows[0].file }).where(eq(works.id, work.id));
	}
	await askRerender(work);
	return { rows };
}

/**
 * Ask a re-render: the transcoding job row the status surfaces read, and the queue entry the
 * worker drains. The ingest renders the whole current set, so one job covers any mutation
 * of it; the caller enqueues a scan beside it, because a new source is a new object to scan.
 *
 * 🚨 **The queue routes by composition** (`routePagedIngest`): a set with an EPUB in it is
 * reflow-shaped and extracts through `ingest-ebook`; every other set keeps rendering
 * through `render-paged` exactly as before. A mixed set cannot route anywhere — the
 * refusal is recorded on the job row the status badge reads, legibly, rather than thrown
 * out of an enqueue the creator is mid-way through.
 */
export async function askRerender(work: WorkRow): Promise<TranscodingJobRow | null> {
	if (!isPaged(work.type)) return null;
	const [job] = await db
		.insert(transcodingJobs)
		.values({ workId: work.id, mediaType: "ebook", status: "pending" })
		.returning();
	try {
		const target = routePagedIngest(await listSourceFiles(work));
		const queueName = target === "ingest-ebook" ? QUEUES.INGEST_EBOOK : QUEUES.RENDER_PAGED;
		await queue.send(queueName, { jobId: job.id }, JOB_OPTIONS[queueName]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, job.id));
		return { ...job, status: "failed", errorMessage: message };
	}
	return job;
}

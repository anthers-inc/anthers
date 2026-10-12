// SPDX-License-Identifier: Apache-2.0
/**
 * The source set of a paged Work — the one writer of `work_source_files` rows.
 *
 * The multi-PDF ruling (Parker, 2026-10-10): a comic or book is made from one PDF or several,
 * a single multi-page PDF meaning each of its rendered pages, several files meaning each
 * file's rendered pages as a contiguous run in the creator's arrangement. The design is the
 * wiki-internal *Multi-PDF Upload Design 20261010*. This service owns every write to the
 * table — append, remove, reorder and the legacy attach sync — the way `services/quarantine.ts`
 * owns its domain: routes stay thin, and the invariants (dense positions, one re-render
 * enqueued per mutation) live here where they can be seen.
 *
 * 🚨 **One mutation, one re-render.** The rasterizer renders the whole current set each time
 * and replaces the Work's pages wholesale, so the re-render the last mutation enqueued is
 * always the correct response to the set a creator sees; two mutations in quick succession
 * enqueue two jobs, and the later one wins on rendering (they serialize on the queue) — never
 * re-order around this, and never skip it for what looks like a no-op change.
 *
 * ⚠️ **The legacy `works.source_key` column stays the truth for every other kind** and is
 * synced INTO this table for paged kinds by {@link syncFromSourceKey}, so an old client or a
 * raw PATCH that attaches a source the old way still produces the row the pipeline reads.
 */

import { db } from "@anthers/db/client";
import { transcodingJobs, workSourceFiles, works } from "@anthers/db/schema";
import { isPaged } from "@anthers/shared/content";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { routePagedIngest } from "../lib/paged-ingest.js";
import { removeSourceFileStorage } from "./media-purge.js";

export type WorkSourceFileRow = typeof workSourceFiles.$inferSelect;
export type TranscodingJobRow = typeof transcodingJobs.$inferSelect;
export type WorkRow = typeof works.$inferSelect;

/** The fields of a Work `listSourceFiles` reads — what a caller holding only ids and keys passes. */
type WorkSourceRef = Pick<WorkRow, "id" | "sourceKey">;

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
	// synced — read as the one-file set it represents.
	return [
		{
			id: 0,
			workId: work.id,
			position: 0,
			file: work.sourceKey,
			filename: "",
			fileSize: null,
			mimeType: "application/pdf",
			createdAt: new Date(),
		},
	];
}

/**
 * Sync a legacy attach (the `source_key` column, still the shape the Upload form's first
 * upload uses) into the table as the set's single row, and ask a re-render unless the table
 * already stands at exactly that file. The set REPLACEs on this sync: a paged Work attaching
 * by the old way says "this is the book", not "add it to the pages".
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
	await db.insert(workSourceFiles).values({
		workId: work.id,
		position: 0,
		file: work.sourceKey,
	});
	await askRerender(work);
}

/** Append an owned file at the end of the set, renumber nothing, and re-render. */
export async function appendSourceFile(
	work: WorkRow,
	input: { file: string; filename?: string; fileSize?: number | null; mimeType?: string },
): Promise<{ rows: WorkSourceFileRow[]; job: TranscodingJobRow | null; error?: string }> {
	const existing = await db
		.select()
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, work.id))
		.orderBy(asc(workSourceFiles.position));
	// 🚨 **The set is one shape** (the two-shape ingest of 2026-10-11): one EPUB makes the
	// set reflow, one PDF or page image makes it fixed, and mixing them lands nowhere.
	// Checked before anything is written, so a refused add leaves the set exactly as it was.
	const wouldBe = [
		...existing.map((r) => ({ mimeType: r.mimeType, filename: r.filename, file: r.file })),
		{
			mimeType: input.mimeType ?? "",
			filename: input.filename ?? "",
			file: input.file,
		},
	];
	// A legacy column file with no row joins the considered set the append would seed it
	// as — the list fallback's row, whose mime reads as the PDF default it has always read as.
	const fallback =
		existing.length === 0 && work.sourceKey
			? [{ mimeType: "application/pdf", filename: "", file: work.sourceKey }]
			: [];
	try {
		routePagedIngest([...fallback, ...wouldBe]);
	} catch (error) {
		return { rows: existing, job: null, error: error instanceof Error ? error.message : "mixed" };
	}
	// 🚨 **A set that has grown past its legacy column carries the column's file with it.**
	// A Work with a legacy `source_key` and no rows (a fixture, or any source attached
	// before its first add) reads as the one-file set through the list fallback — so an
	// appending route seeds that file as position 0 rather than letting the set grow while
	// the column's file silently drops out of every render.
	if (existing.length === 0 && work.sourceKey) {
		await db.insert(workSourceFiles).values({
			workId: work.id,
			position: 0,
			file: work.sourceKey,
		});
	}
	const [{ highest }] = await db
		.select({ highest: max(workSourceFiles.position) })
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, work.id));
	await db.insert(workSourceFiles).values({
		workId: work.id,
		position: (highest ?? -1) + 1,
		file: input.file,
		filename: input.filename ?? "",
		fileSize: input.fileSize ?? null,
		mimeType: input.mimeType ?? "application/pdf",
	});
	// The legacy column keeps pointing at the set's most recent file. It is what the old
	// readers (the serializer's resolution paths, storage-usage) read, and an empty column
	// under a paged Work whose set is non-empty is a lie those readers would tell.
	await db.update(works).set({ sourceKey: input.file }).where(eq(works.id, work.id));
	const rows = await listSourceFiles(work);
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
	if (remaining.length === 0) {
		// The set emptied: the Work has no media again. The legacy column follows it (an
		// empty set with a non-empty column would read as "file present, never processed",
		// one lie instead of none), and nothing is asked to render: an empty set renders
		// no pages, and the job the mutation would enqueue would only fail on the read.
		await db.update(works).set({ sourceKey: "" }).where(eq(works.id, work.id));
		return null;
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
	await askRerender(work);
	return { rows: await listSourceFiles(work) };
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

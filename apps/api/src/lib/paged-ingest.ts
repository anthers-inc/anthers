// SPDX-License-Identifier: Apache-2.0
/**
 * Which paged ingest a Work's source set routes to.
 *
 * 🚨 **A composition function, not a per-file guess.** The 2026-10-11 design gave an ebook
 * Work's ingest result two shapes — fixed (`work_pages`, the page pipeline) and reflow
 * (`work_sections`, the EPUB extraction) — and the reader picks by what the ingest
 * produced, which means the whole set must land in ONE shape. The function here is the
 * one place that decision is made, and the one place it is TESTED: enqueueing and the
 * orphan-resume sweep both call it, so an orphaned EPUB ingest resumes onto the EPUB
 * handler rather than being rasterized as a one-page PDF called "Not a readable PDF".
 */

/** The fields of a source row the routing reads — structural, so nothing imports the owning service for them. */
type SourceShape = { mimeType: string; filename: string; file: string };

/** The EPUB identity the ingest trusts: the mime the client reported, or the name the file carries. */
export function isEpubSource(source: SourceShape): boolean {
	if (source.mimeType === "application/epub+zip") return true;
	return /\.epub$/i.test(source.filename ?? "");
}

/** The queue that drains each shape, as `QUEUES` names them. */
export type PagedIngestQueue = "ingest-ebook" | "render-paged";

/**
 * Route a paged Work's source set to its ingest. The set's shape is all-or-nothing: one
 * EPUB anywhere makes the set reflow-shaped (the reader picks reflow the moment any
 * section exists), so a set that mixes an EPUB with page-shaped files — a PDF, a page
 * image — is refused here rather than half-processed, named by the offending file.
 */
export function routePagedIngest(sources: SourceShape[]): PagedIngestQueue {
	const hasEpub = sources.some((s) => isEpubSource(s));
	const hasNonEpub = sources.some((s) => !isEpubSource(s));
	if (hasEpub && hasNonEpub) {
		const offender = sources.find((s) => !isEpubSource(s));
		throw new Error(
			`A reflow ebook cannot mix an EPUB with other file types, and this set mixes one in: ${offender?.filename || offender?.file} — upload the EPUB on its own, or keep the set to PDFs and page images`,
		);
	}
	return hasEpub ? "ingest-ebook" : "render-paged";
}

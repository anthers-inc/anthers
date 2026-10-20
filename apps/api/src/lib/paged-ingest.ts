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
 *
 * ⚠️ **The offender named is the shape that is outnumbered**, because that is the file the
 * creator can act on: one EPUB dropped into a page set names the EPUB, and one PDF dropped
 * into a reflow set names the PDF. A tie names the page-shaped file, the older assumption
 * that an EPUB set is the base one.
 */
export function routePagedIngest(sources: SourceShape[]): PagedIngestQueue {
	const epubCount = sources.filter((s) => isEpubSource(s)).length;
	const hasEpub = epubCount > 0;
	const hasNonEpub = epubCount < sources.length;
	if (hasEpub && hasNonEpub) {
		const offender =
			epubCount < sources.length - epubCount
				? sources.find((s) => isEpubSource(s))
				: sources.find((s) => !isEpubSource(s));
		throw new Error(
			`A reflow ebook cannot mix an EPUB with other file types, and this set mixes one in: ${offender?.filename || offender?.file} — upload the EPUB on its own, or keep the set to PDFs and page images`,
		);
	}
	return hasEpub ? "ingest-ebook" : "render-paged";
}

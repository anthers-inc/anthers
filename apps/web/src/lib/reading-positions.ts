// SPDX-License-Identifier: Apache-2.0
/**
 * Where a reader got to in a paged Work (`comic` and `ebook` — anything the
 * page-image pipeline serves), kept per Work in localStorage on this device.
 *
 * 🚨 **This module is the only writer of the two keys, and `ComicReader` reaches its
 * reads and writes through here rather than owning its own copy.** It was extracted from
 * the reader so a shelf-level view of "how far you got" (the Bookshelf lens's spine
 * markers) can read the same data without a component's private helpers becoming a
 * second surface's API — and so there is one place a later server-backed position store
 * replaces the local one.
 *
 * Deliberately unlike `listen-positions.ts` in two respects, both because a book shelf is
 * not a listening meter:
 *
 * - **No TTL.** A listen position expires after 30 days because a podcast feed moves on;
 *   a book does not, and losing your page in a novel you returned to is a worse
 *   experience than the staleness it was protecting against.
 * - **No finish-clearing.** Stopping on the last page is "finished" and stays — the
 *   shelf marker showing full is information, not a resume pointer to cancel.
 *
 * The panel key exists because panel mode moves *within* the same page numbers: both
 * keys carry a page for the same Work, and {@link readPageFraction} takes whichever is
 * further along, so the shelf marker does not go backwards when someone finished a comic
 * in page mode and later browsed a few panels.
 */
const READING_PROGRESS_KEY = "anthers_reading_progress";
const PANEL_PROGRESS_KEY = "anthers_panel_progress";

export interface PanelPosition {
	page: number;
	panel: number;
}

/** The stored page for a Work, or `null` when this device never recorded one. */
export function readStoredPage(workId: number): number | null {
	try {
		const raw = localStorage.getItem(READING_PROGRESS_KEY);
		if (!raw) return null;
		const page = (JSON.parse(raw) as Record<string, number>)[String(workId)];
		return Number.isInteger(page) && page > 0 ? page : null;
	} catch {
		return null;
	}
}

/** The stored page-and-panel position from panel mode, or `null` when never recorded. */
export function readStoredPanel(workId: number): PanelPosition | null {
	try {
		const raw = localStorage.getItem(PANEL_PROGRESS_KEY);
		if (!raw) return null;
		const p = (JSON.parse(raw) as Record<string, PanelPosition>)[String(workId)];
		if (p && Number.isInteger(p.page) && Number.isInteger(p.panel) && p.page > 0) return p;
	} catch {
		/* Unreadable store — the panel position reads as never recorded. */
	}
	return null;
}

/**
 * The reader's opening page for a Work: its stored page, defaulting to the first. The
 * same contract `ComicReader` has always read — "reopening a chapter resumes rather than
 * restarts" — with never-recorded and never-opened both meaning page one.
 */
export function readPage(workId: number): number {
	return readStoredPage(workId) ?? 1;
}

/** Persist which page a reader is on. Written only on real navigation, never on mount. */
export function writePage(workId: number, page: number): void {
	try {
		const raw = localStorage.getItem(READING_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
		map[String(workId)] = page;
		localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — the user simply always opens at page one. */
	}
}

/** Persist where within panel mode a reader got to, page and panel both. */
export function writePanel(workId: number, position: PanelPosition): void {
	try {
		const raw = localStorage.getItem(PANEL_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, PanelPosition>) : {};
		map[String(workId)] = position;
		localStorage.setItem(PANEL_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — panel progress does not persist. */
	}
}

/**
 * How far into a Work a reader got, as a 0–1 fraction of its pages, or `null` when the
 * shelf should show a spine without a marker: never opened, a `pageCount` the Work does
 * not carry (`text` Works, for instance, are not paged), or a position clamped past a
 * page count that changed.
 *
 * Both keys are read and the further-along page wins, because a reader may finish a
 * comic in page mode and later page a few panels in panel mode — the shelf marker has to
 * keep up with whichever mode they were last reading in.
 */
export function readPageFraction(
	workId: number,
	pageCount: number | null | undefined,
): number | null {
	if (pageCount == null || pageCount <= 0) return null;
	const page = Math.max(readStoredPage(workId) ?? 0, readStoredPanel(workId)?.page ?? 0);
	if (page <= 0) return null;
	return Math.min(page / pageCount, 1);
}

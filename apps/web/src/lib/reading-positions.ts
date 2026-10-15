// SPDX-License-Identifier: Apache-2.0
/**
 * Where a reader got to in a book Work — the reflow reader and the paged one both, and
 * since 2026-10-15 the server-backed row behind them.
 *
 * 🚨 **This module is the only writer of the four keys, and the readers reach their
 * reads and writes through here rather than owning their own copies.** It was extracted
 * from the reader so a shelf-level view of "how far you got" (the Bookshelf lens's spine
 * markers) can read the same data without a component's private helpers becoming a
 * second surface's API.
 *
 * ## The two stores and who wins
 *
 * **The local keys are the device store; the server row (`reading_positions`) is the
 * user's.** Every write lands locally first and is pushed behind it, throttled, as an
 * upsert — **newest-write-wins**, so the row says where the reader most recently
 * actually was, never the furthest they once got (a high-water rule would refuse a
 * re-read by dragging the opening back). Reads split by purpose:
 *
 * - **Resume** (the readers on open): this device's position when it has one — the
 *   person is reading here, and local IS current. When the device has none, the server
 *   row fills the absence through {@link refreshReadingPositions}'s adoption, so a new
 *   device opens where the last one left off. A device with no entry of its own never
 *   fights the row it is adopting.
 * - **The shelf** (the rail and ribbons): the *further-along* of the device's keys and
 *   the row — the shelf's marker never goes backwards on one device (the page-over-panel
 *   reconciliation), so it does not go backwards across the two stores either, and a
 *   device that has never read the Work shows the row. Signed-out readers keep
 *   exactly what this device knows, which this module answers for.
 *
 * Nothing here carries a clock comparison: which device pushed last is the server's
 * fact, and the adoption rule only fires on absence, so the stores never disagree about
 * the device the reader is actually holding.
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
 * in page mode and later browsed a few panels. That reconciliation is a same-device
 * detail between two live writers; the server never arbitrates modes.
 *
 * **The text key is a scroll fraction** — a scroll has no pages, so depth-scrolled is
 * the only honest mark, and it reads in the same 0–1 currency as every other book. A
 * sliver of scroll (below {@link SCROLL_OPEN_FLOOR}) is not an opening and is never
 * pushed; the local key records it regardless, so a tiny nudge never lies about depth.
 */
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

const READING_PROGRESS_KEY = "anthers_reading_progress";
const PANEL_PROGRESS_KEY = "anthers_panel_progress";
const REFLOW_PROGRESS_KEY = "anthers_reflow_progress";
const SCROLL_PROGRESS_KEY = "anthers_scroll_progress";

export interface PanelPosition {
	page: number;
	panel: number;
}

/** Where a reader got to in a reflow book, kept per Work on this device. */
export interface ReflowPosition {
	/**
	 * A foliate CFI — a fake one, since reflow sections carry no OPF-derived CFIs, which
	 * is exactly what the vendored view's own fallback resolves on reopen.
	 */
	cfi: string;
	/** The book-wide 0–1 fraction the shelf marker reads; refreshed alongside the CFI. */
	fraction: number;
}

/** A scroll depth below this is a nudge, not an opening, and is never pushed to the row. */
export const SCROLL_OPEN_FLOOR = 0.01;

// ── The server row ───────────────────────────────────────────────────────────

/** One `reading_positions` row, in the shape the API returns. */
export interface ServerPosition {
	workId: number;
	progress: number;
	position: Record<string, string | number | boolean>;
	updatedAt: string;
}

/** A row half — progress and pointer — the write of a push carries. */
interface PositionPayload {
	progress: number;
	position: Record<string, string | number | boolean>;
}

let rows: Map<number, ServerPosition> | null = null;
let loadInFlight: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function publish(): void {
	version += 1;
	for (const fn of listeners) fn();
}

/**
 * The server store's version — the number that changes when a load lands, so a reader
 * that initialized from a device-less state can re-read what adoption wrote. Bumping in
 * one place keeps the module's one rule (server row + local keys) the only thing a
 * consumer needs to watch.
 */
export function readingPositionsVersion(): number {
	return version;
}

/** Subscribe to server-store changes (loads and later refreshes). */
export function onReadingPositionsChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Write a server row into this device's keys — only when the device holds NOTHING for
 * the Work. Adoption fills an absence; it never argues with a position the device
 * already has (the reader here is current while reading), and it never pushes — the row
 * echoed back would manufacture a write and churn the rail's recency.
 */
function adopt(row: ServerPosition): void {
	if (readStoredPage(row.workId) != null) return;
	if (readStoredPanel(row.workId) != null) return;
	if (readStoredReflow(row.workId) != null) return;
	if (readStoredScroll(row.workId) != null) return;

	const page = typeof row.position.page === "number" ? row.position.page : null;
	const panel = typeof row.position.panel === "number" ? row.position.panel : null;
	const cfi = typeof row.position.cfi === "string" ? row.position.cfi : null;
	if (cfi != null) {
		persistReflow(row.workId, { cfi, fraction: row.progress });
	} else if (page != null) {
		persistPage(row.workId, page);
		if (panel != null) persistPanel(row.workId, { page, panel });
	} else {
		// A text Work: the progress fraction is the whole position.
		persistScroll(row.workId, row.progress);
	}
}

async function load(): Promise<void> {
	try {
		const res = await client.api.content["reading-positions"].$get();
		if (!res.ok) {
			// Signed out, or unreachable: the device store stands alone, which is the
			// correct answer for both.
			rows = new Map();
		} else {
			const data = (await res.json()) as { positions: ServerPosition[] };
			rows = new Map(data.positions.map((p) => [p.workId, p]));
			// Adopt before publishing: a reader re-reading after the version bump must
			// find what the adoption wrote, not a version bump that wrote nothing yet.
			for (const row of rows.values()) adopt(row);
		}
		publish();
	} catch {
		rows = new Map();
		publish();
	}
}

/**
 * Read the server store, loading it on first use. Total under failure — an unreadable
 * store is an empty one, and the device keys answer for everything the rail needs.
 */
export function refreshReadingPositions(): Promise<void> {
	if (loadInFlight) return loadInFlight;
	loadInFlight = load().finally(() => {
		loadInFlight = null;
	});
	return loadInFlight;
}

/** The server row for a Work, or null when the store doesn't carry one. */
export function serverPositionOf(workId: number): ServerPosition | null {
	return rows?.get(workId) ?? null;
}

/**
 * The server store, loading it on first use and re-reading on every refresh — the
 * shelf/rail's view, in the same module-store pattern `lib/library.ts` uses. The map is
 * live: a later `refreshReadingPositions` publishes a new one rather than mutating this.
 */
export function useReadingPositions(): Map<number, ServerPosition> {
	const [snapshot, setSnapshot] = useState(() => rows ?? new Map<number, ServerPosition>());

	useEffect(() => {
		const sync = () => setSnapshot(rows ?? new Map<number, ServerPosition>());
		listeners.add(sync);
		if (rows) sync();
		else void refreshReadingPositions();
		return () => {
			listeners.delete(sync);
		};
	}, []);

	return snapshot;
}

// ── The push behind the writes ───────────────────────────────────────────────

/** The minimum interval between pushed writes for one Work — as `listen-positions` was. */
const PUSH_INTERVAL_MS = 5000;

const lastPush = new Map<number, number>();
const pending = new Map<number, PositionPayload>();
let pagehideBound = false;

function bindPagehide(): void {
	if (pagehideBound || typeof window === "undefined") return;
	pagehideBound = true;
	// The flush point: a reader closing the tab mid-throttle pushes what it was about
	// to lose. Total under failure, like everything else here.
	window.addEventListener("pagehide", () => {
		const entries = [...pending.entries()];
		pending.clear();
		for (const [workId, row] of entries) void pushRow(workId, row);
	});
}

async function pushRow(workId: number, row: PositionPayload): Promise<void> {
	try {
		await client.api.content["reading-positions"][":workId"].$put({
			param: { workId: String(workId) },
			json: { progress: row.progress, position: row.position },
		});
	} catch {
		// A push that fails is a row the device still knows — nothing to recover.
	}
}

/**
 * Queue a push for a Work's row, throttled per Work. Fire-and-forget: the local write
 * already happened, the push is the echo, and no caller waits on it.
 */
function schedulePush(workId: number, row: PositionPayload): void {
	if (typeof window === "undefined") return; // Under test: the local write is the record.
	bindPagehide();
	pending.set(workId, row);
	const last = lastPush.get(workId);
	if (last != null && Date.now() - last < PUSH_INTERVAL_MS) return;
	lastPush.set(workId, Date.now());
	pending.delete(workId);
	void pushRow(workId, row);
}

// ── The device store ─────────────────────────────────────────────────────────

function persistPage(workId: number, page: number): void {
	try {
		const raw = localStorage.getItem(READING_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
		map[String(workId)] = page;
		localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — the user simply always opens at page one. */
	}
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

function persistPanel(workId: number, position: PanelPosition): void {
	try {
		const raw = localStorage.getItem(PANEL_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, PanelPosition>) : {};
		map[String(workId)] = position;
		localStorage.setItem(PANEL_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — panel progress does not persist. */
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

/**
 * Persist which page a reader is on. Written only on real navigation, never on mount.
 * `pageCount` turns the write into a server push as well — the readers always know it,
 * and the row's fraction is page over count.
 */
export function writePage(workId: number, page: number, pageCount?: number): void {
	persistPage(workId, page);
	if (pageCount != null && pageCount > 0) {
		schedulePush(workId, { progress: Math.min(page / pageCount, 1), position: { page } });
	}
}

/** Persist where within panel mode a reader got to, page and panel both. */
export function writePanel(workId: number, position: PanelPosition, pageCount?: number): void {
	persistPanel(workId, position);
	if (pageCount != null && pageCount > 0) {
		schedulePush(workId, {
			progress: Math.min(position.page / pageCount, 1),
			position: { page: position.page, panel: position.panel },
		});
	}
}

/**
 * How far into a Work a reader got, as a 0–1 fraction of its pages, or `null` when the
 * shelf should show a spine without a marker: never opened, a `pageCount` the Work does
 * not carry (`text` Works, for instance, are not paged), or a position clamped past a
 * page count that changed.
 *
 * Both keys are read and the further-along page wins, because a reader may finish a
 * comic in page mode and later page a few panels in panel mode — the shelf marker has
 * to keep up with whichever mode they were last reading in.
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

function persistReflow(workId: number, position: ReflowPosition): void {
	try {
		const raw = localStorage.getItem(REFLOW_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, ReflowPosition>) : {};
		map[String(workId)] = position;
		localStorage.setItem(REFLOW_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — the reader always opens at the book's start. */
	}
}

/** The stored reflow position for a Work, or `null` when this device never recorded one. */
export function readStoredReflow(workId: number): ReflowPosition | null {
	try {
		const raw = localStorage.getItem(REFLOW_PROGRESS_KEY);
		if (!raw) return null;
		const p = (JSON.parse(raw) as Record<string, ReflowPosition>)[String(workId)];
		if (p && typeof p.cfi === "string" && p.cfi && typeof p.fraction === "number") return p;
	} catch {
		/* Unreadable store — the reflow position reads as never recorded. */
	}
	return null;
}

/** Persist where inside a reflow book a reader got to, CFI and book-wide fraction both. */
export function writeReflow(workId: number, position: ReflowPosition): void {
	persistReflow(workId, position);
	schedulePush(workId, { progress: position.fraction, position: { cfi: position.cfi } });
}

/**
 * The reflow book's shelf fraction: the stored 0–1 progress, or `null` when never
 * opened. Unlike a page count a reflow book has no fixed geometry, so the fraction is
 * written beside the CFI rather than recomputed from a count that changed.
 */
export function readReflowFraction(workId: number): number | null {
	return readStoredReflow(workId)?.fraction ?? null;
}

function persistScroll(workId: number, fraction: number): void {
	try {
		const raw = localStorage.getItem(SCROLL_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
		map[String(workId)] = fraction;
		localStorage.setItem(SCROLL_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — the article reads from the top. */
	}
}

/** The stored scroll depth for a text Work, or `null` when this device never recorded one. */
function readStoredScroll(workId: number): number | null {
	try {
		const raw = localStorage.getItem(SCROLL_PROGRESS_KEY);
		if (!raw) return null;
		const fraction = (JSON.parse(raw) as Record<string, number>)[String(workId)];
		return typeof fraction === "number" && fraction >= 0 ? fraction : null;
	} catch {
		return null;
	}
}

/**
 * The stored scroll fraction for a Work, or `null` when never opened — the text Work's
 * answer to {@link readPageFraction} and {@link readReflowFraction}.
 */
export function readScrollFraction(workId: number): number | null {
	return readStoredScroll(workId);
}

/**
 * Persist how deep into a text Work a reader has scrolled, as a 0–1 fraction of the
 * article. The device always records; the row takes it only past
 * {@link SCROLL_OPEN_FLOOR} — a sliver of scroll is a nudge, not an opening.
 */
export function writeScroll(workId: number, fraction: number): void {
	const clamped = Math.min(1, Math.max(0, fraction));
	persistScroll(workId, clamped);
	if (clamped >= SCROLL_OPEN_FLOOR) {
		schedulePush(workId, { progress: clamped, position: {} });
	}
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Resume-from-position for spoken audio, stored per Work in `localStorage`.
 *
 * Deliberately local-only, mirroring `anthers_reading_progress` for comics: a
 * restart-resume nicety rather than a thing to preserve across devices. The record is
 * keyed by Work id and holds `{ t, at }` — seconds into the audio, and the epoch-ms it
 * was written for TTL eviction.
 *
 * The rules that make a resume feel right rather than creepy, each covered by a test:
 *
 * - **Thirty-day TTL.** An episode started six months ago starts over. Entries past the
 *   TTL are evicted when read, and wholesale when written.
 * - **Throttled writes.** A listener ticks `timeupdate` every 250ms; persisting at most
 *   once every five seconds per Work keeps the quota untouched, with pause and pagehide
 *   as the flush points.
 * - **Finishing clears rather than stores.** Within fifteen seconds of the end, the
 *   position is dropped — finishing an episode must not resume it at the end next open.
 * - **A ten-second floor on restore.** Resume skips the intro rather than landing on it.
 *
 * Every function is total under `localStorage` failure: Safari private mode throws on
 * `setItem`, and read-as-absent is the correct behavior in every failure case.
 */

const KEY = "anthers_listen_positions";
/** Entries older than this are treated as absent and dropped on the next write. */
export const LISTEN_POSITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Positions at or below this many seconds are not worth resuming. */
export const LISTEN_RESUME_FLOOR_SECONDS = 10;
/** A write within this many seconds of the end clears the position instead. */
export const LISTEN_FINISH_MARGIN_SECONDS = 15;
/** The minimum interval between persisted writes for one Work. */
export const LISTEN_WRITE_INTERVAL_MS = 5000;

type ListenPositions = Record<number, { t: number; at: number }>;

function readAll(now: number): ListenPositions {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {};
		const map = JSON.parse(raw) as ListenPositions;
		const fresh: ListenPositions = {};
		for (const [key, entry] of Object.entries(map)) {
			if (
				entry &&
				typeof entry.t === "number" &&
				typeof entry.at === "number" &&
				now - entry.at < LISTEN_POSITION_TTL_MS
			) {
				fresh[Number(key)] = entry;
			}
		}
		return fresh;
	} catch {
		return {};
	}
}

/**
 * The stored position for a Work in seconds, or null when absent, expired, unreadable,
 * or below the resume floor. An expired entry reads as absent and is evicted.
 */
export function readPosition(workId: number, now: number = Date.now()): number | null {
	const entry = readAll(now)[workId];
	if (!entry) return null;
	if (entry.t <= LISTEN_RESUME_FLOOR_SECONDS) return null;
	return entry.t;
}

/**
 * Persist where a listener got to. Pass the Work's duration when it is known so a
 * finished episode clears its position rather than resuming at the end; when duration
 * is unknown the write goes through, since mid-audio state is better than none.
 *
 * Returns false without writing when the throttle window has not elapsed; pass
 * `force: true` from the pause and pagehide flush points to bypass it.
 */
export function writePosition(
	workId: number,
	t: number,
	durationSeconds?: number | null,
	options: { force?: boolean; now?: number } = {},
): boolean {
	const now = options.now ?? Date.now();
	if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return false;
	if (
		durationSeconds != null &&
		durationSeconds > 0 &&
		t >= durationSeconds - LISTEN_FINISH_MARGIN_SECONDS
	) {
		clearPosition(workId, now);
		return true;
	}

	const map = readAll(now);
	const last = map[workId]?.at;
	if (!options.force && last != null && now - last < LISTEN_WRITE_INTERVAL_MS) return false;

	map[workId] = { t, at: now };
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
		return true;
	} catch {
		return false;
	}
}

/** Forget a Work's position entirely. */
export function clearPosition(workId: number, now: number = Date.now()): void {
	const map = readAll(now);
	delete map[workId];
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		// A store that refuses the write holds nothing readable, so there is nothing to do.
	}
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The read-side half of attention ranges — splitting overlapping time evenly, at
 * read time, over one account's stored ranges.
 *
 * Time is recorded as ground truth (each range's real start/end as the client
 * reported it, bounded at intake), and the equal-time principle is enforced here
 * rather than at write: every second of one account's real elapsed time credits
 * at most one second, split evenly among whatever they were consuming in it —
 * in every tab and on every device.
 *
 * Every reader that used to `SUM(duration_seconds)` over `created_at` goes through
 * `creditedSeconds` or `creditedSecondsByCreator` instead, so the split is applied
 * once, identically, everywhere — the meter, parental controls, distribution, the
 * rollup, and analytics all answer the same question the same way.
 */

import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";
import { splitOverlappingRanges } from "@anthers/shared/attention";
import { and, eq, type SQL, sql } from "drizzle-orm";

/** A stored range, reduced to what the split needs plus its attribution. */
interface RangeRow {
	id: number;
	creatorId: number;
	durationSeconds: number | null;
	createdAt: Date;
	startedAt: Date | null;
	endedAt: Date | null;
	viaShareLink: boolean;
}

/**
 * The real-time window a row occupies. Rows written before ranges carry no
 * `started_at`/`ended_at`; they are read as the interval ending at `created_at`
 * and running `duration_seconds` long, which is what the backfill migration writes
 * and what this COALESCE reconstructs for any straggler inserted mid-deploy.
 */
const RANGE_START = sql`COALESCE(${attentionEvents.startedAt}, ${attentionEvents.createdAt} - make_interval(secs => COALESCE(${attentionEvents.durationSeconds}, 0)))`;
const RANGE_END = sql`COALESCE(${attentionEvents.endedAt}, ${attentionEvents.createdAt})`;

/** postgres-js rejects a Date interpolated into a raw fragment: ISO strings, cast. */
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * One account's ranges overlapping a window, optionally narrowed (to Public Access
 * rows, share-link rows, a creator…). The overlap condition — not containment — is
 * what lets a range straddling the window's edge contribute its in-window share.
 */
async function rangesOverlapping(
	userId: number,
	windowStart: Date,
	windowEnd: Date,
	extra: SQL[],
): Promise<RangeRow[]> {
	return db
		.select({
			id: attentionEvents.id,
			creatorId: attentionEvents.creatorId,
			durationSeconds: attentionEvents.durationSeconds,
			createdAt: attentionEvents.createdAt,
			startedAt: attentionEvents.startedAt,
			endedAt: attentionEvents.endedAt,
			viaShareLink: attentionEvents.viaShareLink,
		})
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, userId),
				// Zero-duration visit pings carry no time and no window; they are
				// analytics, and no reader of *time* should see them.
				sql`${attentionEvents.durationSeconds} > 0`,
				// Overlap: the range starts before the window ends and ends after it begins.
				sql`${RANGE_START} < ${iso(windowEnd)}`,
				sql`${RANGE_END} > ${iso(windowStart)}`,
				...extra,
			),
		);
}

/** Split a fetched window and return per-row credited seconds. */
function splitRows(rows: RangeRow[], windowStart: Date, windowEnd: Date) {
	return splitOverlappingRanges(
		rows.map((r) => ({
			id: r.id,
			startedAt: (
				r.startedAt ?? new Date(r.createdAt.getTime() - (r.durationSeconds ?? 0) * 1_000)
			).getTime(),
			endedAt: (r.endedAt ?? r.createdAt).getTime(),
		})),
		windowStart.getTime(),
		windowEnd.getTime(),
	);
}

/**
 * How much attention one account genuinely has in a window: the account's ranges
 * split against each other, then summed. This — and never a bare `SUM(duration)` —
 * is what "time spent" means, because the split is the equal-time principle.
 */
export async function creditedSeconds(
	userId: number,
	windowStart: Date,
	windowEnd: Date,
	extra: SQL[] = [],
): Promise<number> {
	const rows = await rangesOverlapping(userId, windowStart, windowEnd, extra);
	const credited = splitRows(rows, windowStart, windowEnd);
	let total = 0;
	for (const [, v] of credited) total += v;
	return total;
}

/**
 * The same split, kept per creator and per share-link flag — distribution needs to
 * pay creators proportionally and to hold the share-link side to its fraction, so
 * the split result is grouped rather than summed.
 */
export async function creditedSecondsByCreator(
	userId: number,
	windowStart: Date,
	windowEnd: Date,
	extra: SQL[] = [],
): Promise<Array<{ creatorId: number; viaShareLink: boolean; totalSeconds: number }>> {
	const rows = await rangesOverlapping(userId, windowStart, windowEnd, extra);
	const credited = splitRows(rows, windowStart, windowEnd);
	const byPair = new Map<
		string,
		{ creatorId: number; viaShareLink: boolean; totalSeconds: number }
	>();
	for (const row of rows) {
		const seconds = credited.get(row.id) ?? 0;
		if (seconds <= 0) continue;
		const key = `${row.creatorId}:${row.viaShareLink}`;
		const held = byPair.get(key);
		if (held) held.totalSeconds += seconds;
		else
			byPair.set(key, {
				creatorId: row.creatorId,
				viaShareLink: row.viaShareLink,
				totalSeconds: seconds,
			});
	}
	return [...byPair.values()];
}

/**
 * The retention rollup's shape: one account's ranges over one UTC day, split and
 * regrouped per (creator, Work, event type) — the grain `attention_daily` stores.
 *
 * The split is applied per ACCOUNT before the rollup (that is where the
 * equal-time principle lives — overlapping ranges are the same *person's* tabs and
 * devices), and only the split seconds are handed back. Because that happens
 * before the per-person rows are deleted, the anonymous survivor (`attention_daily`,
 * which has no `user_id` by design) stores already-correct totals and never needs a
 * viewer for anything but `unique_viewers`, which the caller counts distinctly.
 */
export async function creditedSecondsForRollup(
	userId: number,
	dayStartUtc: Date,
	dayEndUtc: Date,
): Promise<
	Array<{
		creatorId: number;
		workId: number | null;
		eventType: string;
		totalSeconds: number;
		/** How many ranges the seconds came from — the rollup's `event_count`. */
		rangeCount: number;
	}>
> {
	const rows = await rollupRows(
		userId,
		dayStartUtc,
		dayEndUtc,
		sql`${attentionEvents.durationSeconds} > 0`,
	);
	const credited = splitRows(rows, dayStartUtc, dayEndUtc);
	const groups = new Map<
		string,
		{
			creatorId: number;
			workId: number | null;
			eventType: string;
			totalSeconds: number;
			rangeCount: number;
		}
	>();
	for (const row of rows) {
		const seconds = credited.get(row.id) ?? 0;
		if (seconds <= 0) continue;
		const key = `${row.creatorId}:${row.workId ?? "none"}:${row.eventType}`;
		const held = groups.get(key);
		if (held) {
			held.totalSeconds += seconds;
			held.rangeCount += 1;
		} else {
			groups.set(key, {
				creatorId: row.creatorId,
				workId: row.workId,
				eventType: row.eventType,
				totalSeconds: seconds,
				rangeCount: 1,
			});
		}
	}
	return [...groups.values()];
}

/** Rows for the rollup, over one account and a day's window, of one kind. */
async function rollupRows(userId: number, dayStartUtc: Date, dayEndUtc: Date, kind: SQL) {
	return db
		.select({
			id: attentionEvents.id,
			creatorId: attentionEvents.creatorId,
			workId: attentionEvents.workId,
			eventType: attentionEvents.eventType,
			durationSeconds: attentionEvents.durationSeconds,
			createdAt: attentionEvents.createdAt,
			startedAt: attentionEvents.startedAt,
			endedAt: attentionEvents.endedAt,
			viaShareLink: attentionEvents.viaShareLink,
		})
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, userId),
				kind,
				sql`${RANGE_START} < ${iso(dayEndUtc)}`,
				sql`${RANGE_END} > ${iso(dayStartUtc)}`,
			),
		);
}

/**
 * Zero-duration visit pings for the rollup — no time, so nothing to split, but they
 * are the analytics signal and their count survives the raw rows.
 */
export async function visitPingsForRollup(
	userId: number,
	dayStartUtc: Date,
	dayEndUtc: Date,
): Promise<
	Array<{ creatorId: number; workId: number | null; eventType: string; eventCount: number }>
> {
	const rows = await db
		.select({
			creatorId: attentionEvents.creatorId,
			workId: attentionEvents.workId,
			eventType: attentionEvents.eventType,
			eventCount: sql<number>`count(*)::int`,
		})
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, userId),
				sql`COALESCE(${attentionEvents.durationSeconds}, 0) = 0`,
				sql`COALESCE(${attentionEvents.startedAt}, ${attentionEvents.createdAt}) < ${iso(dayEndUtc)}`,
				sql`COALESCE(${attentionEvents.endedAt}, ${attentionEvents.createdAt}) >= ${iso(dayStartUtc)}`,
			),
		)
		.groupBy(attentionEvents.creatorId, attentionEvents.workId, attentionEvents.eventType);
	return rows.map((r) => ({ ...r, eventCount: Number(r.eventCount) }));
}

/**
 * Creator-facing analytics over RAW ranges: per-viewer split applied, then grouped
 * however the caller needs. Analytics aggregates across people, so the split's
 * overlap division — which is per account — is resolved viewer by viewer first,
 * and only the credited remainders are combined. `groupBy` keys each credited row.
 *
 * Windows on when the time was spent (`started_at`), not when it was recorded.
 */
export async function creatorAnalyticsRanges<K extends string>(
	creatorId: number,
	since: Date,
	groupBy: (row: { creatorId: number; workId: number | null; eventType: string; day: string }) => K,
): Promise<Array<{ key: K; totalSeconds: number; eventCount: number; viewers: Set<number> }>> {
	const rows = await db
		.select({
			id: attentionEvents.id,
			userId: attentionEvents.userId,
			creatorId: attentionEvents.creatorId,
			workId: attentionEvents.workId,
			eventType: attentionEvents.eventType,
			durationSeconds: attentionEvents.durationSeconds,
			createdAt: attentionEvents.createdAt,
			startedAt: attentionEvents.startedAt,
			endedAt: attentionEvents.endedAt,
			viaShareLink: attentionEvents.viaShareLink,
		})
		.from(attentionEvents)
		.where(and(eq(attentionEvents.creatorId, creatorId), sql`${RANGE_END} > ${iso(since)}`));

	// Group rows by viewer, split each viewer's ranges against their own, then fold
	// into the caller's buckets. Splitting across viewers would divide seconds that
	// were never contested — two people can watch the same minute whole.
	const byViewer = new Map<number, typeof rows>();
	for (const r of rows) {
		const list = byViewer.get(r.userId) ?? [];
		list.push(r);
		byViewer.set(r.userId, list);
	}

	const nowMs = Date.now();
	const groups = new Map<
		K,
		{ key: K; totalSeconds: number; eventCount: number; viewers: Set<number> }
	>();
	for (const [viewerId, viewerRows] of byViewer) {
		const credited = splitRows(viewerRows, since, new Date(nowMs));
		for (const row of viewerRows) {
			const seconds = credited.get(row.id) ?? 0;
			const day = (
				row.startedAt ?? new Date(row.createdAt.getTime() - (row.durationSeconds ?? 0) * 1_000)
			)
				.toISOString()
				.slice(0, 10);
			const key = groupBy({
				creatorId: row.creatorId,
				workId: row.workId,
				eventType: row.eventType,
				day,
			});
			const held = groups.get(key) ?? {
				key,
				totalSeconds: 0,
				eventCount: 0,
				viewers: new Set<number>(),
			};
			held.totalSeconds += seconds;
			held.eventCount += 1;
			held.viewers.add(viewerId);
			groups.set(key, held);
		}
	}
	return [...groups.values()];
}

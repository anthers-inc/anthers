// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Attention retention — roll raw per-person rows into identity-free daily totals,
 * then delete them.
 *
 * This is the job behind Privacy Policy's retention promise: raw records connecting a person
 * to a Work are kept only until their billing cycle has settled and the card-dispute
 * window has closed, after which they are *"aggregated into per-Work and per-creator
 * totals and the per-person records are deleted"* — so that a complete history of
 * what someone personally watched **stops existing**. 🚨 **This docstring used to say
 * cleanup paths already existed for sessions, verification tokens and desktop auth
 * requests. Two of those three were false** — `deleteExpiredSessions()` and
 * `deleteExpiredTokens()` were exported and called from nowhere until 2026-08-12, when
 * they were scheduled as `QUEUES.PRUNE_CREDENTIALS`. Only `cleanupDesktopAuthRequests()`
 * ever actually ran. The behavioral log, which is by far the most sensitive of the four,
 * had none either and accumulated forever.
 *
 * Three properties this has to hold, in order of how badly they break:
 *
 * 1. **It must run AFTER `distribute-pool` has consumed the rows.** Distribution pays
 *    creators by attention out of these events; pruning a cycle the pool has not yet
 *    distributed would not lose privacy, it would lose *creator earnings*. The
 *    retention window is months and distribution is nightly, so the ordering is not
 *    close — but the cutoff is asserted against the window rather than assumed, and
 *    `ATTENTION_RAW_RETENTION_DAYS` carries the derivation.
 *
 * 2. **Aggregate first, delete second, in one transaction per day.** The reverse
 *    order, or two transactions, loses the creator's history to any crash in between.
 *    The rollup upsert is idempotent (`nullsNotDistinct` on the key, and an `excluded`
 *    write rather than an add), so a retried job re-derives the same totals from
 *    whatever rows remain instead of doubling them.
 *
 * 3. **`attention_daily` has no `user_id` column.** Not "we don't populate it" — it
 *    does not exist. A rollup that kept identities would make the policy sentence
 *    false while looking like it implemented it.
 *
 * 4. **A legal hold suspends it, and it suspends the whole DAY.** § 4.4 of the Document
 *    Retention and Destruction Policy requires every scheduled deletion Anthers operates
 *    to have an off switch — *"a retention rule that cannot be switched off is a defect
 *    to be fixed, not a defense"* — and a subpoena asking what an account watched is an
 *    ordinary legal request rather than an exotic one. This was the last sweep in the
 *    codebase without one. Why the whole day rather than the held person's rows is
 *    property 2 read carefully: the rollup upsert writes `excluded` rather than adding,
 *    so a day aggregated from part of its rows and then re-aggregated from the rest
 *    **overwrites** the first total with the second. Skipping a held person's rows and
 *    deleting the rest would therefore destroy the creator's earnings history for that
 *    day the next time the job ran — failure 1, arrived at from the other direction. The
 *    cost is that one held account delays pruning of every day it was active in, which
 *    is a bounded retention delay rather than a silently wrong figure, and that is the
 *    trade this file already makes everywhere else.
 *
 * The thing this job deliberately does NOT touch is `pool_distributions`, which also
 * carries `(subscriber_id, creator_id, attention_seconds)` per cycle. That is a
 * *payment* record — what was paid to whom, out of whose support — and the Privacy Policy keeps
 * payment records for as long as tax and nonprofit reporting law requires. It is
 * per-creator and per-cycle, never per-Work, so the sentence the policy actually
 * makes ("what you personally watched") is about this table and not that one. Worth
 * knowing rather than rediscovering: the promise is Work-granular by construction.
 */

import { db } from "@anthers/db";
import { attentionEvents } from "@anthers/db/schema";
import { ATTENTION_RAW_RETENTION_DAYS } from "@anthers/shared/constants";
import { inArray, lt, type SQL, sql } from "drizzle-orm";
import { allHeldSubjectIds } from "../services/legal-hold.js";

export interface PruneAttentionData {
	/** Override the retention window, in days. Tests use it; nothing else should. */
	retentionDays?: number;
	/** Cap on how many distinct days one run will process. Keeps a backlog bounded. */
	maxDays?: number;
}

export interface PruneAttentionResult {
	cutoff: string;
	daysProcessed: number;
	rowsAggregated: number;
	rowsDeleted: number;
	/** UTC days left alone because someone active in them is under a legal hold. */
	daysHeld: number;
}

/** Midnight UTC, `retentionDays` ago. Everything strictly before this is prunable. */
function cutoffFor(retentionDays: number): Date {
	const d = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function pruneAttention(data: PruneAttentionData = {}): Promise<PruneAttentionResult> {
	const retentionDays = data.retentionDays ?? ATTENTION_RAW_RETENTION_DAYS;
	const maxDays = data.maxDays ?? 90;
	const cutoff = cutoffFor(retentionDays);

	// Bound as an ISO string with an explicit cast rather than as a Date: postgres-js
	// rejects a Date interpolated into a raw `sql` fragment, and the two statements in
	// the loop below are raw by necessity — aggregate-and-upsert has no builder form.
	const cutoffIso = cutoff.toISOString();

	// Everyone whose viewing history is under a legal hold right now. One query, not one
	// per row — and in the ordinary case it comes back empty and costs nothing further.
	const heldUserIds = await allHeldSubjectIds("user");
	const rowIsHeld = heldUserIds.length > 0 ? inArray(attentionEvents.userId, heldUserIds) : null;

	// Whole UTC days only. Pruning a partial day would roll up half of it, delete those
	// rows, and later roll up the rest into a total that looks complete and isn't — the
	// upsert writes `excluded` rather than adding, so the second pass would overwrite
	// the first with a smaller figure.
	//
	// A day containing ANY held person's rows is excluded here rather than filtered in the
	// loop below, which is the same rule seen from the other side: a partially-pruned day
	// is exactly the corruption the paragraph above describes, and a hold is a reason to
	// prune part of a day. Excluding in the HAVING also means a held day does not consume
	// a slot against `maxDays`, so a long-running hold cannot starve the backlog.
	const dayRows = await db
		.select({
			day: sql<string>`to_char(${attentionEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
		})
		.from(attentionEvents)
		.where(lt(attentionEvents.createdAt, cutoff))
		.groupBy(sql`1`)
		.having(rowIsHeld ? sql`bool_or(${rowIsHeld}) = false` : undefined)
		.orderBy(sql`1`)
		.limit(maxDays);

	// Reported so a held backlog is visible in the logs rather than looking like an idle
	// job. Skipped entirely when nothing is held, which is every ordinary run.
	const daysHeld = rowIsHeld ? await countHeldDays(cutoff, rowIsHeld) : 0;

	let rowsAggregated = 0;
	let rowsDeleted = 0;

	for (const { day } of dayRows) {
		await db.transaction(async (tx) => {
			// Aggregate → upsert → delete, all inside one transaction for this day. A
			// crash anywhere rolls the whole day back and the next run redoes it.
			const inserted = await tx.execute(sql`
				INSERT INTO attention_daily
					(creator_id, work_id, day, event_type, event_count, total_seconds, unique_viewers)
				SELECT
					creator_id,
					work_id,
					to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
					event_type,
					count(*)::int,
					COALESCE(sum(duration_seconds), 0)::int,
					count(DISTINCT user_id)::int
				FROM attention_events
				WHERE created_at < ${cutoffIso}::timestamptz
				  AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day}
				GROUP BY creator_id, work_id, day, event_type
				-- Must name the same expression as the unique index, COALESCE included, or
				-- Postgres finds no matching arbiter and raises rather than upserting.
				ON CONFLICT (creator_id, COALESCE(work_id, -1), day, event_type) DO UPDATE SET
					event_count = excluded.event_count,
					total_seconds = excluded.total_seconds,
					unique_viewers = excluded.unique_viewers
				RETURNING id
			`);
			rowsAggregated += rowCount(inserted);

			const deleted = await tx.execute(sql`
				DELETE FROM attention_events
				WHERE created_at < ${cutoffIso}::timestamptz
				  AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day}
				RETURNING id
			`);
			rowsDeleted += rowCount(deleted);
		});
	}

	if (dayRows.length > 0) {
		console.log(
			`prune-attention: rolled up ${rowsAggregated} daily totals from ${rowsDeleted} raw events across ${dayRows.length} day(s) before ${cutoff.toISOString().slice(0, 10)}`,
		);
	}
	if (daysHeld > 0) {
		console.log(
			`prune-attention: left ${daysHeld} day(s) unpruned — someone active in them is under a legal hold`,
		);
	}

	return {
		cutoff: cutoff.toISOString().slice(0, 10),
		daysProcessed: dayRows.length,
		rowsAggregated,
		rowsDeleted,
		daysHeld,
	};
}

/** How many prunable UTC days are being left alone for a hold. */
async function countHeldDays(cutoff: Date, rowIsHeld: SQL): Promise<number> {
	const rows = await db
		.select({
			day: sql<string>`to_char(${attentionEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
		})
		.from(attentionEvents)
		.where(lt(attentionEvents.createdAt, cutoff))
		.groupBy(sql`1`)
		.having(sql`bool_or(${rowIsHeld}) = true`);
	return rows.length;
}

/** postgres-js returns the rows array directly; other drivers wrap them in `{ rows }`. */
function rowCount(res: unknown): number {
	if (Array.isArray(res)) return res.length;
	const rows = (res as { rows?: unknown[] } | null)?.rows;
	return Array.isArray(rows) ? rows.length : 0;
}

/** pg-boss entry point. */
export async function handlePruneAttention(data: PruneAttentionData = {}): Promise<void> {
	await pruneAttention(data);
}

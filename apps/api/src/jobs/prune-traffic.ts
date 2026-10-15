// SPDX-License-Identifier: Apache-2.0
/**
 * Traffic retention — roll raw page views and card displays into their identity-free
 * daily totals, then delete the raw rows. The traffic-side sibling of
 * `prune-attention`, running the same three properties as law:
 *
 * 1. **Aggregate first, delete second, in one transaction per day.** The rollup
 *    upserts `excluded` (overwrites) rather than adding, so a crash between the halves
 *    is safe to retry: the next run re-derives the same totals from whatever rows
 *    remain, instead of doubling them.
 *
 * 2. **Whole UTC days only.** A partially-pruned day would roll up half, delete those
 *    rows, and later roll up the rest into a smaller overwrite that looks complete.
 *    Days are named by when the visit was *received* — a page view is instantaneous,
 *    so unlike attention there is no range window to honor.
 *
 * 3. **The rollups have no session column.** `traffic_daily` and
 *    `card_impressions_daily` cannot hold the one identity-like value the raw rows
 *    carry: retention is the sentence the Privacy Policy revision will state, and a
 *    rollup that kept session ids would make it false while looking like it
 *    implemented it — the exact failure `attention_daily`'s missing `user_id` exists
 *    to prevent.
 *
 * 🚨 **A legal hold does not reach this sweep, and that is a property of the data, not
 * an omission.** The retention policy requires every scheduled deletion to have an off
 * switch, and `prune-attention` exercises it by skipping any day containing a held
 * person's rows. It can skip because its rows name people. These rows name nobody —
 * there is no user id, no IP, nothing a hold could attach to (`packages/shared/src/
 * traffic.ts` carries the design; `services/traffic.ts` is the one writer that
 * enforces it). A hold that ever needed these raw rows suspended would be a hold on
 * the whole table, which is a deploy-time change to the worker's schedule, not a
 * per-day skip this job could pretend to make. Writing a subject-based skip here
 * anyway would be implementing a claim the schema cannot honor.
 *
 * Not money: nothing here feeds distribution or settlement, so there is no ordering
 * dependency like prune-attention's before-distribute rule. The schedule is off the
 * crowded marks purely by convention (`queue.ts` carries it).
 */

import { db } from "@anthers/db";
import { TRAFFIC_RAW_RETENTION_DAYS } from "@anthers/shared/traffic";
import { sql } from "drizzle-orm";
import { prunableTrafficDays } from "../services/traffic.js";

export interface PruneTrafficData {
	/** Override the retention window, in days. Tests use it; nothing else should. */
	retentionDays?: number;
	/** Cap on how many distinct days one run will process. Keeps a backlog bounded. */
	maxDays?: number;
}

export interface PruneTrafficResult {
	cutoff: string;
	daysProcessed: number;
	viewsAggregated: number;
	viewsDeleted: number;
	cardDisplaysAggregated: number;
	cardDisplaysDeleted: number;
}

function rowCount(res: unknown): number {
	if (Array.isArray(res)) return res.length;
	const rows = (res as { rows?: unknown[] } | null)?.rows;
	return Array.isArray(rows) ? rows.length : 0;
}

export async function pruneTraffic(data: PruneTrafficData = {}): Promise<PruneTrafficResult> {
	const retentionDays = data.retentionDays ?? TRAFFIC_RAW_RETENTION_DAYS;
	const maxDays = data.maxDays ?? 90;
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const cutoffIso = cutoff.toISOString();

	// The service owns the definition of prunable; the job owns the deleting. The day
	// list already excludes held days in the attention job — here nothing held can
	// exist (see the docblock), so the list is exactly the days older than the cutoff.
	const days = await prunableTrafficDays(retentionDays, maxDays);

	let viewsAggregated = 0;
	let viewsDeleted = 0;
	let cardAggregated = 0;
	let cardDeleted = 0;

	for (const day of days) {
		await db.transaction(async (tx) => {
			// One statement per table: aggregate → upsert (overwrite) is what makes a
			// retry re-derive rather than double. The conflict targets name the same
			// column lists the unique indexes declare, or Postgres finds no arbiter.
			// RETURNING id makes the driver hand back one row per group, which is how
			// the counts below count group rows rather than hope the driver reports a
			// write count.
			const views = await tx.execute(sql`
				INSERT INTO traffic_daily (day, path, referrer_source, device, views, sessions)
				SELECT ${day}, path, referrer_source, device, count(*), count(DISTINCT session_id)
				FROM traffic_events
				WHERE to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day}
				  AND created_at < ${cutoffIso}::timestamptz
				GROUP BY path, referrer_source, device
				ON CONFLICT (day, path, referrer_source, device) DO UPDATE SET
					views = excluded.views,
					sessions = excluded.sessions
				RETURNING id
			`);
			viewsAggregated += rowCount(views);

			// Card rollups resolve creator attribution as they aggregate: a project
			// subject through `projects.creator_id`, a creator subject through itself.
			// A subject deleted before pruning rolls up unattributed rather than lost.
			const cards = await tx.execute(sql`
				INSERT INTO card_impressions_daily (day, subject_kind, subject_id, surface, shown, clicked, creator_id)
				SELECT ${day}, ci.subject_kind, ci.subject_id, ci.surface,
					count(*) FILTER (WHERE ci.kind = 'shown'),
					count(*) FILTER (WHERE ci.kind = 'click'),
					COALESCE(p.creator_id, CASE WHEN ci.subject_kind = 'creator' THEN ci.subject_id END)
				FROM card_impressions ci
				LEFT JOIN projects p ON p.id = ci.subject_id AND ci.subject_kind = 'project'
				WHERE to_char(ci.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day}
				  AND ci.created_at < ${cutoffIso}::timestamptz
				GROUP BY ci.subject_kind, ci.subject_id, ci.surface
				ON CONFLICT (day, subject_kind, subject_id, surface) DO UPDATE SET
					shown = excluded.shown,
					clicked = excluded.clicked,
					creator_id = excluded.creator_id
				RETURNING id
			`);
			cardAggregated += rowCount(cards);

			const deletedViews = await tx.execute(sql`
				DELETE FROM traffic_events
				WHERE to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day}
				  AND created_at < ${cutoffIso}::timestamptz
				RETURNING id
			`);
			viewsDeleted += rowCount(deletedViews);

			const deletedCards = await tx.execute(sql`
				DELETE FROM card_impressions
				WHERE to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day}
				  AND created_at < ${cutoffIso}::timestamptz
				RETURNING id
			`);
			cardDeleted += rowCount(deletedCards);
		});
	}

	if (days.length > 0) {
		console.log(
			`prune-traffic: rolled up ${viewsAggregated} daily view total(s) from ${viewsDeleted} raw events and ${cardAggregated} card total(s) from ${cardDeleted} raw display(s) across ${days.length} day(s) before ${cutoff.toISOString().slice(0, 10)}`,
		);
	}

	return {
		cutoff: cutoff.toISOString(),
		daysProcessed: days.length,
		viewsAggregated,
		viewsDeleted,
		cardDisplaysAggregated: cardAggregated,
		cardDisplaysDeleted: cardDeleted,
	};
}

/** pg-boss entry point. */
export async function handlePruneTraffic(data: PruneTrafficData = {}): Promise<void> {
	await pruneTraffic(data);
}

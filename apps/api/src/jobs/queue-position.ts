// SPDX-License-Identifier: Apache-2.0
/**
 * The media lane's positions, written as records (`transcoding_jobs.queue_position`).
 *
 * The single-file lane (`QUEUES.MEDIA`) is one queue, so its order is a fact this module
 * owns rather than something every serializer derives: **a position is a written record,
 * not arithmetic read twice differently** — pg-boss's `created_on` ordering is an
 * implementation detail of its fetch loop, unstable across a failed job's retry backoff,
 * and the retry SHOULD lose its place while it waits its delay, so the ordering here is
 * `created_at, id` over rows still pending and the recompute runs at every lane
 * transition (enqueue, claim, settle, cancel) rather than assuming order holds.
 *
 * Semantics: a 1-based position among the lane's `pending` rows — **1 = next to run** —
 * and null for everything not waiting (processing, settled, canceled, and the ebooks and
 * ebook-render rows that never joined the lane). The running job's remaining time and the
 * cost of the rows ahead both live elsewhere (`transcode-eta.ts`, the next increments);
 * this module is only the position itself.
 *
 * Numbers are refreshed wholesale, not incremented: at our scale (a burst of eight was
 * remarkable) the UPDATE touches a handful of rows, and wholesale is the version that
 * cannot skew — an increment-on-completion scheme spreads its writers across three
 * handlers, and the first missed write leaks the queue's truth onto the screen.
 */

import { db } from "@anthers/db";
import { transcodingJobs } from "@anthers/db/schema";
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

/** Assign every pending media row its 1-based spot, and every settled row no spot. */
export async function refreshQueuePositions(): Promise<void> {
	// A row that left the queue carries no spot — claimed, settled or canceled alike.
	// One statement, no per-row round trips; the WHERE keeps it a no-op for the common
	// case (rows never touched the field, so nothing rewrites).
	await db.execute(
		sql`UPDATE transcoding_jobs SET queue_position = NULL
			WHERE queue_position IS NOT NULL
			  AND (status != 'pending' OR media_type NOT IN ('video', 'audio'))`,
	);
	// The pending rows renumber 1..N. `…AND `x`.`id`` — the raw-SQL alias rule: name the
	// table, never bare `id`, so the statement cannot silently bind the other table's.
	await db.execute(
		sql`WITH ranked AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS pos
				FROM transcoding_jobs
				WHERE status = 'pending' AND media_type IN ('video', 'audio')
			)
			UPDATE transcoding_jobs SET queue_position = ranked.pos
			FROM ranked
			WHERE transcoding_jobs.id = ranked.id
			  AND transcoding_jobs.queue_position IS DISTINCT FROM ranked.pos`,
	);

	// The lane's seconds figures, written beside the positions (a screen that showed
	// "3 ahead" and no time would be half the record). Positions order the pending rows
	// by (created_at, id); the figures are computed here off that same order:
	//
	// - The RUNNING row (video's ffmpeg-driven figure, or short of one the unspent share
	//   of its type's cost model) is the debt every pending row waits behind.
	// - A pending row's **front figure** (`queueEtaSeconds`) is that debt plus every
	//   pending row ahead's cost; its **total** (`etaSeconds`, for a pending row the
	//   front figure plus the row's own cost) is the figure the Work page renders.

	// A cost is the recorded history's median for the type (`timings`, the handlers'
	// own measurements — its body keys are camelCase like the jsonb elsewhere) with a
	// coarse constant when there is none. The constants are
	// the floor the first figures stand on, never a model — history replaces them row
	// by row: the audio lane's whole job ran on the order of a quarter hour solo, a
	// video ladder about an hour.
	const FALLBACK: Record<string, number> = { video: 60 * 60, audio: 15 * 60 };
	const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const history = await db
		.select({
			mediaType: transcodingJobs.mediaType,
			medianMs: sql<number | null>`percentile_cont(0.5) within group (order by ((timings->>'totalMs')::numeric))`,
		})
		.from(transcodingJobs)
		.where(
			and(
				eq(transcodingJobs.status, "completed"),
				isNotNull(transcodingJobs.timings),
				gt(transcodingJobs.createdAt, recentCutoff),
			),
		)
		.groupBy(transcodingJobs.mediaType);
	const costOf = (mediaType: string): number | null => {
		const median = history.find((h) => h.mediaType === mediaType)?.medianMs;
		return median != null && Number(median) > 0 ? Number(median) / 1000 : FALLBACK[mediaType] ?? null;
	};

	const [running] = await db
		.select({
			etaSeconds: transcodingJobs.etaSeconds,
			progress: transcodingJobs.progress,
			mediaType: transcodingJobs.mediaType,
		})
		.from(transcodingJobs)
		.where(eq(transcodingJobs.status, "processing"))
		.orderBy(transcodingJobs.createdAt)
		.limit(1);
	let ahead =
		running == null
			? 0
			: (running.etaSeconds ??
			  ((100 - (running.progress ?? 0)) / 100) * (costOf(running.mediaType) ?? 0));

	const pending = await db
		.select({
			id: transcodingJobs.id,
			mediaType: transcodingJobs.mediaType,
		})
		.from(transcodingJobs)
		.where(
			and(
				eq(transcodingJobs.status, "pending"),
				inArray(transcodingJobs.mediaType, ["video", "audio"]),
			),
		)
		.orderBy(transcodingJobs.createdAt, transcodingJobs.id);

	// The lane serializes one job at a time, so a pending row's front figure is the debt
	// plus the cost of every pending row before it in this same order.
	for (const row of pending) {
		const own = costOf(row.mediaType);
		const front = Math.round(ahead);
		const total = own == null ? (front > 0 ? front : null) : front + Math.round(own);
		await db
			.update(transcodingJobs)
			.set({ queueEtaSeconds: front, etaSeconds: total })
			.where(eq(transcodingJobs.id, row.id));
		ahead = total ?? ahead;
	}
}
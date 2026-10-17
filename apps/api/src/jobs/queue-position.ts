// SPDX-License-Identifier: Apache-2.0
/**
 * The media lanes' positions, written as records (`transcoding_jobs.queue_position`).
 *
 * The media pipeline runs as two per-type queues — `transcode-video` single-file,
 * `process-audio` two at a time (measured 2026-10-18: an x264 ladder saturates both of
 * the worker's vCPUs, so video is one encode at a time; audio jobs are light, and the
 * single-file experiment idled three quarters of the box) — so a position is a fact of
 * the row's OWN type's lane, and this module owns it rather than letting every serializer
 * derive it: **a position is a written record, not arithmetic read twice differently** —
 * pg-boss's `created_on` ordering is an implementation detail of its fetch loop,
 * unstable across a failed job's retry backoff, and the retry SHOULD lose its place while
 * it waits its delay, so the ordering here is `created_at, id` over a type's still-pending
 * rows and the recompute runs at every lane transition (enqueue, claim, settle, cancel)
 * rather than assuming order holds.
 *
 * Semantics: a 1-based position among the row's own type's `pending` rows — **1 = next to
 * run on its lane** — and null for everything not waiting (processing, settled, canceled,
 * and the ebooks and ebook-render rows that never ride these lanes). The running job's
 * remaining time and the cost of the rows ahead live elsewhere (`transcode-eta.ts`); this
 * module is only the position itself. Two lanes run now, so a video at position 1 and an
 * audio at position 1 are each *their lane's* next-to-run — a row's figures name what IT
 * waits behind, and neither lane's arithmetic reads the other's.
 *
 * Numbers are refreshed wholesale, not incremented: at our scale (a burst of eight was
 * remarkable) the UPDATE touches a handful of rows, and wholesale is the version that
 * cannot skew — an increment-on-completion scheme spreads its writers across three
 * handlers, and the first missed write leaks the queue's truth onto the screen.
 */

import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";

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
	// The pending rows renumber 1..N **per lane** — `PARTITION BY media_type` numbers
	// each type's pending rows 1..N off the same order, so two lanes' positions never
	// read each other. `…AND `x`.`id`` — the raw-SQL alias rule: name the table, never
	// bare `id`, so the statement cannot silently bind the other table's.
	await db.execute(
		sql`WITH ranked AS (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY media_type ORDER BY created_at, id) AS pos
				FROM transcoding_jobs
				WHERE status = 'pending' AND media_type IN ('video', 'audio')
			)
			UPDATE transcoding_jobs SET queue_position = ranked.pos
			FROM ranked
			WHERE transcoding_jobs.id = ranked.id
			  AND transcoding_jobs.queue_position IS DISTINCT FROM ranked.pos`,
	);

	// The lanes' seconds figures, written beside the positions (a screen that showed
	// "3 ahead" and no time would be half the record). Each lane's pending rows order by
	// (created_at, id); their figures are computed here off that same order, per lane:
	//
	// - The RUNNING row of the same type (its ffmpeg-driven live figure when one exists,
	//   else the unspent share of its type's cost model) is the debt that lane's pending
	//   rows wait behind. With two audios running (the lane holds two), the OLDEST is
	//   taken: whichever finishes first frees the slot, so the newest's remaining
	//   over-shoots where a waiting creator actually starts — a conservative debt is the
	//   one that never promises minutes the box has already spent.
	// - A pending row's **front figure** (`queueEtaSeconds`) is that debt plus every
	//   pending row ahead's cost; its **total** (`etaSeconds`, for a pending row the
	//   front figure plus the row's own cost) is the figure the Work page renders.

	// A cost is the recorded history's median for the type (`timings`, the handlers'
	// own measurements — its body keys are camelCase like the jsonb elsewhere) with a
	// coarse constant when there is none. The constants are
	// the floor the first figures stand on, never a model — history replaces them row
	// by row. **The constants must say what a job costs, not what a past disaster cost**:
	// audio's first cut (15 minutes) was read off the contended 2026-10-17 burst, and a
	// real pair of solo recordings (2026-10-18, an encode of ~22s beside a waveform pass
	// of minutes) made a 3-minute file read "about 30 minutes left" — the queue quoting a
	// figure the row never had a chance of running. A song costs on the order of two
	// minutes; a video ladder about an hour.
	const FALLBACK: Record<string, number> = { video: 60 * 60, audio: 2 * 60 };
	const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const history = await db
		.select({
			mediaType: transcodingJobs.mediaType,
			medianMs: sql<
				number | null
			>`percentile_cont(0.5) within group (order by ((timings->>'totalMs')::numeric))`,
			// The rate as well — totalMs per second of the source's length — because a
			// rate is what carries across files of different lengths: a 3-minute song
			// priced off a 7-minute median reads three times what it costs. Rows recorded
			// before `timings.durationSeconds` existed contribute to the total's median
			// only; the key's absence is also what keeps the astats-era waveform
			// measurements (near-realtime, 2026-10-18's prod recordings) out of the rate.
			medianRateMs: sql<
				number | null
			>`percentile_cont(0.5) within group (order by ((timings->>'totalMs')::numeric / NULLIF((timings->>'durationSeconds')::numeric, 0)))`,
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
	const costOf = (mediaType: string, durationSeconds?: number | null): number | null => {
		const row = history.find((h) => h.mediaType === mediaType);
		const rateMs = Number(row?.medianRateMs);
		if (durationSeconds != null && durationSeconds > 0 && Number.isFinite(rateMs) && rateMs > 0)
			return (rateMs * durationSeconds) / 1000;
		if (row?.medianMs != null && Number(row.medianMs) > 0) return Number(row.medianMs) / 1000;
		return FALLBACK[mediaType] ?? null;
	};

	// One lane's chain at a time: each type's running row and its own pending order, so
	// an audio row's figures never price a video's debt and a video's never price an
	// audio's.
	for (const mediaType of ["video", "audio"] as const) {
		const [running] = await db
			.select({
				etaSeconds: transcodingJobs.etaSeconds,
				progress: transcodingJobs.progress,
			})
			.from(transcodingJobs)
			.where(
				and(eq(transcodingJobs.status, "processing"), eq(transcodingJobs.mediaType, mediaType)),
			)
			.orderBy(transcodingJobs.createdAt)
			.limit(1);
		let ahead =
			running == null
				? 0
				: (running.etaSeconds ??
					((100 - (running.progress ?? 0)) / 100) * (costOf(mediaType) ?? 0));

		const pending = await db
			.select({
				id: transcodingJobs.id,
				// The row hasn't run its own probe yet, but its Work may carry a duration
				// from an earlier pass over the same source — the rate median prices by it
				// when present, and the flat median prices the ones without.
				durationSeconds: works.durationSeconds,
			})
			.from(transcodingJobs)
			.innerJoin(works, eq(works.id, transcodingJobs.workId))
			.where(and(eq(transcodingJobs.status, "pending"), eq(transcodingJobs.mediaType, mediaType)))
			.orderBy(transcodingJobs.createdAt, transcodingJobs.id);

		// The lane serializes its slot(s), so a pending row's front figure is the debt
		// plus the cost of every pending row before it in this same order; with two
		// audios running the debt is the one finisher the waiting row must outlast, and
		// the estimate reads conservative rather than exact — an estimate's job.
		for (const row of pending) {
			const own = costOf(mediaType, row.durationSeconds);
			const front = Math.round(ahead);
			const total = own == null ? (front > 0 ? front : null) : front + Math.round(own);
			await db
				.update(transcodingJobs)
				.set({ queueEtaSeconds: front, etaSeconds: total })
				.where(eq(transcodingJobs.id, row.id));
			ahead = total ?? ahead;
		}
	}
}

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
import { sql } from "drizzle-orm";

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
}
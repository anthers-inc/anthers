// SPDX-License-Identifier: Apache-2.0
/**
 * Shared mechanism for the one-off corrections that delete attention ranges which should
 * never have been written.
 *
 * A correction script is a CLI over its own **selection** rule, and every one of them
 * deletes the same kind of thing in the same way: refuse a row the retention rollup may
 * already own, then delete in batches inside one transaction so a half-applied pass is
 * impossible. That mechanism lives here once; what differs between scripts is only which
 * rows they select.
 *
 * ⚠️ **These scripts exist because the write side was fixed after the fact.** A fix at
 * intake stops new rows; it never rewrites the stored ground truth, and the activity
 * history reads exactly what is stored. `attention_daily` is the line: while the raw rows
 * are still present the correction can delete them, and once the rollup has run the
 * arithmetic is a different job.
 */
import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";
import { ATTENTION_RAW_RETENTION_DAYS } from "@anthers/shared/constants";
import { inArray } from "drizzle-orm";

/**
 * Whether any selected range is old enough that the prune job may already have rolled it
 * into `attention_daily`. Such a row cannot be corrected by deleting the raw range.
 */
export function rolledUpRanges<T extends { startedAt: Date | null; createdAt: Date }>(
	ranges: T[],
	now = Date.now(),
): T[] {
	const cutoff = now - ATTENTION_RAW_RETENTION_DAYS * 86_400_000;
	return ranges.filter((range) => (range.startedAt ?? range.createdAt).getTime() < cutoff);
}

/** Seconds to the short form these scripts print, matching the activity history's copy. */
export function fmtDuration(seconds: number): string {
	const m = Math.round(seconds / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 === 0 ? `${h} hr` : `${h} hr ${m % 60} min`;
}

/** Split ids into batches a single `IN (…)` can carry without hitting a parameter limit. */
function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Delete the named ranges in one transaction, batched by id. Returns how many went.
 *
 * The transaction is what makes a correction all-or-nothing: a failure halfway through a
 * batch leaves the rows as they were rather than a record with holes in it.
 */
export async function deleteAttentionRanges(ids: number[]): Promise<number> {
	let deleted = 0;
	await db.transaction(async (tx) => {
		for (const batch of chunks(ids, 500)) {
			const result = await tx
				.delete(attentionEvents)
				.where(inArray(attentionEvents.id, batch))
				.returning({ id: attentionEvents.id });
			deleted += result.length;
		}
	});
	return deleted;
}

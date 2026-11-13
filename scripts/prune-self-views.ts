// SPDX-License-Identifier: Apache-2.0
/**
 * One-time correction: delete the timed attention ranges a creator produced by viewing
 * their own Work.
 *
 * 🚨 **A creator's own watching is not audience.** The intake dropped this claim on
 * 2026-11-06 (`8af7db1a`, [#851](https://github.com/anthers-inc/anthers/pull/851)), and
 * the analytics and Time Pool reads exclude the historic rows. The activity history
 * deliberately reads exactly what is stored, though, so those rows still appear in the
 * creator's own record as *Played … for N min*, describing an audience the Work never
 * had. This script removes them: every timed `attention_events` row where `user_id =
 * creator_id`, across every account.
 *
 * ⭐ **The row proves itself.** Unlike the storefront correction, nothing here is
 * inferred from a Work's present state: the attributed account and the credited creator
 * are both on the row, and their equality is the whole condition. Zero-duration visit
 * pings are left alone — they carry no time, never appear in the activity history, and
 * are not what this corrects.
 *
 * ⚠️ **Rows older than the retention window are refused rather than deleted.** The prune
 * job rolls raw ranges into `attention_daily` after `ATTENTION_RAW_RETENTION_DAYS`, and a
 * raw delete cannot subtract from an anonymous daily total. A refusal here means the
 * correction belongs in that rollup's own arithmetic, not that the script should guess.
 *
 * Usage, from a session with `DATABASE_URL` set (against production, through the one
 * door, after taking a backup and naming it):
 *   bun run scripts/prune-self-views.ts            # dry run, the default
 *   bun run scripts/prune-self-views.ts --apply    # delete
 *   make prod-db CMD="bun run scripts/prune-self-views.ts"
 *
 * The intake fix is live, so a pass deletes the whole backlog; the script is idempotent
 * and a second run reports nothing to take.
 */
import { db } from "@anthers/db/client";
import { attentionEvents, works } from "@anthers/db/schema";
import { ATTENTION_RAW_RETENTION_DAYS } from "@anthers/shared/constants";
import { and, gt, inArray, sql } from "drizzle-orm";
import { deleteAttentionRanges, fmtDuration, rolledUpRanges } from "./attention-prune-lib.js";

/** A timed range whose attributed account is the Work's own creator. */
export interface SelfViewRange {
	id: number;
	workId: number | null;
	durationSeconds: number | null;
	startedAt: Date | null;
	createdAt: Date;
}

/**
 * Every timed range where the account the seconds are attributed to is the account being
 * credited. That is the whole predicate the intake applies, restated as a read.
 */
export async function findSelfViewRanges(): Promise<SelfViewRange[]> {
	return db
		.select({
			id: attentionEvents.id,
			workId: attentionEvents.workId,
			durationSeconds: attentionEvents.durationSeconds,
			startedAt: attentionEvents.startedAt,
			createdAt: attentionEvents.createdAt,
		})
		.from(attentionEvents)
		.where(
			and(
				gt(attentionEvents.durationSeconds, 0),
				sql`${attentionEvents.userId} = ${attentionEvents.creatorId}`,
			),
		);
}

/** Delete the named ranges. Exported so a suite can exercise the one write path. */
export async function deleteSelfViewRanges(ids: number[]): Promise<number> {
	return deleteAttentionRanges(ids);
}

async function main() {
	const apply = process.argv.includes("--apply");
	const ranges = await findSelfViewRanges();

	if (ranges.length === 0) {
		console.log("prune-self-views: no timed self-view ranges in this database.");
		return;
	}

	const workIds = [
		...new Set(ranges.map((range) => range.workId).filter((id): id is number => id != null)),
	];
	const titles = new Map<number, string | null>();
	if (workIds.length > 0) {
		const workRows = await db
			.select({ id: works.id, title: works.title })
			.from(works)
			.where(inArray(works.id, workIds));
		for (const work of workRows) titles.set(work.id, work.title);
	}

	const byWork = new Map<number | null, { rows: number; seconds: number }>();
	for (const range of ranges) {
		const held = byWork.get(range.workId) ?? { rows: 0, seconds: 0 };
		held.rows += 1;
		held.seconds += range.durationSeconds ?? 0;
		byWork.set(range.workId, held);
	}

	const totalSeconds = [...byWork.values()].reduce((sum, held) => sum + held.seconds, 0);
	console.log(
		`prune-self-views: ${ranges.length} timed range(s) across ${byWork.size} Work(s), ${Math.round(totalSeconds)}s (${fmtDuration(totalSeconds)})`,
	);
	for (const [workId, held] of byWork) {
		const title =
			workId == null ? "a deleted Work" : JSON.stringify(titles.get(workId) ?? "a missing Work");
		console.log(
			`  ${workId == null ? "" : `#${workId} `}${title} — ${held.rows} range(s), ${held.seconds}s`,
		);
	}

	const rolled = rolledUpRanges(ranges);
	if (rolled.length > 0) {
		console.error(
			`prune-self-views: ${rolled.length} selected range(s) are older than ${ATTENTION_RAW_RETENTION_DAYS} days and may already be rolled into attention_daily. Refusing to delete; this needs the rollup arithmetic, not a raw delete.`,
		);
		if (apply) process.exitCode = 1;
		return;
	}

	if (!apply) {
		console.log(
			"prune-self-views: dry run — nothing deleted. Re-run with --apply to delete these ranges.",
		);
		return;
	}

	const deleted = await deleteSelfViewRanges(ranges.map((range) => range.id));
	console.log(`prune-self-views: deleted ${deleted} range(s).`);
}

if (import.meta.main) {
	await main();
	// The pool holds sockets open, so a finished script otherwise hangs the command
	// that ran it until the harness kills it. `db-row-counts.ts` exits the same way.
	process.exit(process.exitCode ?? 0);
}

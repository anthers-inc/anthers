// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recovery of transcodes orphaned by a previous worker's restart.
 *
 * 🚨 **This lives in its own module so it can be TESTED, and that is the whole reason for
 * the file.** It used to sit in `worker.ts`, which calls `start()` at module scope and
 * registers signal handlers — so importing it from a test booted a real worker against
 * pg-boss and never returned. The function was therefore reachable only from the boot
 * path, and it had zero coverage: sabotaging the `sourceKey` guard to a no-op left all 41
 * tests in `post-lifecycle` + `delivery-access` green. That is the same shape as the DMCA
 * restore cron, whose own selector was broken on every run since it shipped while a
 * thorough-looking suite exercised the manual path beside it — **a scheduled job whose
 * only coverage is the function it calls by hand is uncovered.**
 *
 * Sending is injected rather than imported for the same reason. `queue.send` needs a
 * started pg-boss, which is exactly the dependency that made this untestable; taking it
 * as a parameter lets a test assert *which queue each row was sent to* — the assertion
 * that matters, since the bug this guards against is a job resumed onto the wrong handler.
 */

import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { JOB_OPTIONS, QUEUES, queue } from "./queue.js";

/**
 * Which queue resumes an interrupted job, by the media type that produced it.
 *
 * 🚨 A MAP, not a ternary. This was `video ? TRANSCODE : PROCESS_AUDIO`, which was correct
 * while there were exactly two media types and silently wrong the moment there were three:
 * an orphaned ebook job would have resumed onto the **audio** handler, which fails on a PDF
 * for reasons that name ffmpeg. An unknown type is skipped with a warning rather than
 * guessed at, so adding a fourth media type without adding a row here loses recovery
 * loudly instead of corrupting it quietly.
 */
export const RESUME_QUEUE: Record<string, string | undefined> = {
	video: QUEUES.TRANSCODE_VIDEO,
	audio: QUEUES.PROCESS_AUDIO,
	ebook: QUEUES.RASTERIZE_EBOOK,
};

/** What the sweep did, so a caller (or a test) can assert on outcomes rather than logs. */
export interface ResumeSummary {
	/** Rows recorded `failed` because their Work carries no source file. */
	failed: number;
	/** Rows re-sent to a handler. */
	resumed: number;
	/** Rows left alone because their `mediaType` has no queue. */
	skipped: number;
}

/** The one thing this needs from the queue — injected so a test needs no pg-boss. */
export type SendJob = (queueName: string, data: { jobId: number }) => Promise<unknown>;

const sendViaQueue: SendJob = (queueName, data) =>
	queue.send(queueName, data, JOB_OPTIONS[queueName]);

/**
 * Re-queue transcodes orphaned by a previous worker's restart.
 *
 * A deploy bounces the worker and kills any in-flight ffmpeg, leaving the DB row stuck at
 * pending/processing (pg-boss would only retry after the job's 45-min expiry). On boot we
 * reset those rows and re-send them so they resume promptly; the per-job idempotency guard
 * makes a later pg-boss retry a no-op.
 *
 * A row whose Work carries no source file is **not** an orphan — it is a job that can never
 * succeed, since all three handlers throw on a missing source key before reaching ffmpeg.
 * Those are recorded failed rather than re-sent, which is the same outcome the handler
 * would reach and, unlike re-sending, takes the row out of the pending/processing set for
 * good. Re-sending them meant every worker boot fired a burst of guaranteed-failing jobs
 * that grew without bound: the API suites insert `transcoding_jobs` rows directly to
 * simulate encode state, and against a shared dev database those accumulate — 463 of them
 * by 2026-08-11, replayed in full on every `make dev`.
 *
 * ⚠️ The guard is the **source file, not the age.** An age bound was considered and
 * rejected: it would strand the genuinely-unprocessed uploads left by the pre-2026-07-26
 * era, when `make dev` ran no worker at all.
 */
export async function resumeOrphanedTranscodes(
	send: SendJob = sendViaQueue,
): Promise<ResumeSummary> {
	const summary: ResumeSummary = { failed: 0, resumed: 0, skipped: 0 };

	const orphans = await db
		.select({
			id: transcodingJobs.id,
			mediaType: transcodingJobs.mediaType,
			sourceKey: works.sourceKey,
		})
		.from(transcodingJobs)
		.innerJoin(works, eq(works.id, transcodingJobs.workId))
		.where(inArray(transcodingJobs.status, ["pending", "processing"]));
	if (orphans.length === 0) return summary;

	const unsourced = orphans.filter((job) => !job.sourceKey);
	if (unsourced.length > 0) {
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: "No source file on content item" })
			.where(
				inArray(
					transcodingJobs.id,
					unsourced.map((job) => job.id),
				),
			);
		summary.failed = unsourced.length;
		console.log(`Failed ${unsourced.length} transcode job(s) whose Work has no source file.`);
	}

	const resumable = orphans.filter((job) => job.sourceKey);
	if (resumable.length === 0) return summary;

	console.log(`Resuming ${resumable.length} orphaned transcode job(s)...`);
	for (const job of resumable) {
		// ⚠️ The reset happens BEFORE the queue lookup, so a row whose media type we cannot
		// place is still reset to `pending` and then not sent. That ordering is preserved
		// from the original exactly as it shipped, because this extraction is meant to make
		// the behaviour testable rather than to change it. It is also harmless either way:
		// the row stays in the pending/processing set and gets the same warning next boot,
		// and it is deliberately NOT failed — we have nowhere to send it, which is not the
		// same as it being unfinishable, and a later release that knows the type can run it.
		await db
			.update(transcodingJobs)
			.set({ status: "pending", progress: 0 })
			.where(eq(transcodingJobs.id, job.id));
		const q = RESUME_QUEUE[job.mediaType];
		if (!q) {
			console.warn(`Cannot resume job ${job.id}: unknown mediaType "${job.mediaType}"`);
			summary.skipped++;
			continue;
		}
		await send(q, { jobId: job.id });
		summary.resumed++;
	}

	return summary;
}

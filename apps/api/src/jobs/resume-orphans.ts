// SPDX-License-Identifier: Apache-2.0
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
	/** Rows recorded `failed` because their Work carries no source file, or because the job
	 * has already been handed back `MAX_TRANSCODE_RESUMES` times — a file that crashes the
	 * worker would otherwise be resumed on every restart forever, and while it loops
	 * nothing else on the worker runs, which is how one upload took the whole queue down
	 * three times in under a minute on 2026-09-18. */
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
 * How many times the sweep hands one job back to a handler before giving up.
 *
 * A file that crashes the worker is resumed on the next boot and crashes it again, with
 * nothing bounding the loop — one upload took the production worker down three times in
 * under a minute on 2026-09-18, and while it looped, nothing else on the worker ran. The
 * count lives on the job row rather than in memory because a crashed worker loses memory:
 * the row is the only thing both sides of a crash can read.
 *
 * Three, not one: a deploy bounces the worker mid-transcode as a matter of course, so the
 * first resume is routine rather than damning, and a give-up that fired on the first
 * resume would fail ordinary work every deploy.
 */
export const MAX_TRANSCODE_RESUMES = 3;

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
 *
 * The second guard is the **resume bound**, which is the one that stops a crash loop. A
 * sourced job is re-sent up to `MAX_TRANSCODE_RESUMES` times, counted on the row; past
 * that it is recorded failed with a reason the creator can act on, because a file too
 * large for any worker or genuinely corrupt would otherwise be resumed on every restart
 * and starve the worker's other queues while it looped.
 */
export async function resumeOrphanedTranscodes(
	send: SendJob = sendViaQueue,
): Promise<ResumeSummary> {
	const summary: ResumeSummary = { failed: 0, resumed: 0, skipped: 0 };

	const orphans = await db
		.select({
			id: transcodingJobs.id,
			mediaType: transcodingJobs.mediaType,
			resumeCount: transcodingJobs.resumeCount,
			sourceKey: works.sourceKey,
		})
		.from(transcodingJobs)
		.innerJoin(works, eq(works.id, transcodingJobs.workId))
		.where(inArray(transcodingJobs.status, ["pending", "processing"]));
	if (orphans.length === 0) return summary;

	// Jobs that have already been handed back too many times are given up on rather than
	// sent again. The reason is written for the CREATOR, since `errorMessage` is what the
	// Studio reads back when it shows a failed transcode — "crashed the worker" is the
	// thing they can act on, by re-uploading or asking.
	const exhausted = orphans.filter(
		(job) => job.sourceKey && job.resumeCount >= MAX_TRANSCODE_RESUMES,
	);
	if (exhausted.length > 0) {
		await db
			.update(transcodingJobs)
			.set({
				status: "failed",
				errorMessage:
					"Processing this file kept interrupting the media worker, so it was stopped. Re-upload the file, or contact support if it happens again.",
				updatedAt: new Date(),
			})
			.where(
				inArray(
					transcodingJobs.id,
					exhausted.map((job) => job.id),
				),
			);
	}

	const unsourced = orphans.filter((job) => !job.sourceKey);
	if (unsourced.length > 0) {
		await db
			.update(transcodingJobs)
			.set({
				status: "failed",
				errorMessage: "No source file on content item",
				updatedAt: new Date(),
			})
			.where(
				inArray(
					transcodingJobs.id,
					unsourced.map((job) => job.id),
				),
			);
		console.log(`Failed ${unsourced.length} transcode job(s) whose Work has no source file.`);
	}
	if (exhausted.length > 0) {
		console.log(
			`Failed ${exhausted.length} transcode job(s) that had already resumed ${MAX_TRANSCODE_RESUMES} times.`,
		);
	}
	summary.failed = unsourced.length + exhausted.length;

	const resumable = orphans.filter(
		(job) => job.sourceKey && job.resumeCount < MAX_TRANSCODE_RESUMES,
	);
	if (resumable.length === 0) return summary;

	console.log(`Resuming ${resumable.length} orphaned transcode job(s)...`);
	for (const job of resumable) {
		// ⚠️ The reset happens BEFORE the queue lookup, so a row whose media type we cannot
		// place is still reset to `pending` and then not sent. That ordering is preserved
		// from the original exactly as it shipped, because this extraction is meant to make
		// the behavior testable rather than to change it. It is also harmless either way:
		// the row stays in the pending/processing set and gets the same warning next boot,
		// and it is deliberately NOT failed — we have nowhere to send it, which is not the
		// same as it being unfinishable, and a later release that knows the type can run it.
		// ⚠️ The count increments only on a SEND, for the same reason: a row we never
		// handed back has not been resumed, and counting an unsendable one would fail it
		// forever for a reason it cannot act on.
		const q = RESUME_QUEUE[job.mediaType];
		if (!q) {
			await db
				.update(transcodingJobs)
				.set({ status: "pending", progress: 0, updatedAt: new Date() })
				.where(eq(transcodingJobs.id, job.id));
			console.warn(`Cannot resume job ${job.id}: unknown mediaType "${job.mediaType}"`);
			summary.skipped++;
			continue;
		}
		await db
			.update(transcodingJobs)
			.set({
				status: "pending",
				progress: 0,
				resumeCount: job.resumeCount + 1,
				updatedAt: new Date(),
			})
			.where(eq(transcodingJobs.id, job.id));
		await send(q, { jobId: job.id });
		summary.resumed++;
	}

	return summary;
}

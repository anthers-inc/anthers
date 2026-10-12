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
	ebook: QUEUES.RENDER_PAGED,
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
	/** Queued pg-boss jobs deleted because their `jobId` no longer resolves to a row —
	 * stranded by a trash cascade, which deletes `transcoding_jobs` inside the API process
	 * while a queue job for it still sits here. */
	retired: number;
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
 * ⚠️ **The ceiling counts CRASH resumes only.** A graceful (SIGTERM) stop leaves
 * `interrupted_gracefully` on the rows it bounces, and the sweep resumes those without
 * spending a slot or touching the count — a deploy landing mid-transcode is a normal,
 * expected event, and 2026-10-10 nearly failed six real uploads precisely because deploys
 * were being charged against this count. What remains under the ceiling is the genuinely
 * hard kill: an OOM kill, the disk-fill container replacement, a crash in the handler.
 *
 * Three, not one: the first hard kill can still be innocent of the file — a concurrent
 * heavy job's OOM spike or a platform hiccup takes the worker down around a perfectly
 * good encode — and a give-up that fired on the first crash would fail ordinary work too
 * eagerly. Two real crashes in a row on the same file is already a strong signal; the
 * third resume is the last chance those get.
 */
export const MAX_TRANSCODE_RESUMES = 3;

/**
 * Re-queue transcodes orphaned by a previous worker's restart.
 *
 * A worker stop kills any in-flight ffmpeg, leaving the DB row stuck at pending/processing
 * (pg-boss would only retry the job itself after its expiry window, now hours for video;
 * the boot sweep exists so recovery does not wait that long). On boot we reset those rows
 * and re-send them so they resume promptly; the per-job idempotency guard and the encode
 * lock make a later pg-boss retry a no-op.
 *
 * 🚨 **The stop's KIND decides whether the resume is charged.** A graceful stop (SIGTERM —
 * the shape of every deploy bounce) marks its rows `interrupted_gracefully` on the way
 * down (`markBenignInterrupted`); a hard kill — OOM, the disk-fill container replacement,
 * a handler crash — has no shutdown path, so its rows arrive unflagged. A flagged row
 * resumes WITHOUT spending a ceiling slot, because the interruption was a deploy bounce
 * and bounces are normal; an unflagged row resumes charged, because 2026-09-18 and
 * 2026-10-10 are what an unflagged row means. A flagged row is resumed even when
 * `resumeCount` already stands at the bound: the bound counts crash-resumes, and deploys
 * are not crashes. The flag is spent wherever the row is again acted on — cleared on this
 * sweep's re-send, and by each handler claiming the row — so it can only ever stand for
 * the interruption just suffered, never a stale one.
 *
 * ⚠️ **Progress is reset either way, and that is deliberate.** A re-run encodes from a
 * fresh source read into a fresh prefix — nothing of a killed attempt survives to resume
 * INTO — and every handler zeroes the row's own progress the moment it claims the job.
 * Preserving the old figure across the sweep would only show a stale progress bar for the
 * seconds between resume-send and handler start.
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
 * The next guard is the **resume bound**, which is the one that stops a crash loop. A
 * sourced, UNFLAGGED job is re-sent up to `MAX_TRANSCODE_RESUMES` times, counted on the
 * row; past that it is recorded failed. The message it leaves is written for the CREATOR,
 * who is the one who can act on it — but only where there is nothing of the handler's to
 * overwrite: a row that already carries a real error (an ffmpeg refusal from a previous
 * attempt) keeps it, because overwriting the one diagnostic a creator can act on with a
 * canned claim about the worker is exactly the misleading message this sweep used to
 * write over the crash cases.
 *
 * Last, the sweep retires **queued pg-boss jobs whose `jobId` no longer resolves** — the
 * strand the 2026-10-10 trash cascade left: a Work's row was deleted by the cascade inside
 * the API process while its queue job sat here, and the job then redelivered against
 * nothing, throwing "not found" on every retry until its budget ran out. Row existence is
 * checked across every status: a vanished row is a vanished row, whatever its neighbors'
 * state.
 *
 * @param lingering injected for tests, which run without pg-boss (`null` skips the retire
 * pass); the worker's boot passes the default, which needs the pg-boss boss started.
 */
export async function resumeOrphanedTranscodes(
	send: SendJob = sendViaQueue,
	lingering: LingeringQueueAccess | null = QUEUE_ACCESS,
): Promise<ResumeSummary> {
	const summary: ResumeSummary = { failed: 0, resumed: 0, skipped: 0, retired: 0 };

	const orphans = await db
		.select({
			id: transcodingJobs.id,
			mediaType: transcodingJobs.mediaType,
			resumeCount: transcodingJobs.resumeCount,
			sourceKey: works.sourceKey,
			errorMessage: transcodingJobs.errorMessage,
			interruptedGracefully: transcodingJobs.interruptedGracefully,
		})
		.from(transcodingJobs)
		.innerJoin(works, eq(works.id, transcodingJobs.workId))
		.where(inArray(transcodingJobs.status, ["pending", "processing"]));
	if (orphans.length === 0) {
		summary.retired = await retireLingeringQueueJobs(lingering);
		return summary;
	}

	// Jobs whose crash-resumes are spent are given up on rather than sent again. A row
	// carrying `interruptedGracefully` is excluded: it was bounced by a deploy, and deploys
	// do not spend the ceiling — it exists only for files that take the worker down.
	const exhausted = orphans.filter(
		(job) =>
			job.sourceKey && !job.interruptedGracefully && job.resumeCount >= MAX_TRANSCODE_RESUMES,
	);
	if (exhausted.length > 0) {
		// ⚠️ The canned message is written ONLY where the row has no error of its own. A
		// row that carries a real handler error (its previous attempt reached a catch — an
		// ffmpeg refusal, a storage failure) keeps that: `errorMessage` is what the Studio
		// reads back when it shows a failed transcode, and the real reason is the thing its
		// creator can act on. The canned text covers the row a crash left with empty error —
		// the handler never wrote anything, because the worker died before the catch ran.
		const blankError = exhausted.filter((job) => !job.errorMessage);
		if (blankError.length > 0) {
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
						blankError.map((job) => job.id),
					),
				);
		}
		// The rest fail with their own error untouched — only the status and timestamp move.
		const withError = exhausted.filter((job) => job.errorMessage);
		if (withError.length > 0) {
			await db
				.update(transcodingJobs)
				.set({ status: "failed", updatedAt: new Date() })
				.where(
					inArray(
						transcodingJobs.id,
						withError.map((job) => job.id),
					),
				);
		}
		console.log(
			`Failed ${exhausted.length} transcode job(s) that had already been crash-resumed ${MAX_TRANSCODE_RESUMES} times.`,
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
	summary.failed = unsourced.length + exhausted.length;

	const resumable = orphans.filter(
		(job) =>
			job.sourceKey && (job.interruptedGracefully || job.resumeCount < MAX_TRANSCODE_RESUMES),
	);
	if (resumable.length > 0) {
		console.log(`Resuming ${resumable.length} orphaned transcode job(s)...`);
	}
	for (const job of resumable) {
		// ⚠️ The reset happens BEFORE the queue lookup, so a row whose media type we cannot
		// place is still reset to `pending` and then not sent. That ordering is preserved
		// from the original exactly as it shipped. It is also harmless either way: the row
		// stays in the pending/processing set and gets the same warning next boot, and it
		// is deliberately NOT failed — we have nowhere to send it, which is not the same as
		// it being unfinishable, and a later release that knows the type can run it.
		// ⚠️ The count increments only on a SENT, UNFLAGGED row. A row we never handed back
		// has not been resumed, and counting an unsendable one would fail it forever for a
		// reason it cannot act on; a flagged row passes through without a charge, per the
		// docblock above, whichever `resumeCount` it arrives with.
		const q = RESUME_QUEUE[job.mediaType];
		if (!q) {
			await db
				.update(transcodingJobs)
				.set({
					status: "pending",
					progress: 0,
					// The spent flag cannot stand for anything now — the row was neither resumed
					// nor sent, and leaving it would let every later benign-free boot read the
					// same stale excuse. The next stop leaves a fresh flag if it happens again.
					interruptedGracefully: false,
					updatedAt: new Date(),
				})
				.where(eq(transcodingJobs.id, job.id));
			console.warn(`Cannot resume job ${job.id}: unknown mediaType "${job.mediaType}"`);
			summary.skipped++;
			continue;
		}
		// The flag is spent by the hand-back in every branch: it stands for ONE
		// interruption, and this re-send consumed it. If the next attempt is killed
		// hard, the row arrives unflagged and is charged as a crash — which is the
		// distinction the ceiling is for. The conditional charge lives in a hoisted
		// variable rather than inline, because `transcode-job-timestamps` reads these
		// writes with a brace-naive regex and an inline spread's `? {}` would truncate
		// the literal it captures. (Hoisting also reads fine: the whole charge story is
		// in the name and the comment.)
		const charge = job.interruptedGracefully ? {} : { resumeCount: job.resumeCount + 1 };
		await db
			.update(transcodingJobs)
			.set({
				status: "pending",
				progress: 0,
				interruptedGracefully: false,
				updatedAt: new Date(),
				...charge,
			})
			.where(eq(transcodingJobs.id, job.id));
		await send(q, { jobId: job.id });
		summary.resumed++;
	}

	summary.retired = await retireLingeringQueueJobs(lingering);

	return summary;
}

// ── Lingering queue jobs ─────────────────────────────────────────────────

/** The one thing this needs from the queue to retire stranded jobs — injected for tests. */
export interface QueuedTranscodeJob {
	id: string;
	data: Record<string, unknown>;
}

export interface LingeringQueueAccess {
	findQueued(queueName: string): Promise<QueuedTranscodeJob[]>;
	deleteJob(queueName: string, id: string): Promise<unknown>;
}

const QUEUE_ACCESS: LingeringQueueAccess = {
	findQueued: (queueName) => queue.findQueuedJobs<{ jobId?: unknown }>(queueName),
	deleteJob: (queueName, id) => queue.deleteQueuedJob(queueName, id),
};

/**
 * Delete queued pg-boss jobs whose `jobId` no longer resolves to a `transcoding_jobs` row.
 *
 * The trash cascade deletes a Work inside the API process — cascading its transcoding rows
 * with it — while the pg-boss job enqueued for it sits queued in the worker's tables. The
 * job then redelivers against nothing, throwing `TranscodingJob not found` on every retry,
 * until its budget runs out. This pass deletes those on boot, so the row's death takes the
 * job with it.
 *
 * Only QUEUED states (`created`/`retry`) are examined, deliberately: an active job for a
 * vanished row is a handler already executing, and it exits on its own "not found" throw
 * within its retry budget. Jobs whose row still exists are never touched — the enqueue
 * sites insert the row before sending, so a present row always covers its job. A job whose
 * `data.jobId` is malformed (missing or not a number) is likewise deleted: the handler
 * cannot resolve one at any time, so there is nothing it could ever do but fail.
 */
export async function retireLingeringQueueJobs(
	lingering: LingeringQueueAccess | null = QUEUE_ACCESS,
): Promise<number> {
	if (!lingering) return 0;

	const queueNames = [...new Set(Object.values(RESUME_QUEUE).filter(Boolean))] as string[];
	const known = new Set(
		(await db.select({ id: transcodingJobs.id }).from(transcodingJobs)).map((row) => row.id),
	);

	let retired = 0;
	for (const queueName of queueNames) {
		for (const job of await lingering.findQueued(queueName)) {
			const jobId = job.data?.jobId;
			if (typeof jobId === "number" && known.has(jobId)) continue;
			await lingering.deleteJob(queueName, job.id);
			console.log(
				`[resume-orphans] retired queued ${queueName} job for ${typeof jobId === "number" ? `vanished row ${jobId}` : "a malformed payload"}`,
			);
			retired++;
		}
	}
	return retired;
}

/**
 * Record a deliberate stop. Called from the worker's shutdown path on SIGTERM, BEFORE
 * `queue.stop()` — so the write is down even if the platform's kill outlives the graceful
 * window — covering every row still pending or processing.
 *
 * Rows the handlers complete during the stop's grace window keep the flag with them; it is
 * inert on a terminal row, and the sweep reads nothing but pending/processing.
 */
export async function markBenignInterrupted(): Promise<void> {
	await db
		.update(transcodingJobs)
		.set({ interruptedGracefully: true })
		.where(inArray(transcodingJobs.status, ["pending", "processing"]));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Job worker entry point.
 *
 * Run as a separate Bun process: bun run apps/api/src/jobs/worker.ts
 * Or via: make dev-worker
 */

// Must precede any import that reads process.env — see api/src/dev-spec-env.ts.
import "../dev-spec-env.js";

import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { runDueDeletions } from "../services/account-deletion.js";
import { deleteExpiredSessions, deleteExpiredTokens } from "../services/auth.js";
import {
	finalizeNotice,
	noticesReadyForFinality,
	noticesReadyForRestore,
	restoreWork,
} from "../services/dmca.js";
import { deleteExpiredSignupCodes } from "../services/signup-codes.js";
import { calculateCrfSubsidies } from "./calculate-crf.js";
import { type CrossPublishData, crossPublish } from "./cross-publish.js";
import { type DistributePoolData, distributePool } from "./distribute-pool.js";
import { fetchExternalMetrics } from "./fetch-metrics.js";
import { type PackageVideoData, packageVideo } from "./package-video.js";
import { type ProcessAudioData, processAudio } from "./process-audio.js";
import { handlePruneAttention, type PruneAttentionData } from "./prune-attention.js";
import { publishScheduled } from "./publish-scheduled.js";
import { CRON_SCHEDULES, ensureQueueReady, JOB_OPTIONS, QUEUES, queue } from "./queue.js";
import { type RasterizeEbookData, rasterizeEbook } from "./rasterize-ebook.js";
import { type SettleCycleData, settleCycle } from "./settle-cycle.js";
import { type TranscodeVideoData, transcodeVideo } from "./transcode-video.js";

/**
 * Re-queue transcodes orphaned by a previous worker's restart. A deploy bounces
 * the worker and kills any in-flight ffmpeg, leaving the DB row stuck at
 * pending/processing (pg-boss would only retry after the job's 45-min expiry).
 * On boot we reset those rows and re-send them so they resume promptly; the
 * per-job idempotency guard makes a later pg-boss retry a no-op.
 *
 * A row whose Work carries no source file is NOT an orphan — it is a job that can
 * never succeed, since all three handlers throw on a missing source key before
 * reaching ffmpeg. Those are recorded as failed here rather than re-sent, which is
 * the same outcome the handler would reach and, unlike re-sending, takes the row out
 * of the pending/processing set for good. Re-sending them meant every worker boot
 * fired a burst of guaranteed-failing jobs that grew without bound: the API test
 * suite inserts transcoding_jobs rows directly to simulate encode state (see
 * post-lifecycle / delivery-access), and against a shared dev database those
 * accumulate — 463 of them by 2026-08-11, replayed in full on every `make dev`.
 */
async function resumeOrphanedTranscodes(): Promise<void> {
	const orphans = await db
		.select({
			id: transcodingJobs.id,
			mediaType: transcodingJobs.mediaType,
			sourceKey: works.sourceKey,
		})
		.from(transcodingJobs)
		.innerJoin(works, eq(works.id, transcodingJobs.workId))
		.where(inArray(transcodingJobs.status, ["pending", "processing"]));
	if (orphans.length === 0) return;

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
		console.log(`Failed ${unsourced.length} transcode job(s) whose Work has no source file.`);
	}

	const resumable = orphans.filter((job) => job.sourceKey);
	if (resumable.length === 0) return;

	console.log(`Resuming ${resumable.length} orphaned transcode job(s)...`);
	for (const job of resumable) {
		await db
			.update(transcodingJobs)
			.set({ status: "pending", progress: 0 })
			.where(eq(transcodingJobs.id, job.id));
		// 🚨 A MAP, not a ternary. This was `video ? TRANSCODE : PROCESS_AUDIO`, which was
		// correct while there were exactly two media types and silently wrong the moment
		// there were three: an orphaned ebook job would have been resumed onto the audio
		// handler, which would fail on a PDF for reasons that name ffmpeg. An unknown type
		// is skipped with a warning rather than guessed at.
		const q = RESUME_QUEUE[job.mediaType];
		if (!q) {
			console.warn(`Cannot resume job ${job.id}: unknown mediaType "${job.mediaType}"`);
			continue;
		}
		await queue.send(q, { jobId: job.id }, JOB_OPTIONS[q]);
	}
}

/** Which queue resumes an interrupted job, by the media type that produced it. */
const RESUME_QUEUE: Record<string, string | undefined> = {
	video: QUEUES.TRANSCODE_VIDEO,
	audio: QUEUES.PROCESS_AUDIO,
	ebook: QUEUES.RASTERIZE_EBOOK,
};

async function start() {
	console.log("Starting job worker...");
	await ensureQueueReady();
	console.log("Queue started. Registering handlers...");

	// ── On-demand jobs ────────────────────────────────────────────────

	await queue.work<TranscodeVideoData>(
		QUEUES.TRANSCODE_VIDEO,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[transcode-video] Processing job ${job.id}`);
				await transcodeVideo(job.data);
			}
		},
	);

	// Browser-encoded uploads: remux the client's MP4 variants into HLS (cheap copy).
	await queue.work<PackageVideoData>(
		QUEUES.PACKAGE_VIDEO,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[package-video] Processing job ${job.id}`);
				await packageVideo(job.data);
			}
		},
	);

	await queue.work<ProcessAudioData>(
		QUEUES.PROCESS_AUDIO,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[process-audio] Processing job ${job.id}`);
				await processAudio(job.data);
			}
		},
	);

	await queue.work<RasterizeEbookData>(
		QUEUES.RASTERIZE_EBOOK,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[rasterize-ebook] Processing job ${job.id}`);
				await rasterizeEbook(job.data);
			}
		},
	);

	await queue.work<CrossPublishData>(
		QUEUES.CROSS_PUBLISH,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[cross-publish] Processing job ${job.id}`);
				await crossPublish(job.data);
			}
		},
	);

	// ── Scheduled jobs ────────────────────────────────────────────────

	await queue.work<DistributePoolData>(QUEUES.DISTRIBUTE_POOL, async (jobs) => {
		for (const job of jobs) {
			console.log(`[distribute-pool] Processing job ${job.id}`);
			await distributePool(job.data);
		}
	});

	await queue.work<SettleCycleData>(QUEUES.SETTLE_CYCLE, async (jobs) => {
		for (const job of jobs) {
			console.log(`[settle-cycle] Processing job ${job.id}`);
			await settleCycle(job.data);
		}
	});

	// hosting subsidy calculation (legacy queue name: calculate-crf)
	await queue.work(QUEUES.CALCULATE_CRF, async (jobs) => {
		for (const job of jobs) {
			console.log(`[calculate-crf] Processing job ${job.id}`);
			await calculateCrfSubsidies();
		}
	});

	await queue.work(QUEUES.FETCH_METRICS, async (jobs) => {
		for (const job of jobs) {
			console.log(`[fetch-metrics] Processing job ${job.id}`);
			await fetchExternalMetrics();
		}
	});

	await queue.work(QUEUES.RUN_DELETIONS, async (jobs) => {
		for (const job of jobs) {
			console.log(`[run-deletions] Processing job ${job.id}`);
			await runDueDeletions();
		}
	});

	await queue.work(QUEUES.PRUNE_CREDENTIALS, async (jobs) => {
		for (const job of jobs) {
			const [sessionsGone, tokensGone, codesGone] = await Promise.all([
				deleteExpiredSessions(),
				deleteExpiredTokens(),
				deleteExpiredSignupCodes(),
			]);
			if (sessionsGone > 0 || tokensGone > 0 || codesGone > 0) {
				console.log(
					`[prune-credentials] job ${job.id}: removed ${sessionsGone} expired session(s), ${tokensGone} expired token(s), ${codesGone} expired signup code(s)`,
				);
			}
		}
	});

	await queue.work<PruneAttentionData>(QUEUES.PRUNE_ATTENTION, async (jobs) => {
		for (const job of jobs) {
			console.log(`[prune-attention] Processing job ${job.id}`);
			await handlePruneAttention(job.data ?? {});
		}
	});

	await queue.work(QUEUES.PUBLISH_SCHEDULED, async (jobs) => {
		for (const job of jobs) {
			const n = await publishScheduled();
			if (n > 0) console.log(`[publish-scheduled] job ${job.id}: published ${n} scheduled post(s)`);
		}
	});

	await queue.work(QUEUES.DMCA_RESTORE, async (jobs) => {
		for (const job of jobs) {
			const ready = await noticesReadyForRestore();
			for (const notice of ready) {
				const result = await restoreWork({ noticeId: notice.noticeId });
				if (result) {
					console.log(
						`[dmca-restore] job ${job.id}: restored work ${notice.workId} (notice #${notice.noticeId})`,
					);
				}
			}
		}
	});

	// Settle takedowns whose counter-notice window closed with no answer: refund
	// every buyer of the Work. Separate from the restore sweep so a Stripe outage
	// cannot stop a statutory restore — see the comment on QUEUES.DMCA_FINALIZE.
	await queue.work(QUEUES.DMCA_FINALIZE, async (jobs) => {
		for (const job of jobs) {
			const ready = await noticesReadyForFinality();
			for (const notice of ready) {
				const result = await finalizeNotice({
					noticeId: notice.noticeId,
					reason: "no_counter_notice",
				});
				if (result?.finalized) {
					console.log(
						`[dmca-finalize] job ${job.id}: notice #${notice.noticeId} final, refunded ${result.buyersRefunded} buyer(s)`,
					);
				} else if (result && !result.finalized) {
					// Not an error in most cases — a Work restored early, or a notice
					// already settled. `refunds_failed` IS one, and stays un-final so
					// tomorrow's sweep retries it.
					console.log(
						`[dmca-finalize] job ${job.id}: notice #${notice.noticeId} not finalized (${result.reason})`,
					);
				}
			}
		}
	});

	// ── Cron schedules ────────────────────────────────────────────────

	for (const [queueName, cron] of CRON_SCHEDULES) {
		await queue.schedule(queueName, cron, {});
	}

	// Recover any transcodes interrupted by the previous worker's shutdown.
	// Best-effort: recovery must never crash the worker, so failures are logged,
	// not thrown (a stuck job still self-heals via pg-boss's retry-on-expiry).
	try {
		await resumeOrphanedTranscodes();
	} catch (err) {
		console.error("Failed to resume orphaned transcodes (non-fatal):", err);
	}

	console.log("Worker ready. Listening for jobs...");
	console.log(
		"Scheduled: distribute-pool (daily), settle-cycle (monthly), calculate-crf (daily), fetch-metrics (6h), publish-scheduled (1m)",
	);
}

// ── Graceful shutdown ──────────────────────────────────────────────────

async function shutdown() {
	console.log("Shutting down worker...");
	await queue.stop({ graceful: true, timeout: 30000 });
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
	console.error("Worker failed to start:", err);
	process.exit(1);
});

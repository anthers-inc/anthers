// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Job worker entry point.
 *
 * Run as a separate Bun process: bun run apps/api/src/jobs/worker.ts
 * Or via: make dev-worker
 */

import { db } from "@anthers/db";
import { transcodingJobs } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { calculateCrfSubsidies } from "./calculate-crf.js";
import { type CrossPublishData, crossPublish } from "./cross-publish.js";
import { type DistributePoolData, distributePool } from "./distribute-pool.js";
import { fetchExternalMetrics } from "./fetch-metrics.js";
import { type ProcessAudioData, processAudio } from "./process-audio.js";
import { ensureQueueReady, JOB_OPTIONS, QUEUES, queue } from "./queue.js";
import { type TranscodeVideoData, transcodeVideo } from "./transcode-video.js";

/**
 * Re-queue transcodes orphaned by a previous worker's restart. A deploy bounces
 * the worker and kills any in-flight ffmpeg, leaving the DB row stuck at
 * pending/processing (pg-boss would only retry after the job's 45-min expiry).
 * On boot we reset those rows and re-send them so they resume promptly; the
 * per-job idempotency guard makes a later pg-boss retry a no-op.
 */
async function resumeOrphanedTranscodes(): Promise<void> {
	const orphans = await db
		.select({ id: transcodingJobs.id, mediaType: transcodingJobs.mediaType })
		.from(transcodingJobs)
		.where(inArray(transcodingJobs.status, ["pending", "processing"]));
	if (orphans.length === 0) return;

	console.log(`Resuming ${orphans.length} orphaned transcode job(s)...`);
	for (const job of orphans) {
		await db
			.update(transcodingJobs)
			.set({ status: "pending", progress: 0 })
			.where(eq(transcodingJobs.id, job.id));
		const q = job.mediaType === "video" ? QUEUES.TRANSCODE_VIDEO : QUEUES.PROCESS_AUDIO;
		await queue.send(q, { jobId: job.id }, JOB_OPTIONS[q]);
	}
}

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

	// Foundation subsidy calculation (legacy queue name: calculate-crf)
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

	// ── Cron schedules ────────────────────────────────────────────────

	await queue.schedule(QUEUES.DISTRIBUTE_POOL, "0 0 * * *", {}); // midnight daily
	// Foundation subsidy calculation (legacy queue name: calculate-crf)
	await queue.schedule(QUEUES.CALCULATE_CRF, "0 1 * * *", {}); // 1 AM daily (idempotent per month)
	await queue.schedule(QUEUES.FETCH_METRICS, "0 */6 * * *", {}); // every 6 hours

	// Recover any transcodes interrupted by the previous worker's shutdown.
	await resumeOrphanedTranscodes();

	console.log("Worker ready. Listening for jobs...");
	console.log("Scheduled: distribute-pool (daily), calculate-crf (daily), fetch-metrics (6h)");
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

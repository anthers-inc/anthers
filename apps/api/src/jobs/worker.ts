/**
 * Job worker entry point.
 *
 * Run as a separate Bun process: bun run apps/api/src/jobs/worker.ts
 * Or via: make dev-worker
 */

import { calculateCrfSubsidies } from "./calculate-crf.js";
import { type CrossPublishData, crossPublish } from "./cross-publish.js";
import { type DistributePoolData, distributePool } from "./distribute-pool.js";
import { fetchExternalMetrics } from "./fetch-metrics.js";
import { type ProcessAudioData, processAudio } from "./process-audio.js";
import { ensureQueueReady, QUEUES, queue } from "./queue.js";
import { type TranscodeVideoData, transcodeVideo } from "./transcode-video.js";

async function start() {
	console.log("Starting job worker...");
	await ensureQueueReady();
	console.log("Queue started. Registering handlers...");

	// ── On-demand jobs ────────────────────────────────────────────────

	queue.work<TranscodeVideoData>(QUEUES.TRANSCODE_VIDEO, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			console.log(`[transcode-video] Processing job ${job.id}`);
			await transcodeVideo(job.data);
		}
	});

	queue.work<ProcessAudioData>(QUEUES.PROCESS_AUDIO, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			console.log(`[process-audio] Processing job ${job.id}`);
			await processAudio(job.data);
		}
	});

	queue.work<CrossPublishData>(QUEUES.CROSS_PUBLISH, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			console.log(`[cross-publish] Processing job ${job.id}`);
			await crossPublish(job.data);
		}
	});

	// ── Scheduled jobs ────────────────────────────────────────────────

	queue.work<DistributePoolData>(QUEUES.DISTRIBUTE_POOL, async (jobs) => {
		for (const job of jobs) {
			console.log(`[distribute-pool] Processing job ${job.id}`);
			await distributePool(job.data);
		}
	});

	// Foundation subsidy calculation (legacy queue name: calculate-crf)
	queue.work(QUEUES.CALCULATE_CRF, async (jobs) => {
		for (const job of jobs) {
			console.log(`[calculate-crf] Processing job ${job.id}`);
			await calculateCrfSubsidies();
		}
	});

	queue.work(QUEUES.FETCH_METRICS, async (jobs) => {
		for (const job of jobs) {
			console.log(`[fetch-metrics] Processing job ${job.id}`);
			await fetchExternalMetrics();
		}
	});

	// ── Cron schedules ────────────────────────────────────────────────

	queue.schedule(QUEUES.DISTRIBUTE_POOL, "0 0 * * *", {}); // midnight daily
	// Foundation subsidy calculation (legacy queue name: calculate-crf)
	queue.schedule(QUEUES.CALCULATE_CRF, "0 1 * * *", {}); // 1 AM daily (idempotent per month)
	queue.schedule(QUEUES.FETCH_METRICS, "0 */6 * * *", {}); // every 6 hours

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

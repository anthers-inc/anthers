/**
 * pg-boss worker entry point.
 *
 * Run as a separate Bun process: bun run apps/api/src/jobs/worker.ts
 * Or via: make dev-worker
 */

import { boss, QUEUES, ensureBossReady } from "./boss.js";
import { transcodeVideo, type TranscodeVideoData } from "./transcode-video.js";
import { processAudio, type ProcessAudioData } from "./process-audio.js";
import {
	distributePool,
	type DistributePoolData,
} from "./distribute-pool.js";
import { calculateCrfSubsidies } from "./calculate-crf.js";
import {
	crossPublish,
	type CrossPublishData,
} from "./cross-publish.js";
import { fetchExternalMetrics } from "./fetch-metrics.js";

async function start() {
	console.log("Starting pg-boss worker...");
	await ensureBossReady();
	console.log("pg-boss started. Registering handlers...");

	// ── On-demand jobs ────────────────────────────────────────────────

	await boss.work<TranscodeVideoData>(
		QUEUES.TRANSCODE_VIDEO,
		{ teamConcurrency: 2 },
		async (job) => {
			console.log(`[transcode-video] Processing job ${job.id}`);
			await transcodeVideo(job.data);
		},
	);

	await boss.work<ProcessAudioData>(
		QUEUES.PROCESS_AUDIO,
		{ teamConcurrency: 2 },
		async (job) => {
			console.log(`[process-audio] Processing job ${job.id}`);
			await processAudio(job.data);
		},
	);

	await boss.work<CrossPublishData>(
		QUEUES.CROSS_PUBLISH,
		{ teamConcurrency: 2 },
		async (job) => {
			console.log(`[cross-publish] Processing job ${job.id}`);
			await crossPublish(job.data);
		},
	);

	// ── Scheduled jobs ────────────────────────────────────────────────

	await boss.work<DistributePoolData>(
		QUEUES.DISTRIBUTE_POOL,
		async (job) => {
			console.log(`[distribute-pool] Processing job ${job.id}`);
			await distributePool(job.data);
		},
	);

	await boss.work(QUEUES.CALCULATE_CRF, async (job) => {
		console.log(`[calculate-crf] Processing job ${job.id}`);
		await calculateCrfSubsidies();
	});

	await boss.work(QUEUES.FETCH_METRICS, async (job) => {
		console.log(`[fetch-metrics] Processing job ${job.id}`);
		await fetchExternalMetrics();
	});

	// ── Cron schedules (replaces Celery Beat) ─────────────────────────

	await boss.schedule(QUEUES.DISTRIBUTE_POOL, "0 0 * * *", {}); // midnight daily
	await boss.schedule(QUEUES.CALCULATE_CRF, "0 1 * * *", {}); // 1 AM daily (idempotent per month)
	await boss.schedule(QUEUES.FETCH_METRICS, "0 */6 * * *", {}); // every 6 hours

	console.log("Worker ready. Listening for jobs...");
	console.log("Scheduled: distribute-pool (daily), calculate-crf (daily), fetch-metrics (6h)");
}

// ── Graceful shutdown ──────────────────────────────────────────────────

async function shutdown() {
	console.log("Shutting down worker...");
	await boss.stop({ graceful: true, timeout: 30000 });
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
	console.error("Worker failed to start:", err);
	process.exit(1);
});

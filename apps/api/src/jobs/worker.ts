// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Job worker entry point.
 *
 * Run as a separate Bun process: bun run apps/api/src/jobs/worker.ts
 * Or via: make dev-worker
 */

// Must precede any import that reads process.env — see api/src/dev-spec-env.ts.
import "../dev-spec-env.js";

import { runAbuseEscalationSweep } from "../services/abuse-reports.js";
import { runDueDeletions } from "../services/account-deletion.js";
import { deleteExpiredSessions, deleteExpiredTokens } from "../services/auth.js";
import {
	finalizeNotice,
	noticesReadyForFinality,
	noticesReadyForRestore,
	restoreWork,
} from "../services/dmca.js";
import { runEscalationSweep } from "../services/moderation.js";
import { runRetentionSweep } from "../services/retention.js";
import { deleteExpiredSignupCodes } from "../services/signup-codes.js";
import { calculateCrfSubsidies } from "./calculate-crf.js";
import { type CrossPublishData, crossPublish } from "./cross-publish.js";
import { type DistributePoolData, distributePool } from "./distribute-pool.js";
import { fetchExternalMetrics } from "./fetch-metrics.js";
import { type ProcessAudioData, processAudio } from "./process-audio.js";
import { handlePruneAttention, type PruneAttentionData } from "./prune-attention.js";
import { publishScheduled } from "./publish-scheduled.js";
import { CRON_SCHEDULES, ensureQueueReady, QUEUES, queue } from "./queue.js";
import { type RasterizeEbookData, rasterizeEbook } from "./rasterize-ebook.js";
import { resumeOrphanedTranscodes } from "./resume-orphans.js";
import { type ScanMediaData, scanMedia } from "./scan-media.js";
import { type SettleCycleData, settleCycle } from "./settle-cycle.js";
import { type TranscodeVideoData, transcodeVideo } from "./transcode-video.js";

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

	// Detection runs off the request path — see the job's header for why it has to.
	await queue.work<ScanMediaData>(QUEUES.SCAN_MEDIA, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			await scanMedia(job.data);
		}
	});

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

	// Age the personal detail out of settled safety and copyright records. Logs
	// only when it actually redacted something — a daily "0 records" line for a
	// three-year threshold is noise that trains people to skip the log.
	await queue.work(QUEUES.REDACT_RECORDS, async (jobs) => {
		for (const job of jobs) {
			const result = await runRetentionSweep();
			const total = result.dmcaNotices + result.moderationReports + result.abuseReports;
			if (total > 0) {
				console.log(
					`[redact-records] job ${job.id}: redacted ${result.dmcaNotices} DMCA notice(s), ${result.moderationReports} moderation report(s), ${result.abuseReports} public report(s)`,
				);
			}
		}
	});

	// Retry floor-report alerts that never went out. Logs only when it actually sent
	// something — a five-minute "0 pending" line would bury everything else in the
	// worker log within a day, and this is a log somebody has to be able to read.
	await queue.work(QUEUES.ESCALATE_REPORTS, async (jobs) => {
		for (const job of jobs) {
			// Both intakes, one sweep. In-app reports and public no-account reports live in
			// separate tables for the reasons 40.12 gives, but they owe the same alert to
			// the same mailbox against the same statutory "as soon as reasonably possible"
			// — so a second cron would be a second thing to notice had stopped running.
			const sent = await runEscalationSweep();
			const sentPublic = await runAbuseEscalationSweep();
			if (sent > 0 || sentPublic > 0) {
				console.log(
					`[escalate-reports] job ${job.id}: escalated ${sent} floor report(s) and ${sentPublic} public report(s)`,
				);
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

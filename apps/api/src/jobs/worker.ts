// SPDX-License-Identifier: Apache-2.0
/**
 * Job worker entry point.
 *
 * Run as a separate Bun process: bun run apps/api/src/jobs/worker.ts
 * Or via: make dev-worker
 */

// Must precede any import that reads process.env — see api/src/dev-spec-env.ts.
import "../dev-spec-env.js";

import { db } from "@anthers/db";
import { workTranscodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { runAbuseEscalationSweep } from "../services/abuse-reports.js";
import { runDueDeletions } from "../services/account-deletion.js";
import {
	deleteExpiredAdminSessions,
	deleteExpiredAdminSignInCodes,
} from "../services/admin-accounts.js";
import { deleteExpiredSessions } from "../services/auth.js";
import { reconcileRoles } from "../services/discord.js";
import {
	finalizeNotice,
	isNoticeStatusRefusal,
	noticesReadyForFinality,
	noticesReadyForRestore,
	restoreWork,
	retryUnsentCounterNotices,
} from "../services/dmca.js";
import {
	liftExpiredSuspensions,
	notifySupportersOfSuspensions,
	runEscalationSweep,
} from "../services/moderation.js";
import { releaseStalePayoutHolds } from "../services/payouts.js";
import { sweepRateLimits } from "../services/rate-limit.js";
import { runRetentionSweep } from "../services/retention.js";
import { sweepSignupChallenges } from "../services/signup-challenges.js";
import { deleteExpiredSignupCodes } from "../services/signup-codes.js";
import { publishFundLedger } from "../services/time-pool-fund.js";
import { type AccessReceiptsJobData, accessReceiptsJob } from "./access-receipts.js";
import { runConnectionCensus } from "./connection-census.js";
import { runDeadlineReminderSweep } from "./deadline-reminders.js";
import { type DistributePoolData, distributePool } from "./distribute-pool.js";
import { runHlsOrphanSweep } from "./hls-orphan-sweep.js";
import { type IngestEbookData, ingestEbook } from "./ingest-ebook.js";
import { runMediaJob } from "./media-lane.js";
import { handlePruneAttention, type PruneAttentionData } from "./prune-attention.js";
import { handlePruneTraffic, type PruneTrafficData } from "./prune-traffic.js";
import { publishScheduled } from "./publish-scheduled.js";
import { runPurchaseTransferRetry } from "./purchase-transfer-retry.js";
import {
	CRON_SCHEDULES,
	ensureQueueReady,
	JOB_OPTIONS,
	QUEUE_BY_MEDIA_TYPE,
	QUEUES,
	queue,
	RESCHEDULE_ON_RETIRE,
	RETIRED_QUEUES,
} from "./queue.js";
import { runQueueFailureReport } from "./queue-health.js";
import { reconcileListings } from "./reconcile-listings.js";
import { releaseScheduled } from "./release-scheduled.js";
import { type RemoveAtprotoRecordData, removeAtprotoRecordJob } from "./remove-atproto-record.js";
import { type RenderPagedData, renderPaged } from "./render-paged.js";
import { rescanOwed } from "./rescan-owed.js";
import { markBenignInterrupted, resumeOrphanedTranscodes } from "./resume-orphans.js";
import { type ScanMediaData, scanMedia } from "./scan-media.js";
import { schemaStandingNow, watchSchema } from "./schema-guard.js";
import { type SettleCycleData, settleCycle } from "./settle-cycle.js";
import { runShipmentClock } from "./shipment-clock.js";
import { type SpaceBackupJobData, spaceBackupJob } from "./space-backup.js";
import { type SpaceOutboxJobData, spaceOutboxJob } from "./space-outbox.js";
import { statusSample } from "./status-sample.js";
import { runStorageUsageSweep } from "./storage-usage.js";
import { type SyncAtprotoRecordData, syncAtprotoRecordJob } from "./sync-atproto-record.js";
import { type SyncWorkListingData, syncWorkListingJob } from "./sync-work-listing.js";
import { type TransferHeldCreditsData, transferHeldCredits } from "./transfer-held-credits.js";
import { runUploadSessionSweep } from "./upload-session-sweep.js";
import { watchHostedIdentities } from "./watch-identities.js";
import { runWithdrawnSweep } from "./withdrawn-sweep.js";

async function start() {
	console.log("Starting job worker...");

	// 🚨 **The first thing a worker does is find out whether it is the outgoing build.** The
	// migrate job runs before the new components start and the old deployment keeps serving
	// until they are healthy, so a rename or a drop lands under code still asking for the old
	// names. Three sweeps paid for that on 2026-10-28. A build that is behind starts no queue at
	// all: the jobs wait, untouched, for the replacement, and nothing here can fail against a
	// schema it does not know.
	const standing = await schemaStandingNow();
	if (standing === "build-behind") {
		console.warn(
			"[worker] standing down before starting: the database has applied a migration this " +
				"build does not ship. No queue is started and no handler runs; the work waits for " +
				"the incoming deployment.",
		);
		await holdForReplacement();
		return;
	}

	await ensureQueueReady();
	console.log("Queue started. Registering handlers...");

	// ── On-demand jobs ────────────────────────────────────────────────

	// The media lane's two per-type queues — video single-file, audio two at a time
	// (`QUEUES`' comment carries the measured shape, `lib/ffmpeg.ts` the sizing). The
	// handler dispatches on the row's own `mediaType` — the row re-read is where a job's
	// idempotency and cancel guards already live — so each queue's handler is the same
	// `runMediaJob`, and a delivery that arrives on the wrong queue for its row still
	// routes by the row, never by whatever queue happened to carry it.
	await queue.work<{ jobId: number }>(
		QUEUES.TRANSCODE_VIDEO,
		{ localConcurrency: 1 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[transcode-video] Processing row ${job.data?.jobId}`);
				await runMediaJob(job.data.jobId);
			}
		},
	);
	await queue.work<{ jobId: number }>(
		QUEUES.PROCESS_AUDIO,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				console.log(`[process-audio] Processing row ${job.data?.jobId}`);
				await runMediaJob(job.data.jobId);
			}
		},
	);

	// Detection runs off the request path — see the job's header for why it has to.
	await queue.work<ScanMediaData>(QUEUES.SCAN_MEDIA, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			await scanMedia(job.data);
		}
	});

	await queue.work<RenderPagedData>(QUEUES.RENDER_PAGED, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			console.log(`[render-paged] Processing job ${job.id}`);
			await renderPaged(job.data);
		}
	});

	await queue.work<IngestEbookData>(QUEUES.INGEST_EBOOK, { localConcurrency: 2 }, async (jobs) => {
		for (const job of jobs) {
			console.log(`[ingest-ebook] Processing job ${job.id}`);
			await ingestEbook(job.data);
		}
	});

	await queue.work<SyncWorkListingData>(
		QUEUES.SYNC_WORK_LISTING,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				await syncWorkListingJob(job.data);
			}
		},
	);

	await queue.work<SyncAtprotoRecordData>(
		QUEUES.SYNC_ATPROTO_RECORD,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				await syncAtprotoRecordJob(job.data);
			}
		},
	);

	await queue.work<RemoveAtprotoRecordData>(
		QUEUES.REMOVE_ATPROTO_RECORD,
		{ localConcurrency: 2 },
		async (jobs) => {
			for (const job of jobs) {
				await removeAtprotoRecordJob(job.data);
			}
		},
	);

	// ── Scheduled jobs ────────────────────────────────────────────────

	await queue.work(QUEUES.RECONCILE_LISTINGS, async () => {
		await reconcileListings();
	});

	// The Discord backstop, on the same reasoning as the listings one: a grant Discord refused,
	// a creator who turned creator mode off, and a role changed by hand in the server all leave
	// the two records disagreeing with nothing noticing. Quiet when every linked account is
	// already right.
	await queue.work(QUEUES.DISCORD_RECONCILE, async (jobs) => {
		for (const job of jobs) {
			const summary = await reconcileRoles();
			if (summary.checked > 0) {
				console.log(
					`[discord-reconcile] job ${job.id}: checked ${summary.checked}, failed ${summary.failed}`,
				);
			}
		}
	});

	// The user-space outbox. Quiet on a clean sweep (the handler says when it spoke), and
	// bounded so one pass cannot monopolize the worker against the media lane.
	await queue.work<SpaceOutboxJobData>(
		QUEUES.SPACE_OUTBOX,
		{ localConcurrency: 1 },
		async (jobs) => {
			for (const job of jobs) {
				await spaceOutboxJob(job.data);
			}
		},
	);

	// The nightly space backup and its prune. One job a night; the handler logs only when it
	// captured or retired something.
	await queue.work<SpaceBackupJobData>(
		QUEUES.SPACE_BACKUP,
		{ localConcurrency: 1 },
		async (jobs) => {
			for (const job of jobs) {
				await spaceBackupJob(job.data);
			}
		},
	);

	// The receipts owed to readers' spaces. A minute apart, because the row is the worklist
	// and a settled purchase's proof should not lag the purchase.
	await queue.work<AccessReceiptsJobData>(
		QUEUES.ACCESS_RECEIPTS,
		{ localConcurrency: 1 },
		async (jobs) => {
			for (const job of jobs) {
				await accessReceiptsJob(job.data);
			}
		},
	);

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

	// The Time Pool Fund's monthly publication — the ledger's actuals restated, next
	// month committed, one further estimated. Idempotent by row; quiet unless the
	// window grew.
	await queue.work(QUEUES.PUBLISH_POOL_FUND, async (jobs) => {
		for (const job of jobs) {
			console.log(`[publish-pool-fund] Processing job ${job.id}`);
			const published = await publishFundLedger();
			if (published > 0)
				console.log(`[publish-pool-fund] job ${job.id}: ${published} cycle row(s) published`);
		}
	});

	// The half of the payouts decision settlement is the other half of: what settlement
	// credited, this moves into the creator's connected account once its own hold has
	// passed. Quiet on a clean sweep, like the settle handler, for the same reason.
	await queue.work<TransferHeldCreditsData>(QUEUES.TRANSFER_HELD_CREDITS, async (jobs) => {
		for (const job of jobs) {
			const { creators } = await transferHeldCredits(job.data);
			if (creators > 0)
				console.log(
					`[transfer-held-credits] job ${job.id}: moved money for ${creators} creator(s)`,
				);
		}
	});

	// The shipment clock: closes the wait on parcels nothing reported delivered. Quiet on
	// a clean sweep, like the other dated jobs.
	await queue.work(QUEUES.SHIPMENT_CLOCK, async (jobs) => {
		for (const job of jobs) {
			const { closed, released } = await runShipmentClock();
			if (closed > 0)
				console.log(`[shipment-clock] job ${job.id}: ${closed} parcel(s) closed by fallback`);
			if (released > 0)
				console.log(
					`[shipment-clock] job ${job.id}: ${released} abandoned order(s) returned stock`,
				);
		}
	});

	// The storage meter: quiet when nothing is stored (returns 0), a written count otherwise
	// — the same posture every other sweep's worker logs with.
	await queue.work(QUEUES.STORAGE_USAGE, async (jobs) => {
		for (const job of jobs) {
			const written = await runStorageUsageSweep();
			if (written > 0)
				console.log(`[storage-usage] job ${job.id}: ${written} account(s) snapshotted`);
		}
	});

	// The withdrawn-Work sweep: removes the media of a withdrawn Work nobody saved, and
	// spares every Work the preservation program holds. Logged only when nonzero.
	await queue.work(QUEUES.WITHDRAWN_SWEEP, async (jobs) => {
		for (const job of jobs) {
			const { sweptCount, keptCount } = await runWithdrawnSweep();
			if (sweptCount > 0 || keptCount > 0) {
				console.log(`[withdrawn-sweep] job ${job.id}: swept ${sweptCount}, held ${keptCount}`);
			}
		}
	});

	await queue.work(QUEUES.HLS_ORPHAN_SWEEP, async (jobs) => {
		for (const job of jobs) {
			const sweptCount = await runHlsOrphanSweep();
			if (sweptCount > 0) {
				console.log(`[hls-orphan-sweep] job ${job.id}: swept ${sweptCount} orphaned prefixes`);
			}
		}
	});

	await queue.work(QUEUES.UPLOAD_SESSION_SWEEP, async (jobs) => {
		for (const job of jobs) {
			const sweptCount = await runUploadSessionSweep();
			if (sweptCount > 0) {
				console.log(`[upload-session-sweep] job ${job.id}: aborted ${sweptCount} open sessions`);
			}
		}
	});

	await queue.work(QUEUES.PURCHASE_TRANSFER_RETRY, async (jobs) => {
		for (const job of jobs) {
			const attempted = await runPurchaseTransferRetry();
			if (attempted > 0) {
				console.log(
					`[purchase-transfer-retry] job ${job.id}: re-attempted ${attempted} owed transfer group(s)`,
				);
			}
		}
	});

	await queue.work(QUEUES.RUN_DELETIONS, async (jobs) => {
		for (const job of jobs) {
			console.log(`[run-deletions] Processing job ${job.id}`);
			await runDueDeletions();
		}
	});

	await queue.work(QUEUES.LIFT_SUSPENSIONS, async (jobs) => {
		for (const job of jobs) {
			const lifted = await liftExpiredSuspensions();
			const told = await notifySupportersOfSuspensions();
			if (lifted > 0 || told > 0)
				console.log(`[lift-suspensions] job ${job.id}: lifted ${lifted}, supporters told ${told}`);
		}
	});

	await queue.work(QUEUES.RELEASE_PAYOUT_HOLDS, async (jobs) => {
		for (const job of jobs) {
			const released = await releaseStalePayoutHolds();
			if (released > 0) console.log(`[release-payout-holds] job ${job.id}: released ${released}`);
		}
	});

	await queue.work(QUEUES.PRUNE_CREDENTIALS, async (jobs) => {
		for (const job of jobs) {
			const [
				sessionsGone,
				codesGone,
				adminSessionsGone,
				adminCodesGone,
				challengesGone,
				limitsGone,
			] = await Promise.all([
				deleteExpiredSessions(),
				deleteExpiredSignupCodes(),
				deleteExpiredAdminSessions(),
				deleteExpiredAdminSignInCodes(),
				sweepSignupChallenges(),
				sweepRateLimits(),
			]);
			if (
				sessionsGone +
					codesGone +
					adminSessionsGone +
					adminCodesGone +
					challengesGone +
					limitsGone >
				0
			) {
				console.log(
					`[prune-credentials] job ${job.id}: removed ${sessionsGone} expired session(s), ${codesGone} expired signup code(s), ${adminSessionsGone} expired admin session(s), ${adminCodesGone} expired admin sign-in code(s), ${challengesGone} spent or expired signup challenge(s), ${limitsGone} spent rate-limit window(s)`,
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

	await queue.work<PruneTrafficData>(QUEUES.PRUNE_TRAFFIC, async (jobs) => {
		for (const job of jobs) {
			console.log(`[prune-traffic] Processing job ${job.id}`);
			await handlePruneTraffic(job.data ?? {});
		}
	});

	await queue.work(QUEUES.PUBLISH_SCHEDULED, async (jobs) => {
		for (const job of jobs) {
			const n = await publishScheduled();
			if (n > 0) console.log(`[publish-scheduled] job ${job.id}: published ${n} scheduled post(s)`);
		}
	});

	await queue.work(QUEUES.RELEASE_SCHEDULED, async (jobs) => {
		for (const job of jobs) {
			const { released, cleared } = await releaseScheduled();
			if (released > 0 || cleared > 0) {
				console.log(
					`[release-scheduled] job ${job.id}: released ${released}, cleared ${cleared} schedule(s)`,
				);
			}
		}
	});

	await queue.work(QUEUES.DMCA_RESTORE, async (jobs) => {
		for (const job of jobs) {
			// Copies first: a restore waits for the complainant's copy, so one that goes out now has to
			// be on the notice before today's restores are chosen.
			const copies = await retryUnsentCounterNotices();
			if (copies.forwarded + copies.stillUnsent > 0) {
				console.log(
					`[dmca-restore] job ${job.id}: counter-notice copies sent ${copies.forwarded}, still unsent ${copies.stillUnsent}, alerted ${copies.alerted}`,
				);
			}
			const ready = await noticesReadyForRestore();
			for (const notice of ready) {
				const result = await restoreWork({ noticeId: notice.noticeId });
				if (result && typeof result === "object" && !isNoticeStatusRefusal(result)) {
					console.log(
						`[dmca-restore] job ${job.id}: restored work ${notice.workId} (notice #${notice.noticeId})`,
					);
				} else if (result) {
					// A refusal is not a restore. The sweep selects only notices it may restore, so this
					// means the notice changed between the select and the restore.
					console.warn(
						`[dmca-restore] job ${job.id}: did not restore notice #${notice.noticeId}: ${JSON.stringify(result)}`,
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

	// Retry legal-report alerts that never went out. Logs only when it actually sent
	// something — a five-minute "0 pending" line would bury everything else in the
	// worker log within a day, and this is a log somebody has to be able to read.
	await queue.work(QUEUES.ESCALATE_REPORTS, async (jobs) => {
		for (const job of jobs) {
			// Both intakes, one sweep. In-app reports and public no-account reports live in
			// separate tables for the reasons the child-safety coverage map, which is deliberately not public gives, but they owe the same alert to
			// the same mailbox against the same statutory "as soon as reasonably possible"
			// — so a second cron would be a second thing to notice had stopped running.
			const sent = await runEscalationSweep();
			const sentPublic = await runAbuseEscalationSweep();
			if (sent > 0 || sentPublic > 0) {
				console.log(
					`[escalate-reports] job ${job.id}: escalated ${sent} legal report(s) and ${sentPublic} public report(s)`,
				);
			}
		}
	});

	// Re-ask about objects whose scan never came back. Quiet when there is nothing owed,
	// for the same reason the escalation sweep is: an hourly "0 owed" line makes the worker
	// log unreadable, and this one has to stay readable.
	// Watch the identity documents of accounts Anthers hosts. Quiet on a clean sweep, for
	// the same reason the escalation sweep is: an hourly "0 changed" line makes the worker
	// log unreadable, and this is a log somebody has to be able to read on the day it says
	// something. A sweep that alerts always logs.
	await queue.work(QUEUES.WATCH_IDENTITIES, async (jobs) => {
		for (const job of jobs) {
			const { checked, alerts, findings } = await watchHostedIdentities();
			const recorded = findings.filter((f) => f.kind === "first-seen").length;
			// ⚠️ **A clean sweep is silent, and that was very nearly the whole problem.** This
			// job exists so that silence about an identity means something, and a job whose
			// success and whose total failure both log nothing cannot deliver that — after the
			// first deploy there was no way to tell "watching, nothing moved" from "never ran".
			// A first sighting is rare and is the one moment worth a line: it says the sweep
			// reached both the server and the directory, and names what it will watch from now
			// on. Steady state stays quiet on purpose.
			if (alerts > 0 || recorded > 0) {
				console.log(
					`[watch-identities] job ${job.id}: ${alerts} ALERT(S), ${recorded} newly watched, ` +
						`${checked} identity(ies) checked`,
				);
			}
		}
	});

	// The connection census: one email a day at most when the cluster nears exhaustion or
	// refuses to be read, and nothing at all when it is healthy — silence is the signal that
	// the watch is on and untroubled, and the sweep's own module docblock carries the two
	// incidents that bought it. The handler logs only when the sweep alerted.
	await queue.work(QUEUES.CONNECTION_CENSUS, async (jobs) => {
		for (const job of jobs) {
			const result = await runConnectionCensus();
			if (result.alerted) {
				console.log(
					`[connection-census] job ${job.id}: alerted (${result.used} of ${result.usable} usable in use${result.error ? `; read failed: ${result.error}` : ""})`,
				);
			}
		}
	});

	await queue.work(QUEUES.RESCAN_OWED, async (jobs) => {
		for (const job of jobs) {
			const sent = await rescanOwed();
			if (sent > 0) console.log(`[rescan-owed] job ${job.id}: re-queued ${sent} scan(s)`);
		}
	});

	// The status sampler: one composed answer per pass, into the record the public page's
	// bars and Past Incidents render from. Always quiet in the log — a pass that stores
	// only tallies has nothing a person would read, and the record's own gaps do the
	// talking (an unrecorded day renders as an empty cell, never as all-clear).
	await queue.work(QUEUES.STATUS_SAMPLE, async (jobs) => {
		for (const _job of jobs) {
			await statusSample();
		}
	});

	// Email the operator when a deadline arrives and before it is due. Quiet when everything
	// was already sent, for the same reason the other sweeps are quiet: a daily "0 reminders"
	// line makes the worker log unreadable, and the one log that must stay readable is the one
	// a person reads to find out what they owe.
	await queue.work(QUEUES.DEADLINE_REMINDERS, async (jobs) => {
		for (const job of jobs) {
			const { sent, skipped, refused } = await runDeadlineReminderSweep();
			if (refused) {
				console.warn(`[deadline-reminders] job ${job.id}: ${refused}`);
			} else if (sent + skipped > 0) {
				console.log(`[deadline-reminders] job ${job.id}: sent ${sent}, already sent ${skipped}`);
			}
		}
	});

	// The queue's own failures, read from pgboss every five minutes. Its alarm is the one the
	// 2026-10-19 incident did not have; it records to the error tracker and never re-runs a
	// job. A quiet run logs nothing.
	await queue.work(QUEUES.QUEUE_FAILURES, async (jobs) => {
		for (const job of jobs) {
			const { ok, alarming, sent, error } = await runQueueFailureReport();
			if (!ok && error) {
				console.error(`[queue-failures] job ${job.id}: ${error}`);
			} else if (sent > 0) {
				console.log(`[queue-failures] job ${job.id}: alerted on ${alarming.length} queue(s)`);
			}
		}
	});

	// ── Cron schedules ────────────────────────────────────────────────

	for (const [queueName, cron] of CRON_SCHEDULES) {
		await queue.schedule(queueName, cron, {});
	}
	// A queue being retired may still hold waiting jobs — `media`'s retirement on
	// 2026-10-18 had a real pending row in it (a creator's audio waiting on a lane this
	// deployment no longer drains). A plain retire deletes those jobs with the queue and
	// the row waits forever on nothing, so each job on a reschedule queue is re-sent to
	// its replacement — routed by the row's own `mediaType`, the one map any queue move
	// resolves through (`QUEUE_BY_MEDIA_TYPE`). The running row is not here: an active
	// job is not `queued`, and the interrupted-graceful path below resumes it.
	for (const retiredName of RESCHEDULE_ON_RETIRE) {
		if (!RETIRED_QUEUES.includes(retiredName)) continue;
		try {
			const stranded = await queue.findQueuedJobs<{ jobId: number }>(retiredName);
			for (const job of stranded) {
				const [row] = await db
					.select({ mediaType: workTranscodingJobs.mediaType })
					.from(workTranscodingJobs)
					.where(eq(workTranscodingJobs.id, job.data.jobId))
					.limit(1);
				const target = row ? QUEUE_BY_MEDIA_TYPE[row.mediaType] : undefined;
				if (!target) {
					console.warn(
						`[worker] stranded job ${job.id} on ${retiredName}: no queue for media type "${row?.mediaType}"`,
					);
					continue;
				}
				await queue.send(target, job.data, JOB_OPTIONS[target]);
				await queue.deleteQueuedJob(retiredName, job.id);
				console.log(`[worker] rescheduled ${retiredName} job ${job.id} onto ${target}`);
			}
		} catch (err) {
			console.error(`[worker] reschedule of ${retiredName} failed (non-fatal):`, err);
		}
	}
	for (const retired of RETIRED_QUEUES) await queue.retire(retired);

	// Recover any transcodes interrupted by the previous worker's stop — rows the stop
	// marked benign (a SIGTERM, i.e. a deploy bounce) resume without spending a ceiling
	// slot, unmarked rows charge as crashes, and queued jobs whose row has vanished are
	// retired (see the sweep's docblock). Best-effort: recovery must never crash the
	// worker, so failures are logged, not thrown (a stuck job still self-heals via
	// pg-boss's retry-on-expiry, heartbeat-failure detection now covering the fast case).
	try {
		await resumeOrphanedTranscodes();
	} catch (err) {
		console.error("Failed to resume orphaned transcodes (non-fatal):", err);
	}

	// The same question, for a worker that was already serving when the migration ran. It stops
	// the queue rather than exiting: the replacement arrives in a minute or two, and an exit
	// would be answered by a restart loop.
	watchSchema({
		onBehind: async () => {
			await queue.stop({ graceful: true, timeout: 120_000 });
		},
	});

	console.log("Worker ready. Listening for jobs...");
	console.log(
		// ⚠️ **Derived from CRON_SCHEDULES rather than typed.** This line named five crons
		// while fourteen were registered — a hand-maintained list beside the data it
		// describes, which is the same drift a schema annotation pass had and for the same
		// reason. It matters more than a log line usually would: this banner is how somebody
		// confirms a cron is actually scheduled after a deploy, so a stale one answers that
		// question wrongly.
		`Scheduled ${CRON_SCHEDULES.length}: ${CRON_SCHEDULES.map(([q]) => q).join(", ")}`,
	);
}

// ── Graceful shutdown ──────────────────────────────────────────────────

/**
 * Hold a stood-down worker open until the platform replaces it.
 *
 * An unresolved promise alone lets the event loop drain, so the process would exit and be
 * restarted into the same stand-down: a restart loop the `RESTART_COUNT` alert exists to
 * catch, and one that answers nothing. A long timer is what keeps it alive while it does no
 * work at all.
 */
async function holdForReplacement(): Promise<never> {
	setInterval(() => {}, 60 * 60 * 1000);
	return new Promise<never>(() => {});
}

async function shutdown() {
	console.log("Shutting down worker...");
	// 🚨 Mark the rows this worker leaves behind BEFORE anything else: this write is what
	// tells the next boot's recovery sweep that the stop was DELIBERATE (SIGTERM — the
	// shape of every deploy bounce) rather than a crash, so the row is resumed without
	// spending one of its crash resumes. Going first means the flag is down even when
	// the platform's kill outlives the graceful stop below — a hard kill racing this
	// write is exactly the case the marker exists to settle, and a missed write only
	// costs a resume slot, never correctness. Best-effort: a failed write must not stop
	// the stop, and its cost is the same slot.
	try {
		await markBenignInterrupted();
	} catch (err) {
		console.error("Failed to mark benign interruptions (non-fatal):", err);
	}
	await queue.stop({ graceful: true, timeout: 30000 });
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
	console.error("Worker failed to start:", err);
	process.exit(1);
});

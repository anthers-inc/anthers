// SPDX-License-Identifier: Apache-2.0
/**
 * pg-boss-backed job queue with cron scheduling.
 *
 * Exposes the small subset the app uses — send / work / schedule / start /
 * stop — behind the same interface the previous SQLite queue presented, so
 * call sites are unchanged. pg-boss manages its own tables in the `pgboss`
 * schema of the app's Postgres database (created/migrated on start), and
 * handles cron firing + multi-instance dedup natively, retiring the old
 * croner + cron_locks machinery.
 *
 * Hub-only: the future creator-node role keeps an in-process SQLite queue.
 *
 * pg-boss's own `localConcurrency` work option maps exactly to the prior
 * queue's semantics: N independent per-node workers, each fetching one job
 * at a time (batchSize defaults to 1), so a thrown handler fails only that
 * one job — the "no batch-failure footgun" property is preserved.
 */

import { PgBoss } from "pg-boss";
import { isConnectionExhaustionError, reportConnectionAlarm } from "./connection-census.js";

const CONNECTION = process.env.DATABASE_URL ?? "postgres://anthers:anthers@localhost:5432/anthers";

// pg-boss connects via node-postgres, which — unlike the app's postgres-js
// client — rejects DigitalOcean Managed Postgres's self-signed CA cert
// (SELF_SIGNED_CERT_IN_CHAIN). Passing ssl alongside a connectionString doesn't
// help: node-postgres derives rejectUnauthorized:true from the DSN's
// sslmode=require and it wins. So for SSL connections we hand pg-boss discrete
// params (no connectionString → no sslmode parsing) with an explicit ssl config
// that skips CA verification (same posture as postgres-js under sslmode=require).
// Local dev has no sslmode, so it connects plaintext with the bare string.
const DB_REQUIRES_SSL = /[?&]sslmode=/.test(CONNECTION) || /\.ondigitalocean\.com/.test(CONNECTION);

function sslBossOptions(dsn: string) {
	const u = new URL(dsn);
	return {
		host: u.hostname,
		port: u.port ? Number(u.port) : 5432,
		database: u.pathname.replace(/^\//, ""),
		user: decodeURIComponent(u.username),
		password: decodeURIComponent(u.password),
		ssl: { rejectUnauthorized: false },
		// Small pool — the managed cluster's max_connections is low (~25) and both
		// api and worker run a pg-boss pool; a large default would exhaust it on a
		// rolling deploy (old + new instances overlap).
		max: 3,
	};
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SendOptions {
	retryLimit?: number;
	retryDelay?: number; // seconds, flat
	expireInMinutes?: number;
	/** Expected heartbeat interval in seconds. When set, pg-boss's worker refreshes
	 * the job's heartbeat while its handler runs, and pg-boss's maintenance fails a
	 * job whose heartbeats stopped — the fast "worker died mid-job" detection that
	 * makes a long expireInMinutes safe. Must be ≥ 10 when set. */
	heartbeatSeconds?: number;
	startAfter?: number; // ms epoch
}

export interface WorkOptions {
	localConcurrency?: number;
	pollIntervalMs?: number;
}

export interface Job<T> {
	id: string;
	data: T;
}

export type Handler<T> = (jobs: Job<T>[]) => Promise<void> | void;

export function toBossSendOptions(options?: SendOptions): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (options?.retryLimit !== undefined) out.retryLimit = options.retryLimit;
	if (options?.retryDelay !== undefined) out.retryDelay = options.retryDelay;
	if (options?.expireInMinutes !== undefined) out.expireInSeconds = options.expireInMinutes * 60;
	if (options?.heartbeatSeconds !== undefined) out.heartbeatSeconds = options.heartbeatSeconds;
	if (options?.startAfter !== undefined) out.startAfter = new Date(options.startAfter);
	return out;
}

// ── Queue implementation ─────────────────────────────────────────────────────

class JobQueue {
	private boss: PgBoss;
	private started = false;

	constructor() {
		this.boss = DB_REQUIRES_SSL
			? new PgBoss(sslBossOptions(CONNECTION))
			: new PgBoss({ connectionString: CONNECTION, max: 3 });
		// pg-boss surfaces background failures via the error event; without a
		// listener these would become unhandled 'error' emissions.
		this.boss.on("error", (err) => {
			// A poll or fetch that failed on connection exhaustion is the 10-10 stall's own
			// shape, and the census alarm — not a console line nobody watches — is what that
			// failure owes the operator. Same one-per-day budget as the sweep; never awaited,
			// because the listener is a synchronous event callback.
			if (isConnectionExhaustionError(err)) {
				void reportConnectionAlarm(err).catch((alarmErr) =>
					console.error("[queue] connection alarm failed:", alarmErr),
				);
				return;
			}
			console.error("[queue] pg-boss error:", err);
		});
	}

	async start(): Promise<void> {
		await this.boss.start();
		// createQueue is idempotent (INSERT ... ON CONFLICT DO NOTHING); a queue
		// must exist before send/work/schedule can target it.
		for (const name of Object.values(QUEUES)) {
			await this.boss.createQueue(name);
		}
		this.started = true;
	}

	send<T>(queue: string, data: T, options?: SendOptions): Promise<string | null> {
		return this.boss.send(queue, (data ?? {}) as object, toBossSendOptions(options));
	}

	async work<T>(
		queue: string,
		optionsOrHandler: WorkOptions | Handler<T>,
		maybeHandler?: Handler<T>,
	): Promise<void> {
		const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
		const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
		if (!handler) throw new Error(`work(${queue}): missing handler`);

		await this.boss.work<T>(
			queue,
			{
				// batchSize defaults to 1 — one job per handler invocation.
				localConcurrency: options.localConcurrency ?? 1,
				pollingIntervalSeconds: options.pollIntervalMs ? options.pollIntervalMs / 1000 : 2,
			},
			async (jobs) => {
				await handler(jobs.map((j) => ({ id: j.id, data: j.data })));
			},
		);
	}

	async schedule(queue: string, cronExpr: string, data: object = {}): Promise<void> {
		await this.boss.schedule(queue, cronExpr, data);
	}

	/**
	 * Stop a queue this code no longer runs: its schedule, any jobs waiting in it, and the queue.
	 *
	 * Each step is allowed to find nothing, because on every boot after the first there is
	 * nothing left to find.
	 */
	async retire(queue: string): Promise<void> {
		for (const step of [() => this.boss.unschedule(queue), () => this.boss.deleteQueue(queue)]) {
			try {
				await step();
			} catch (err) {
				console.warn(`[queue] retiring ${queue}: ${err instanceof Error ? err.message : err}`);
			}
		}
	}

	async stop(opts?: { graceful?: boolean; timeout?: number }): Promise<void> {
		await this.boss.stop({ graceful: opts?.graceful ?? true, timeout: opts?.timeout });
		this.started = false;
	}

	/** Every queued (`created`/`retry`-state) job in a queue, with its payload. */
	findQueuedJobs<T>(queue: string): Promise<{ id: string; data: T }[]> {
		return this.boss.findJobs<T>(queue, { queued: true });
	}

	/** Delete one job from a queue — the retirement a stranded job gets. */
	async deleteQueuedJob(queue: string, id: string): Promise<void> {
		await this.boss.deleteJob(queue, id);
	}

	get isStarted(): boolean {
		return this.started;
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const queue = new JobQueue();

let starting: Promise<void> | null = null;
export async function ensureQueueReady(): Promise<void> {
	if (queue.isStarted) return;
	if (!starting) starting = queue.start();
	return starting;
}

// ── Queue name constants ─────────────────────────────────────────────────────

export const QUEUES = {
	// The single-file media lane: one queue carrying every video transcode and audio
	// process, worked at `localConcurrency: 1`, because an encode saturates the worker's
	// plan (six pinned ffmpeg threads outpaced two vCPUs through a whole burst on
	// 2026-10-17 with every figure on screen drifting outside its measured band) and a
	// second concurrent encode finished no sooner, it only doubled the peak. The job
	// carries a `jobId` alone; the handler re-reads the row and dispatches on its
	// `mediaType`, so adding a media type is a row in the handler's map, not a queue.
	// The old per-type names are on `RETIRED_QUEUES`, retired on 2026-10-17.
	MEDIA: "media",
	RENDER_PAGED: "render-paged", // Render a paged Work's source set (PDFs and page images) to private per-page images
	// Extract a reflow ebook Work's EPUB source set into private chapters and their
	// referenced assets (`work_sections` + `work_section_assets`), one row per component
	// in reading order. Separate queue from RENDER_PAGED because the design keeps the two
	// shapes apart (the reader picks by what the ingest produced) and because a job that
	// unzips is not a job that rasterizes. See ingest-ebook.ts.
	INGEST_EBOOK: "ingest-ebook",
	DISTRIBUTE_POOL: "distribute-pool",
	SETTLE_CYCLE: "settle-cycle", // Credit each ended month from its paid invoices; see settle-cycle.ts
	// Move settled, held credits into each creator's connected-account balance, 14 days
	// after each credit's own settlement. See transfer-held-credits.ts.
	TRANSFER_HELD_CREDITS: "transfer-held-credits",
	CALCULATE_CRF: "calculate-crf", // Legacy name; calculates hosting subsidy allocations
	// The storage ladder's meter — snapshot what each account holds against its allowance.
	// See storage-usage.ts for the DB-first counting rule and the per-purpose split.
	STORAGE_USAGE: "storage-usage",
	// The claim-aware rescue sweep — a withdrawn Work's media leaves when no claim
	// remains: no keeper, and every buyer past the ninety days. See withdrawn-sweep.ts.
	WITHDRAWN_SWEEP: "withdrawn-sweep",
	// Write, replace or remove a Work's public listing on the AT Protocol network. Carries only
	// a Work id: the handler re-reads the Work and decides from its current state, so a
	// duplicate is harmless and a late one still converges. Deliberately not part of the release
	// request — a record is a call to another server, and a creator's publishing must not fail
	// because that server is down.
	SYNC_WORK_LISTING: "sync-work-listing",
	// Write, replace or remove the record for one row: a creator's post or project, or a user's
	// comment, review, vote or follow. Carries a kind and an id and nothing else, for the same
	// reason the queue above carries only a Work id: the handler re-reads the row and decides from
	// its current state.
	SYNC_ATPROTO_RECORD: "sync-atproto-record",
	// Take a record off the network when the row that described it has been deleted outright.
	//
	// 🚨 **The one queue here whose payload is a DESCRIPTION rather than a hint**, and it has to
	// be. A deleted post, project or comment has no row left to re-read, so the address has to be
	// captured before the delete or the record stays up for ever describing something gone.
	REMOVE_ATPROTO_RECORD: "remove-atproto-record",
	// The backstop for the three queues above. Per-event enqueues are the latency; this is the
	// guarantee, because an enqueue that failed, a job that exhausted its retries, and a state
	// changed directly in SQL all leave a record disagreeing with its row and nothing noticing.
	RECONCILE_LISTINGS: "reconcile-listings",
	PUBLISH_SCHEDULED: "publish-scheduled", // Auto-publish drafts whose scheduledFor has arrived
	// Release private Works whose scheduled release time has come, once they are ready.
	RELEASE_SCHEDULED: "release-scheduled",
	// Hash a stored object and ask a detection vendor about the hash. Keyed on the storage
	// key rather than the Work, because that is the only identifier both upload paths share:
	// the presigned PUT never passes the bytes through the API, so the object exists in R2
	// before anything here knows about it. See the child-safety coverage map, which is deliberately not public.
	SCAN_MEDIA: "scan-media",
	// Re-ask for the objects whose scan never came back. `SCAN_MEDIA` gives up after its
	// retry budget, and release gives way after two minutes, so between them an object
	// caught by a vendor outage would otherwise never be scanned again — which would make
	// the release gate a formality rather than a gate. See `worksOwedScans`.
	RESCAN_OWED: "rescan-owed",
	PRUNE_ATTENTION: "prune-attention", // Roll raw attention into daily totals, then delete it
	PRUNE_TRAFFIC: "prune-traffic", // Roll raw traffic into daily totals, then delete it
	RUN_DELETIONS: "run-deletions", // Erase accounts whose deletion grace period has elapsed
	// Lift suspensions whose `suspended_until` has passed. Each lift is its own
	// transaction and its own `moderation_actions` row with both actor columns null,
	// so the log records "the clock lifted this" exactly as it records an operator's lift.
	// The same run also tells each supporter of a suspended creator that their renewal
	// is paused — a billing notice whose dedupe makes the re-run harmless.
	LIFT_SUSPENSIONS: "lift-suspensions",
	// Release suspension payout holds whose review window lapsed with no finding
	// recorded. The window is `PAYOUT_REVIEW_WINDOW_DAYS` from the suspension, and
	// "absence of a finding by the deadline" IS the default outcome — so this sweep
	// is the release mechanism rather than a reminder for one.
	RELEASE_PAYOUT_HOLDS: "release-payout-holds",
	// Delete expired sessions, signup codes and admin credentials. Privacy Policy promises
	// "Sessions: deleted when they expire"; until 2026-08-12 `deleteExpiredSessions()` was
	// exported and called from NOWHERE, so every session row ever written — with its
	// `ip_address` and `user_agent` — was filtered out of reads and kept forever. A
	// retention promise with no mechanism behind it.
	PRUNE_CREDENTIALS: "prune-credentials",
	// Restore Works whose DMCA counter-notice window has closed (§ 512(g)(2)(C)).
	// The sweep checks `restoreNoEarlierThan` and `suitFiledAt` — a suit filing
	// prevents the restore. Runs daily; the window is 10 business days, so the
	// latency is negligible.
	DMCA_RESTORE: "dmca-restore",
	// Settle takedowns that have become final: refund every buyer of the Work.
	//
	// 🚨 A SEPARATE queue from DMCA_RESTORE on purpose, and the reason is failure
	// isolation rather than tidiness. Restoring is the statutory obligation and
	// touches only our own database; refunding is our promise and reaches Stripe.
	// Sharing a handler would let a Stripe outage stop restores from happening —
	// spending the safe harbor to protect the money, which is exactly backwards.
	DMCA_FINALIZE: "dmca-finalize",
	// Age the personal detail out of settled safety and copyright records. Blanks
	// contact fields in place after RECORD_REDACTION_YEARS; never deletes a row,
	// because § 512(i) needs the pattern and an appeal needs the decision. See
	// `services/retention.ts`.
	REDACT_RECORDS: "redact-records",
	// Retry floor-level reports (`illegal`, `sexual`, `violence`) that were filed but
	// whose out-of-band alert never went out — a Resend outage, a transient error, a
	// deploy mid-request. `fileReport` sends inline and stamps `escalated_at` on
	// success; this re-selects whatever is still null.
	//
	// 🚨 It runs every FIVE MINUTES rather than nightly, and that is the whole point of
	// having it. The others in this list age data or settle money, where a day's
	// latency is invisible; this one is the path by which Anthers learns it is hosting
	// something illegal, and 18 U.S.C. § 2258A asks for a report "as soon as reasonably
	// possible" after actual knowledge. A retry that waits until 3 AM is a retry that
	// has already spent most of the tolerance.
	ESCALATE_REPORTS: "escalate-reports",
	// Read the public identity document of every account Anthers hosts and shout when one
	// moves.
	//
	// 🚨 It runs HOURLY rather than nightly, and the cadence is the feature. A rotation key
	// ranked above the one that signed a hostile operation can undo it, but only within 72
	// hours — so the remedy expires on a clock nobody is watching, and a nightly check
	// spends a third of the tolerance before anyone is told. Hourly leaves seventy-odd
	// chances to notice.
	//
	// ⭐ It is in the HUB's worker rather than beside the server it watches, which is the
	// only arrangement where the alarm survives the compromise it describes.
	WATCH_IDENTITIES: "watch-identities",
	// Email the operator when a deadline item arrives and again before it is due — the worker
	// half of the 2026-09-14 decision. Deduped per item+kind through `deadline_reminders`, so
	// a daily re-gather of the same rows never mails twice.
	DEADLINE_REMINDERS: "deadline-reminders",
	// Take back the video HLS run prefixes no transcode row points at — the partial
	// ladders of encodes that died mid-job, since 2026-10-10's per-variant restructure
	// gives every retry its own prefix. Enumeration from storage, references from rows;
	// see hls-orphan-sweep.ts for the cadence, media-purge.ts for the rules.
	HLS_ORPHAN_SWEEP: "hls-orphan-sweep",
	// Abort upload sessions abandoned past `SESSION_CLEANUP_DAYS`: the network bills
	// incomplete multipart uploads while they are held, so an abandoned session is a
	// meter running rather than idle bytes. See upload-session-sweep.ts.
	UPLOAD_SESSION_SWEEP: "upload-session-sweep",
	// Re-attempt the creator shares a purchase's completion could not transfer — the
	// rows stay `stripe_transfer_id`-null and this sweep re-runs them through the same
	// idempotency key, so the money an outage delayed is money still owed rather than
	// money lost. See purchase-transfer-retry.ts and services/purchase-split.ts.
	// The connection census — the standing check the 2026-10-10 burst stall bought. The
	// sweep is the watch: quiet when the cluster is inside its budget (it sits near 8 of
	// 22 at rest), one email a day at most when the usable slots are nearly gone or the
	// cluster refuses to be read at all, and the boss error listener raises the same
	// alarm when a poll or fetch hits the exhaustion shape itself. See
	// `connection-census.ts` for why the dedupe is in memory rather than in a table.
	CONNECTION_CENSUS: "connection-census",
	PURCHASE_TRANSFER_RETRY: "purchase-transfer-retry",
	// Sample every component of the composed public status answer into the recorded
	// history — the day tallies behind the status page's uptime bars and the transitions
	// behind its Past Incidents. See status-sample.ts and services/status-history.ts,
	// the tables' only writer.
	STATUS_SAMPLE: "status-sample",
} as const;

export const JOB_OPTIONS: Record<string, SendOptions> = {
	// 🚨 **expireInMinutes is the handler's runtime cap, not a liveness window** — pg-boss
	// (v12) treats a job that runs this long as expired: the supervisor re-delivers it and
	// the worker races the handler against the same limit, and NOTHING kills the
	// abandoned handler or its ffmpeg child, so an encode that outlives the window
	// double-runs (measured 2026-10-11: one 4K-adjacent source re-encoded in full, twice,
	// because expireInMinutes was 45 and the encode took 54 min). The cap therefore has
	// to exceed the worst encode the ladder allows, and the ladder has no duration cap —
	// sources are bounded only by multipart upload size. Sizing: 12 h, roughly 20× the
	// one measured long encode. The recovery a long window does not provide — a worker
	// that DIED mid-encode — is the heartbeat's, which catches it in minutes instead of
	// the window's full length; the heartbeat does not extend expiry (pg-boss still
	// expires on started_on), it only fails a job whose worker stopped refreshing it.
	// A stalled encode self-fails regardless of the window at its pass's SOURCE_URL_TTL,
	// when ffmpeg's ranged reads outrun the signed address.
	// The lock in the handler (`withTranscodeLock`) is the floor under sizing mistakes:
	// a re-delivery waits there instead of encoding beside the first handler.
	[QUEUES.MEDIA]: {
		// The merged shape of the transcode-video and process-audio budgets (retired
		// 2026-10-17 with the queue itself): the video expiry sized to exceed the worst
		// ladder the ladder allows, shared here because a queue's budget is one row and
		// audio rides the generous side rather than a second set of figures — 12 hours on
		// a job whose passes take minutes is inert. pg-boss expires a job on started_on,
		// so queue wait does not count; the heartbeat fails a worker that died mid-job
		// in minutes either way. The lock in the handlers is the floor under sizing
		// mistakes: a re-delivery waits there instead of encoding beside the first.
		retryLimit: 2,
		retryDelay: 60,
		expireInMinutes: 12 * 60,
		heartbeatSeconds: 120,
	},
	[QUEUES.RENDER_PAGED]: {
		retryLimit: 2,
		retryDelay: 60,
		// A long graphic novel is one poppler pass plus an upload per page; generous for
		// the same reason video is, and bounded by MAX_PAGES in the job itself.
		expireInMinutes: 30,
	},
	// An EPUB extract is a decompress and one upload per component — the same budget as the
	// paged render, generous for the same reason, and bounded by the extraction caps in
	// the job itself.
	[QUEUES.INGEST_EBOOK]: {
		retryLimit: 2,
		retryDelay: 60,
		expireInMinutes: 30,
	},
	[QUEUES.SCAN_MEDIA]: {
		// Retried generously and slowly on purpose. A vendor outage must leave the object
		// UNSCANNED and owed rather than recorded as clean, so the job failing and coming
		// back later is the correct behavior rather than a nuisance to be tuned away.
		retryLimit: 5,
		retryDelay: 300,
		expireInMinutes: 10,
	},
	// ⚠️ **Retried generously and for a long time, because the delete path is the one that
	// matters.** A create that never lands is a listing nobody has; a delete that never lands
	// is a listing advertising something its creator withdrew, which is the failure this whole
	// design is shaped around. The work is one small write, so retrying costs nothing.
	[QUEUES.SYNC_WORK_LISTING]: {
		retryLimit: 8,
		retryDelay: 60,
		expireInMinutes: 10,
	},
	// The same budget as a Work's listing, for the same reason: one small write, and a delete
	// that never lands is a record advertising something its owner took down.
	[QUEUES.SYNC_ATPROTO_RECORD]: {
		retryLimit: 8,
		retryDelay: 60,
		expireInMinutes: 10,
	},
	// ⚠️ **The most generous budget of the three, because nothing else will ever catch this
	// one.** A sync that never runs is found again by the reconciling sweep, which re-reads the
	// row and re-decides; this job's row is gone, so the sweep has nothing to find it by. If the
	// retries run out the record stays on the network permanently.
	[QUEUES.REMOVE_ATPROTO_RECORD]: {
		retryLimit: 12,
		retryDelay: 120,
		expireInMinutes: 10,
	},
	[QUEUES.DISTRIBUTE_POOL]: {
		retryLimit: 1,
		expireInMinutes: 30,
	},
	// ⚠️ **One retry, deliberately, and the idempotency key is why it is safe at all.** A
	// Stripe-success/DB-failure crash replays the same deterministic idempotency key on
	// the retry, so Stripe hands back the original transfer instead of making a second
	// one — see the job's docblock. More retries would not be safer: the money moves once
	// however many times the job runs.
	[QUEUES.TRANSFER_HELD_CREDITS]: {
		retryLimit: 1,
		expireInMinutes: 30,
	},
	[QUEUES.RUN_DELETIONS]: {
		// Each account is its own transaction, so a retry re-selects only what is still
		// pending and cannot half-erase anyone.
		retryLimit: 2,
		expireInMinutes: 30,
	},
	[QUEUES.PRUNE_ATTENTION]: {
		// Safe to retry: each day is aggregated and deleted in one transaction, and the
		// rollup upsert re-derives totals rather than adding to them.
		retryLimit: 2,
		expireInMinutes: 30,
	},
	[QUEUES.PRUNE_TRAFFIC]: {
		// Same safety story as PRUNE_ATTENTION: per-day transactions, overwriting upserts.
		retryLimit: 2,
		expireInMinutes: 30,
	},
	[QUEUES.CALCULATE_CRF]: {
		retryLimit: 1,
		expireInMinutes: 30,
	},
	[QUEUES.STORAGE_USAGE]: {
		// Idempotent upsert per cycle — a retry rewrites the same row, never duplicates.
		retryLimit: 1,
		expireInMinutes: 30,
	},
	[QUEUES.WITHDRAWN_SWEEP]: {
		// Best-effort purge, marked done per Work — a retry sweeps already-swept Works
		// as no-ops and re-sends nothing (the warning dedupes by key).
		retryLimit: 2,
		retryDelay: 300,
		expireInMinutes: 30,
	},
	[QUEUES.HLS_ORPHAN_SWEEP]: {
		// A prefix-deleting sweep retried like any purge: idempotent (a swept prefix
		// is gone), and a second delete of an empty prefix is a no-op.
		retryLimit: 2,
		retryDelay: 300,
		expireInMinutes: 30,
	},
	[QUEUES.UPLOAD_SESSION_SWEEP]: {
		// The row moves to `aborted` before the next run, so a retry sweeps nothing
		// twice; 30 minutes bounds an abort pass over up to 200 rows.
		retryLimit: 2,
		retryDelay: 300,
		expireInMinutes: 30,
	},
	[QUEUES.PURCHASE_TRANSFER_RETRY]: {
		// The sweep is its own retry: every run re-derives the whole owed worklist, so a
		// failed job costs fifteen minutes of latency rather than a lost share. Small
		// retry budget for the same reason — the next cron firing is the real retry.
		retryLimit: 1,
		retryDelay: 60,
		expireInMinutes: 10,
	},
	[QUEUES.PUBLISH_SCHEDULED]: {
		retryLimit: 1,
		expireInMinutes: 5,
	},
	[QUEUES.RELEASE_SCHEDULED]: {
		retryLimit: 1,
		expireInMinutes: 5,
	},
	// Reads two third-party services, so a transient failure is expected rather than
	// exceptional — but a retry budget is not what covers that. The sweep is idempotent and
	// runs again in an hour, and an unreadable directory is deliberately not a finding, so
	// the correct response to failure is to stop and try later rather than to hammer.
	[QUEUES.WATCH_IDENTITIES]: {
		retryLimit: 1,
		expireInMinutes: 15,
	},
	// Safe to retry and safe to run twice: each reminder is claimed through the unique
	// `dedupeKey` before its email goes out, so a retry after a partial failure re-selects
	// only the pairs it never claimed and cannot double-send one it did.
	[QUEUES.DEADLINE_REMINDERS]: {
		retryLimit: 2,
		expireInMinutes: 30,
	},
};

/**
 * Queues this code once ran and no longer does.
 *
 * 🚨 **pg-boss keeps a schedule in its own tables after the code that registered it is gone.**
 * Deleting a queue from `QUEUES` and `CRON_SCHEDULES` stops this deployment registering it and
 * does nothing about the row an earlier deployment wrote, so a retired cron goes on creating
 * jobs that no worker listens for. The worker retires each of these on boot. Keep a name here
 * after its queue is removed; the cost of an entry is one no-op per boot.
 */
export const RETIRED_QUEUES: readonly string[] = [
	// Cross-publishing to other platforms, retired as a direction on 2026-08-31 and removed
	// from the code on 2026-09-13.
	"cross-publish",
	"fetch-metrics",
	// The paged renderer's old name, retired on 2026-10-11: the job stopped being an
	// ebook job when the paged kinds' ingest became its own pipeline ("render-paged") —
	// the EPUB era's "ebook" ingest is a different job on a different table, so the old
	// name would have said the opposite of what the handler does.
	"rasterize-ebook",
	// The media pipeline's two per-type queues, retired on 2026-10-17 for the single-file
	// lane: the worker ran one video beside two audios, oversubscribing its plan's two
	// vCPUs and putting every measured encode outside its benchmark band. One queue at
	// concurrency 1 replaced both; see QUEUES.MEDIA.
	"transcode-video",
	"process-audio",
];

/**
 * Every cron the worker registers, as data.
 *
 * Lifted out of `start()` so the registration is assertable without pg-boss: the
 * schedules used to be five inline `queue.schedule(...)` calls inside a function that
 * only runs against a live queue, so nothing could check them and a dropped or mistyped
 * line would surface as "the cron just never fired" in production. `publish-scheduled`
 * in particular is load-bearing — it is the only thing that turns a scheduled draft into
 * a published post.
 */
export const CRON_SCHEDULES: ReadonlyArray<
	readonly [(typeof QUEUES)[keyof typeof QUEUES], string]
> = [
	[QUEUES.DISTRIBUTE_POOL, "0 0 * * *"], // midnight daily
	[QUEUES.SETTLE_CYCLE, "0 2 2 * *"], // 2 AM on the 2nd, clear of the renewals on the 1st
	// 4 AM daily, deliberately AFTER settle-cycle's 2 AM on the 2nd — the money this job
	// moves is the money settlement credited, so a settlement that lands at 2 AM is
	// hold-eligible fourteen days from its own settledAt rather than waiting a night.
	// 4 AM is otherwise free: run-deletions shares it but erases accounts, which has
	// nothing to do with holding money, and a few hours' latency on a 14-day hold is
	// invisible. The slot was picked per the brief (4 AM UTC, stated here).
	[QUEUES.TRANSFER_HELD_CREDITS, "0 4 * * *"],
	// hosting subsidy calculation (legacy queue name: calculate-crf)
	[QUEUES.CALCULATE_CRF, "0 1 * * *"], // 1 AM daily (idempotent per month)
	// 1:30 AM daily, after the subsidy job reads the same tables and before the night's
	// other sweeps. The one cron whose ordering rule is about *readers*: calculate-crf's
	// snapshot of `assets.file_size` at 1 AM and this meter's at 1:30 could in principle
	// straddle an upload landing — acceptable, because both figures are dated snapshots of
	// a moving stock, not a transaction. The meter must precede nothing; it must only run
	// daily so the in-flight month's estimate stays fresh.
	[QUEUES.STORAGE_USAGE, "30 1 * * *"], // 1:30 AM daily (idempotent upsert per cycle)
	// 2:30 AM daily, after the meter's 1:30: a Work this sweep purges changes the stock
	// the meter measures, so the meter's reading of the ending month should already
	// include the day's last state. The buyer's deadline arithmetic is per-Work from
	// withdrawnAt, so running after midnight UTC's turn is what keeps "90 days" honest
	// at the boundary — a Work one day short is warned, not swept.
	[QUEUES.WITHDRAWN_SWEEP, "30 2 * * *"], // 2:30 AM daily
	[QUEUES.PUBLISH_SCHEDULED, "* * * * *"], // every minute — publishes due drafts
	[QUEUES.RELEASE_SCHEDULED, "* * * * *"], // every minute — releases due Works that are ready
	// 3 AM daily, deliberately AFTER distribute-pool's midnight run: the pool pays
	// creators out of these rows, so pruning ahead of it would cost earnings rather
	// than privacy. The retention window is months wide, so the ordering has enormous
	// slack — it is stated here so a future reschedule has to notice the dependency.
	// Hourly at :23, off the hour so it does not queue behind whatever else fires at :00.
	// See the queue comment for why hourly rather than daily: the remedy it protects expires
	// in 72 hours.
	[QUEUES.WATCH_IDENTITIES, "23 * * * *"],
	// 4:20 AM daily, off the hour and after the night's other sweeps. A disagreement between a
	// Work and its listing is not urgent by the minute — the per-event enqueue already covers
	// the ordinary case — but it must not go unnoticed for a week.
	[QUEUES.RECONCILE_LISTINGS, "20 4 * * *"],
	[QUEUES.PRUNE_ATTENTION, "0 3 * * *"],
	// 3:45 AM daily. No ordering dependency — traffic pays nobody, so it cannot
	// strand earnings the way prune-attention would have run ahead of distribute-pool
	// — and traffic runs last among the night's sweeps purely by convention: raw
	// traffic rows are thirty days old when pruned, so a day of latency is invisible.
	[QUEUES.PRUNE_TRAFFIC, "45 3 * * *"],
	// 3:30 AM daily. Nothing depends on the ordering — an expired session is dead to every
	// user the moment it expires, so this only reclaims the row and the IP on it.
	[QUEUES.PRUNE_CREDENTIALS, "30 3 * * *"],
	// 4 AM daily. Hourly would honor the grace period more precisely, but the window
	// is a week — a few hours' latency on the far end of it is not something a user can
	// perceive, and a wipe that runs once a day is a wipe you can reason about.
	[QUEUES.RUN_DELETIONS, "0 4 * * *"],
	// Hourly at :37, off the shared marks. A temporary suspension's end is a promise
	// made to its holder, so an hour's latency on it is acceptable where a day's
	// would not be — and unlike a deletion, a late lift harms nothing irreversible.
	[QUEUES.LIFT_SUSPENSIONS, "37 * * * *"],
	// Hourly beside the lift sweep rather than daily: the window's end is when withheld
	// money becomes the creator's again on the DEFAULT outcome, and a day's latency on
	// being paid money you are owed is the kind of thing that reads as the forfeiture the
	// hold exists to disprove, without saving anyone a review.
	[QUEUES.RELEASE_PAYOUT_HOLDS, "52 * * * *"], // 5 AM daily. The counter-notice window is 10 business days, so a daily sweep
	// is well within the statutory tolerance — and the sweep errs toward "late"
	// per the brief's guidance: it restores no earlier than `restoreNoEarlierThan`,
	// never before.
	[QUEUES.DMCA_RESTORE, "0 5 * * *"],
	// 5:30 AM daily, deliberately AFTER the restore sweep. A notice that is being
	// restored this morning must not be finalized this morning — `finalizeNotice`
	// refuses a Work that is no longer taken down, so the ordering is belt and
	// braces rather than load-bearing, but running the refund pass second means
	// the money is always the last thing to move.
	[QUEUES.DMCA_FINALIZE, "30 5 * * *"],
	// 6 AM daily, after both DMCA sweeps. Ordering is not load-bearing — the
	// threshold is three YEARS, so a day either way is noise — but running last
	// means a record is never redacted in the same pass that settles it.
	[QUEUES.REDACT_RECORDS, "0 6 * * *"],
	// Every five minutes, and deliberately unlike everything above it. See the note on
	// QUEUES.ESCALATE_REPORTS: this is the only entry here whose latency is measured
	// against a statutory "as soon as reasonably possible" rather than against a
	// retention window or a billing cycle.
	[QUEUES.ESCALATE_REPORTS, "*/5 * * * *"],
	// Every hour rather than nightly, because what it is re-asking after is a vendor
	// outage, and an outage that ends at 9 AM should not leave a day of uploads unscanned
	// until 3 the next morning. Nothing is waiting on a person, so it is hourly rather
	// than five-minutely.
	[QUEUES.RESCAN_OWED, "20 * * * *"],
	// 6:45 AM daily, after the night's other sweeps and off the shared marks. Daily is
	// enough because the nearest deadline any source carries is days out, not hours — a
	// 30-day rights request, a 10-business-day counter-notice window, a calendar of
	// filings months apart — so a sweep that runs once a day delivers each reminder within
	// a day of the moment it becomes due, inside every window's tolerance.
	// 7 AM daily, after the night's other sweeps. Nothing here is latency-sensitive —
	// the bytes are private, unreachable and uncounted by clients — and the walk is
	// storage-wide, so off-hours it stays.
	[QUEUES.DEADLINE_REMINDERS, "45 6 * * *"],
	[QUEUES.HLS_ORPHAN_SWEEP, "0 7 * * *"],
	// 7:15 AM daily, after the prefix sweep — the same family (storage nobody can
	// reach and nobody is billed against by a client), just later off-hours.
	[QUEUES.UPLOAD_SESSION_SWEEP, "15 7 * * *"],
	// Every fifteen minutes: an owed purchase share is a creator's earned money sitting
	// on the platform balance, which is the posture the split decision keeps to seconds —
	// so the retry cadence is minutes, not the small hours. The scan is one query on an
	// empty worklist, so the cadence is free when nothing is owed.
	[QUEUES.PURCHASE_TRANSFER_RETRY, "*/15 * * * *"],
	// Every five minutes — the record's grain. The public status page renders history at
	// day grain from these samples, and the minute-level alarm that must notice a short
	// outage is the droplet heartbeat's (a different failure domain with its own cron),
	// so sampling at the heartbeat's cadence would buy nothing the page can show.
	[QUEUES.STATUS_SAMPLE, "*/5 * * * *"],
	// Every fifteen minutes because the two incidents this watches for were minutes long:
	// the 10-10 stall lasted about five, and a census that runs hourly can sit out a whole
	// failure. The read is one cheap query pair, and the alarm's day budget already bounds
	// what repetition costs.
	[QUEUES.CONNECTION_CENSUS, "*/15 * * * *"],
] as const;

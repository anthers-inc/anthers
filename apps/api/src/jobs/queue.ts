// SPDX-License-Identifier: AGPL-3.0-or-later
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

function toBossSendOptions(options?: SendOptions): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (options?.retryLimit !== undefined) out.retryLimit = options.retryLimit;
	if (options?.retryDelay !== undefined) out.retryDelay = options.retryDelay;
	if (options?.expireInMinutes !== undefined) out.expireInSeconds = options.expireInMinutes * 60;
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
		this.boss.on("error", (err) => console.error("[queue] pg-boss error:", err));
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

	async stop(opts?: { graceful?: boolean; timeout?: number }): Promise<void> {
		await this.boss.stop({ graceful: opts?.graceful ?? true, timeout: opts?.timeout });
		this.started = false;
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
	TRANSCODE_VIDEO: "transcode-video",
	PROCESS_AUDIO: "process-audio",
	RASTERIZE_EBOOK: "rasterize-ebook", // Render an uploaded PDF to private per-page images
	DISTRIBUTE_POOL: "distribute-pool",
	SETTLE_CYCLE: "settle-cycle", // Month-end allowance draw + remainder inflows
	CALCULATE_CRF: "calculate-crf", // Legacy name; calculates hosting subsidy allocations
	FETCH_METRICS: "fetch-metrics",
	CROSS_PUBLISH: "cross-publish",
	PUBLISH_SCHEDULED: "publish-scheduled", // Auto-publish drafts whose scheduledFor has arrived
	// Hash a stored object and ask a detection vendor about the hash. Keyed on the storage
	// key rather than the Work, because that is the only identifier both upload paths share:
	// the presigned PUT never passes the bytes through the API, so the object exists in R2
	// before anything here knows about it. See wiki 40.12.
	SCAN_MEDIA: "scan-media",
	// Re-ask for the objects whose scan never came back. `SCAN_MEDIA` gives up after its
	// retry budget, and release gives way after two minutes, so between them an object
	// caught by a vendor outage would otherwise never be scanned again — which would make
	// the release gate a formality rather than a gate. See `worksOwedScans`.
	RESCAN_OWED: "rescan-owed",
	PRUNE_ATTENTION: "prune-attention", // Roll raw attention into daily totals, then delete it
	RUN_DELETIONS: "run-deletions", // Erase accounts whose deletion grace period has elapsed
	// Delete expired sessions and verification tokens. Privacy Policy promises "Sessions: deleted
	// when they expire"; until 2026-08-12 `deleteExpiredSessions()` and
	// `deleteExpiredTokens()` were exported and called from NOWHERE, so every session row
	// ever written — with its `ip_address` and `user_agent` — was filtered out of reads
	// and kept forever. A retention promise with no mechanism behind it.
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
} as const;

export const JOB_OPTIONS: Record<string, SendOptions> = {
	[QUEUES.TRANSCODE_VIDEO]: {
		retryLimit: 2,
		retryDelay: 60,
		expireInMinutes: 45, // Video transcoding can take up to 30 min
	},
	[QUEUES.PROCESS_AUDIO]: {
		retryLimit: 2,
		retryDelay: 60,
		expireInMinutes: 15,
	},
	[QUEUES.RASTERIZE_EBOOK]: {
		retryLimit: 2,
		retryDelay: 60,
		// A long graphic novel is one poppler pass plus an upload per page; generous for
		// the same reason video is, and bounded by MAX_PAGES in the job itself.
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
	[QUEUES.CROSS_PUBLISH]: {
		retryLimit: 2,
		retryDelay: 120,
		expireInMinutes: 5,
	},
	[QUEUES.DISTRIBUTE_POOL]: {
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
	[QUEUES.CALCULATE_CRF]: {
		retryLimit: 1,
		expireInMinutes: 30,
	},
	[QUEUES.FETCH_METRICS]: {
		retryLimit: 1,
		expireInMinutes: 15,
	},
	[QUEUES.PUBLISH_SCHEDULED]: {
		retryLimit: 1,
		expireInMinutes: 5,
	},
};

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
	[QUEUES.SETTLE_CYCLE, "0 2 1 * *"], // 2 AM on the 1st — settles the prior cycle
	// hosting subsidy calculation (legacy queue name: calculate-crf)
	[QUEUES.CALCULATE_CRF, "0 1 * * *"], // 1 AM daily (idempotent per month)
	[QUEUES.FETCH_METRICS, "0 */6 * * *"], // every 6 hours
	[QUEUES.PUBLISH_SCHEDULED, "* * * * *"], // every minute — publishes due drafts
	// 3 AM daily, deliberately AFTER distribute-pool's midnight run: the pool pays
	// creators out of these rows, so pruning ahead of it would cost earnings rather
	// than privacy. The retention window is months wide, so the ordering has enormous
	// slack — it is stated here so a future reschedule has to notice the dependency.
	[QUEUES.PRUNE_ATTENTION, "0 3 * * *"],
	// 3:30 AM daily. Nothing depends on the ordering — an expired session is dead to every
	// reader the moment it expires, so this only reclaims the row and the IP on it.
	[QUEUES.PRUNE_CREDENTIALS, "30 3 * * *"],
	// 4 AM daily. Hourly would honor the grace period more precisely, but the window
	// is a week — a few hours' latency on the far end of it is not something a user can
	// perceive, and a wipe that runs once a day is a wipe you can reason about.
	[QUEUES.RUN_DELETIONS, "0 4 * * *"],
	// 5 AM daily. The counter-notice window is 10 business days, so a daily sweep
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
] as const;

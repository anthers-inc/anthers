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
	DISTRIBUTE_POOL: "distribute-pool",
	CALCULATE_CRF: "calculate-crf", // Legacy name; calculates Foundation subsidy allocations
	FETCH_METRICS: "fetch-metrics",
	CROSS_PUBLISH: "cross-publish",
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
	[QUEUES.CROSS_PUBLISH]: {
		retryLimit: 2,
		retryDelay: 120,
		expireInMinutes: 5,
	},
	[QUEUES.DISTRIBUTE_POOL]: {
		retryLimit: 1,
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
};

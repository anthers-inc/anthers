/**
 * Lightweight SQLite-backed job queue with cron scheduling.
 *
 * Provides a small subset of the pg-boss API the app uses: send / work /
 * schedule / start / stop.
 *
 * The queue lives in its own SQLite file (default ./data/anthers-queue.sqlite)
 * separate from the app DB. SQLite serializes writers per-database-file, so
 * keeping the queue separate means BEGIN IMMEDIATE on a job claim doesn't
 * stall application writes, and vice versa.
 *
 * Schema is bootstrapped imperatively (CREATE TABLE IF NOT EXISTS) on start.
 * If a future change needs to alter the queue schema, version it via
 * PRAGMA user_version and a small migration block here — drizzle migrations
 * are reserved for app domain schema only.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { Cron } from "croner";

// Resolve the queue DB path relative to the project root (this file lives at
// apps/api/src/jobs/queue.ts; root is four ../). Keeps the default working
// regardless of cwd — bun --filter changes cwd to the workspace dir.
const projectRoot = resolve(import.meta.dir, "..", "..", "..", "..");
const rawQueueUrl = process.env.QUEUE_DATABASE_URL ?? "./data/anthers-queue.sqlite";
const QUEUE_DATABASE_URL = rawQueueUrl.startsWith("/")
	? rawQueueUrl
	: resolve(projectRoot, rawQueueUrl);

// ── Queue schema (imperative bootstrap) ──────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_jobs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	queue TEXT NOT NULL,
	data TEXT NOT NULL DEFAULT '{}',
	state TEXT NOT NULL DEFAULT 'created',
	retry_count INTEGER NOT NULL DEFAULT 0,
	retry_limit INTEGER NOT NULL DEFAULT 0,
	retry_delay_seconds INTEGER NOT NULL DEFAULT 0,
	expire_in_ms INTEGER,
	start_after_ms INTEGER NOT NULL,
	started_at_ms INTEGER,
	completed_at_ms INTEGER,
	error TEXT,
	created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_jobs_pickup
	ON queue_jobs(queue, state, start_after_ms);
CREATE INDEX IF NOT EXISTS idx_queue_jobs_reaper
	ON queue_jobs(state, started_at_ms);

-- Cron dedupe: one row per (queue, minute-bucketed fire time).
-- Lets queue.schedule() be safely called from any process — only the
-- writer that wins the unique-insert race actually enqueues.
CREATE TABLE IF NOT EXISTS cron_locks (
	queue TEXT NOT NULL,
	fire_at_minute INTEGER NOT NULL,
	PRIMARY KEY (queue, fire_at_minute)
);
`;

const REAPER_INTERVAL_MS = 30_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SendOptions {
	retryLimit?: number;
	retryDelay?: number; // seconds, flat — exponential backoff would derive from retry_count
	expireInMinutes?: number;
	startAfter?: number; // ms epoch
}

export interface WorkOptions {
	localConcurrency?: number;
	pollIntervalMs?: number;
}

export interface Job<T> {
	id: number;
	data: T;
}

export type Handler<T> = (jobs: Job<T>[]) => Promise<void> | void;

interface JobRow {
	id: number;
	queue: string;
	data: string;
	state: string;
	retry_count: number;
	retry_limit: number;
	retry_delay_seconds: number;
	expire_in_ms: number | null;
	start_after_ms: number;
	started_at_ms: number | null;
	completed_at_ms: number | null;
	error: string | null;
	created_at_ms: number;
}

// ── Queue implementation ─────────────────────────────────────────────────────

class JobQueue {
	private db: Database;
	private workers: Array<{ stop: () => void }> = [];
	private crons: Cron[] = [];
	private reaperTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private shuttingDown = false;
	private activeHandlers = new Set<Promise<unknown>>();

	constructor() {
		this.db = new Database(QUEUE_DATABASE_URL, { create: true });
		// busy_timeout is essential: SQLite serializes writers across processes
		// (WAL helps reads, not writes). 5s gives the API and worker plenty of
		// runway to retry transparently before SQLITE_BUSY surfaces.
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(SCHEMA);
	}

	/** No-op; kept for API compatibility with pg-boss usage sites. */
	createQueue(_name: string): void {}

	async start(): Promise<void> {
		this.started = true;
		this.reapStaleJobs();
		this.reaperTimer = setInterval(() => this.reapStaleJobs(), REAPER_INTERVAL_MS);
	}

	send<T>(queue: string, data: T, options?: SendOptions): number {
		const now = Date.now();
		const startAfter = options?.startAfter ?? now;
		const expireInMs = options?.expireInMinutes
			? options.expireInMinutes * 60 * 1000
			: null;
		const result = this.db
			.query<{ id: number }, [string, string, number, number, number | null, number, number]>(
				`INSERT INTO queue_jobs
					(queue, data, retry_limit, retry_delay_seconds, expire_in_ms, start_after_ms, created_at_ms)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					RETURNING id`,
			)
			.get(
				queue,
				JSON.stringify(data ?? {}),
				options?.retryLimit ?? 0,
				options?.retryDelay ?? 0,
				expireInMs,
				startAfter,
				now,
			);
		return result?.id ?? -1;
	}

	work<T>(queue: string, optionsOrHandler: WorkOptions | Handler<T>, maybeHandler?: Handler<T>): void {
		const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
		const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
		if (!handler) throw new Error(`work(${queue}): missing handler`);

		const concurrency = options.localConcurrency ?? 1;
		const pollMs = options.pollIntervalMs ?? 1000;

		let inFlight = 0;
		let stopped = false;

		const tick = async () => {
			if (stopped || this.shuttingDown) return;
			while (inFlight < concurrency) {
				const claimed = this.claimOne(queue);
				if (!claimed) return;
				inFlight++;
				const job: Job<T> = { id: claimed.id, data: JSON.parse(claimed.data) as T };
				const work = (async () => {
					// One job per handler invocation: a thrown handler only fails the
					// one job, not a whole batch. The Job[] argument is preserved for
					// API parity but is always length 1.
					try {
						await handler([job]);
						this.markCompleted(job.id);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						this.markFailed(job.id, message);
					} finally {
						inFlight--;
					}
				})();
				this.activeHandlers.add(work);
				work.finally(() => this.activeHandlers.delete(work));
			}
		};

		const interval = setInterval(tick, pollMs);
		this.workers.push({
			stop: () => {
				stopped = true;
				clearInterval(interval);
			},
		});
	}

	schedule(queue: string, cronExpr: string, data: unknown = {}): void {
		const cron = new Cron(cronExpr, () => {
			if (this.shuttingDown) return;
			// Bucket fires to minute granularity (every queue.schedule cron we use
			// has minute-level resolution). Insert OR IGNORE on the lock table:
			// if another process already enqueued this firing, ours is dropped.
			const minuteBucket = Math.floor(Date.now() / 60_000);
			const lock = this.db
				.query<unknown, [string, number]>(
					"INSERT OR IGNORE INTO cron_locks (queue, fire_at_minute) VALUES (?, ?)",
				)
				.run(queue, minuteBucket);
			if (lock.changes === 0) return; // another process won the race
			this.send(queue, data);
		});
		this.crons.push(cron);
	}

	async stop(opts?: { graceful?: boolean; timeout?: number }): Promise<void> {
		this.shuttingDown = true;
		for (const w of this.workers) w.stop();
		for (const c of this.crons) c.stop();
		if (this.reaperTimer) clearInterval(this.reaperTimer);
		this.workers = [];
		this.crons = [];
		this.reaperTimer = null;

		if (opts?.graceful !== false) {
			const timeout = opts?.timeout ?? 30_000;
			const deadline = Date.now() + timeout;
			while (this.activeHandlers.size > 0 && Date.now() < deadline) {
				await Promise.race([
					Promise.allSettled([...this.activeHandlers]),
					new Promise((r) => setTimeout(r, 250)),
				]);
			}
		}
		this.db.close();
		this.started = false;
		this.shuttingDown = false;
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	/**
	 * Atomically claim one job. Wrapped in BEGIN IMMEDIATE so the write lock
	 * is held before the candidate SELECT runs — without this, two workers
	 * could read the same candidate set and only one's UPDATE would actually
	 * change rows, wasting a poll cycle on the loser.
	 */
	private claimOne(queue: string): JobRow | null {
		const now = Date.now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db
				.query<JobRow, [number, string, number]>(
					`UPDATE queue_jobs
						SET state = 'active', started_at_ms = ?
						WHERE id = (
							SELECT id FROM queue_jobs
							WHERE queue = ?
								AND state = 'created'
								AND start_after_ms <= ?
							ORDER BY id
							LIMIT 1
						)
						RETURNING *`,
				)
				.get(now, queue, now);
			this.db.exec("COMMIT");
			return row ?? null;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	private markCompleted(id: number): void {
		this.db
			.query<unknown, [number, number]>(
				"UPDATE queue_jobs SET state = 'completed', completed_at_ms = ? WHERE id = ?",
			)
			.run(Date.now(), id);
	}

	private markFailed(id: number, error: string): void {
		const row = this.db
			.query<JobRow, [number]>("SELECT * FROM queue_jobs WHERE id = ?")
			.get(id);
		if (!row) return;

		const now = Date.now();
		if (row.retry_count < row.retry_limit) {
			this.db
				.query<unknown, [string, number, number]>(
					`UPDATE queue_jobs
						SET state = 'created',
							retry_count = retry_count + 1,
							error = ?,
							started_at_ms = NULL,
							start_after_ms = ?
						WHERE id = ?`,
				)
				.run(error, now + row.retry_delay_seconds * 1000, id);
		} else {
			this.db
				.query<unknown, [string, number]>(
					"UPDATE queue_jobs SET state = 'failed', error = ? WHERE id = ?",
				)
				.run(error, id);
		}
	}

	/**
	 * Reaper: handles two cases for active jobs whose handler has hung past
	 * expire_in_ms — (1) retries available → back to created with a delay,
	 * (2) retry budget exhausted → straight to failed (no more doomed attempts).
	 * Runs on start and on a periodic timer.
	 */
	private reapStaleJobs(): void {
		const now = Date.now();
		// Failure path first: stale jobs at retry limit go straight to failed.
		this.db
			.query<unknown, [number]>(
				`UPDATE queue_jobs
					SET state = 'failed',
						error = COALESCE(error, 'reaper: handler exceeded expire_in_ms')
					WHERE state = 'active'
						AND expire_in_ms IS NOT NULL
						AND (started_at_ms + expire_in_ms) < ?
						AND retry_count >= retry_limit`,
			)
			.run(now);
		// Retry path: requeue with delay.
		this.db
			.query<unknown, [number, number]>(
				`UPDATE queue_jobs
					SET state = 'created',
						retry_count = retry_count + 1,
						started_at_ms = NULL,
						start_after_ms = ?,
						error = COALESCE(error, 'reaper: handler exceeded expire_in_ms')
					WHERE state = 'active'
						AND expire_in_ms IS NOT NULL
						AND (started_at_ms + expire_in_ms) < ?
						AND retry_count < retry_limit`,
			)
			.run(now, now);

		// Garbage-collect old cron locks (older than 1 day) so the table
		// doesn't grow unbounded.
		const dayAgoMinute = Math.floor((now - 24 * 60 * 60 * 1000) / 60_000);
		this.db
			.query<unknown, [number]>("DELETE FROM cron_locks WHERE fire_at_minute < ?")
			.run(dayAgoMinute);
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

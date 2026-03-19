import { PgBoss } from "pg-boss";

export const boss = new PgBoss({
	connectionString: process.env.DATABASE_URL!,
	// pg-boss creates its own schema (pgboss) for queue tables
	schema: "pgboss",
	// Don't log maintenance operations at info level
	noSupervisor: false,
});

/** Start pg-boss and ensure all queues exist (idempotent — safe to call from both API server and worker) */
let started = false;
export async function ensureBossReady(): Promise<void> {
	if (started) return;
	await boss.start();
	// createQueue is idempotent — safe to call even if queues already exist
	for (const queue of Object.values(QUEUES)) {
		await boss.createQueue(queue);
	}
	started = true;
}

/** Queue name constants */
export const QUEUES = {
	TRANSCODE_VIDEO: "transcode-video",
	PROCESS_AUDIO: "process-audio",
	DISTRIBUTE_POOL: "distribute-pool",
	CALCULATE_CRF: "calculate-crf", // Legacy name; calculates Foundation subsidy allocations
	FETCH_METRICS: "fetch-metrics",
	CROSS_PUBLISH: "cross-publish",
} as const;

/** Default job options by queue */
export const JOB_OPTIONS = {
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
} as const;

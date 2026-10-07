// SPDX-License-Identifier: Apache-2.0
/**
 * What the deepened `/health` and the status page are built from.
 *
 * 🚨 **The history this exists to correct**: `/health` checked only liveness — it answered
 * `{status: "ok"}` from a process that could not reach Postgres or the queue, which reads
 * as *the application is healthy* while meaning *the process is alive*. A health check that
 * answers only liveness lies by omission, to DigitalOcean's container-level health checks
 * and to the status page alike. Both are moved onto this service: the container check wants
 * a truthful yes-or-no answer, and the page wants the components behind the answer.
 *
 * **Every check answers the question it names, and reads state rather than performing
 * work.** The database check is `SELECT 1` (connectivity, the thing a pool exhaustion
 * breaks, with the pool deliberately capped at 3 against a cluster ceiling of ~25). The
 * queue check reads the `pgboss` schema directly by SQL — the same read the admin console
 * makes — because 🚨 **`boss.start()` is what the *worker* process does, not this one**:
 * a process-local pg-boss read would report "down" on every healthy deployment whose
 * worker holds the queue, and the tables are in the shared database precisely so both
 * processes (and this check) can read them. Neither check writes anything.
 *
 * **Depth (connection counts, queue lengths) feeds alerts and the Admin console — never a
 * public page.** The public answer is a *state*, not a number: a stranger reading this
 * route 40,000 times an hour must learn nothing a load-fingerprint could use. The states
 * are thresholds, deliberately coarse and deliberately not secret-but-fine-grained.
 */

import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import { rowsOf } from "./rows.js";

/** The three states a component answers in. A page is honest with three; five is theater. */
export type ComponentState = "operational" | "degraded" | "down";

/** One component's answer, as the status API and the deepened health route render it. */
export interface ComponentHealth {
	/** The state, derived from the component's own probe. */
	state: ComponentState;
	/** What a reader is told when the state is anything but operational. Human, not machine. */
	detail?: string;
	/** Milliseconds the probe took. Diagnostics for the Admin module; the public page may render or drop it. */
	ms?: number;
}

/** One queue's depth counts, for the alerting and Admin surfaces. Never rendered publicly. */
export interface QueueDepth {
	name: string;
	ready: number;
	active: number;
	failed: number;
}

/** The whole answer, as `/health` and `/api/status` return it. */
export interface HealthReport {
	/** Coarse overall state — `down` when a required component is down, `degraded` when one is degraded. */
	state: "operational" | "degraded" | "down";
	/** Per-component answers. */
	components: Record<string, ComponentHealth>;
	/** Queue depth counts, for the alerts and the Admin console. Present only when the queue answered. */
	queueDepths?: QueueDepth[];
	/** Server-side, when the answer was made. */
	checkedAt: string;
}

/** The database probe: a real round-trip through the capped pool, reading nothing. */
async function checkDatabase(): Promise<ComponentHealth> {
	const started = Date.now();
	try {
		await db.execute(sql`select 1`);
		return { state: "operational", ms: Date.now() - started };
	} catch {
		return {
			state: "down",
			detail: "The database is not answering.",
			ms: Date.now() - started,
		};
	}
}

/**
 * The queue probe: read the `pgboss` schema directly, the way the admin route does —
 * 🚨 **not `queue.getQueues()`**, which requires `boss.start()`, and `start()` is what the
 * worker process calls rather than this one; a process-local answer would read "down" on a
 * healthy deployment whose worker is the one holding the queue. The tables are in the
 * shared database, so a SQL read reflects the queue's actual state to whichever process
 * asks. Queues are seeded from the `QUEUES` constant the same way the admin console seeds
 * them, so an idle-but-healthy queue (its completed jobs pruned to zero rows) still reads.
 */
async function checkQueue(): Promise<ComponentHealth> {
	const started = Date.now();
	try {
		const exists = await db.execute(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`);
		const present = rowsOf<{ present: boolean }>(exists)[0]?.present === true;
		if (!present)
			return { state: "down", detail: "The job queue is not answering.", ms: Date.now() - started };
		const counts = await db.execute(sql`
			SELECT state::text AS state, count(*)::int AS n
			FROM pgboss.job
			GROUP BY state
		`);
		const byState = new Map<string, number>();
		for (const row of rowsOf<{ state: string; n: number }>(counts)) {
			byState.set(row.state, row.n);
		}
		const failed = (byState.get("failed") ?? 0) + (byState.get("retry") ?? 0);
		return {
			state: failed > 0 ? "degraded" : "operational",
			...(failed > 0 ? { detail: "The job queue is holding failed jobs." } : {}),
			ms: Date.now() - started,
		};
	} catch {
		return {
			state: "down",
			detail: "The job queue is not answering.",
			ms: Date.now() - started,
		};
	}
}

/**
 * The whole report. 🚨 **The database is the only component whose being down means the
 * platform is down.** A queue that is degraded delays work — transcodes, settlements —
 * while the site keeps reading and writing; declaring `down` for it would tell
 * DigitalOcean's container health check to restart the API, which cannot fix a queue, and
 * would render the public page's headline darker than the truth the components underneath
 * it carry. The components hold the honest per-component answer; the headline is about
 * whether Anthers is serving.
 */
export async function healthReport(): Promise<HealthReport> {
	const [database, jobQueue] = await Promise.all([checkDatabase(), checkQueue()]);

	let state: HealthReport["state"] = "operational";
	if (database.state === "down") state = "down";
	else if (database.state === "degraded" || jobQueue.state !== "operational") state = "degraded";

	return {
		state,
		components: { database, jobQueue },
		checkedAt: new Date().toISOString(),
	};
}

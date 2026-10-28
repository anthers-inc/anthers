// SPDX-License-Identifier: Apache-2.0
/**
 * The queue-failure report — the five-minute sweep that pages an operator while a burst of
 * failed jobs is still happening.
 *
 * 🚨 **The 2026-10-19 incident was legible only the next morning.** Eleven `render-paged`
 * jobs exhausted their retries, and the first trace was a public status page reading
 * *degraded* twelve hours later. The status page is honest about a condition, but it is a
 * page somebody has to open; nothing told the operator at the time. This sweep is the missing
 * tell.
 *
 * **It reads, records and settles — it never re-runs a job.** pgboss's own rows are the
 * evidence: per queue, the number in `failed` (retries exhausted, work stalled) and `retry`
 * (a backoff in progress). It writes a fingerprint to the error tracker so the burst is
 * recorded where every other incident is, and mails through the tracker's one-per-day
 * dedupe so a condition that persists does not page every five minutes. The health check's
 * 24-hour window is unchanged as the last-resort self-clear: a one-off failure ages out of
 * both readings on its own.
 *
 * ⚠️ **The thresholds are deliberately asymmetric.** One exhausted job is already lost work
 * for somebody — the queue does not retry it again — so `failed` alarms at one. A retry is
 * ordinary (a PDS that was briefly down, a media fetch that took longer than its first
 * window), so `retry` alarms only at a burst of {@link RETRY_ALERT_THRESHOLD} in one queue.
 * A queue's counts are never summed with another's in the alarm's message, because a page
 * saying "twelve failures" when one queue holds eleven and another holds one is not a shape
 * anybody can act on.
 *
 * **No `deadLetter` queue is registered, and that is the decision rather than an omission.**
 * pg-boss can forward exhausted jobs to another queue, but a dead-letter queue needs its own
 * retention policy and a worker to settle it, and an unread queue is one more place failures
 * go to be forgotten — the very failure this sweep exists to end. The `failed` rows this
 * reads are already the durable record, with pg-boss's own retention and the health check's
 * window around them; a forwarder would add a second copy nothing watches.
 */
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import { sendOperationalAlert } from "../services/email.js";
import { alertDue, captureError, markAlerted } from "../services/error-tracker.js";
import { rowsOf } from "../services/rows.js";

/** One exhausted job is lost work; there is no benign threshold above zero. */
export const FAILED_ALERT_THRESHOLD = 1;

/** A retry is ordinary. This many retrying in one queue is a burst. */
export const RETRY_ALERT_THRESHOLD = 5;

/** The read window, matching the health check's own so the two never disagree about "now". */
export const QUEUE_FAILURE_WINDOW_HOURS = 24;

/** One queue's counts in the window. */
export interface QueueFailureSummary {
	queue: string;
	failed: number;
	retry: number;
}

/** A mail path, injectable so a suite observes the decision rather than the provider. */
export type AlarmSender = (args: { subject: string; html: string }) => Promise<{ sent: boolean }>;

type FailureRow = { queue: string; state: string; n: number };

/**
 * Fold the grouped `state` rows into one summary per queue, with queues in name order so the
 * report's text — and the test's — is stable.
 */
export function summarizeQueueFailures(rows: FailureRow[]): QueueFailureSummary[] {
	const byQueue = new Map<string, QueueFailureSummary>();
	for (const row of rows) {
		const summary = byQueue.get(row.queue) ?? { queue: row.queue, failed: 0, retry: 0 };
		if (row.state === "failed") summary.failed += row.n;
		if (row.state === "retry") summary.retry += row.n;
		byQueue.set(row.queue, summary);
	}
	return [...byQueue.values()].sort((a, b) => a.queue.localeCompare(b.queue));
}

/** The queues a page is owed for, by the asymmetric thresholds above. */
export function alarmingQueues(summaries: QueueFailureSummary[]): QueueFailureSummary[] {
	return summaries.filter(
		(summary) => summary.failed >= FAILED_ALERT_THRESHOLD || summary.retry >= RETRY_ALERT_THRESHOLD,
	);
}

/**
 * Read the queue's failure counts from the `pgboss` schema, the way the health check does —
 * directly by SQL, because `boss.start()` is the worker's act and the tables are in the
 * shared database so any process can read them.
 */
export async function readQueueFailures(): Promise<QueueFailureSummary[]> {
	// pg-boss creates its schema on first start; a database that has never run the worker
	// (every fresh test session) answers "no rows", not an error — the health check's own
	// probe is what reports a queue that is not there at all.
	const exists = await db.execute(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`);
	if (rowsOf<{ present: boolean }>(exists)[0]?.present !== true) return [];

	const counts = await db.execute(sql`
		SELECT name AS queue, state::text AS state, count(*)::int AS n
		FROM pgboss.job
		WHERE state IN ('failed','retry')
			AND started_on > now() - make_interval(hours => ${QUEUE_FAILURE_WINDOW_HOURS}::int)
		GROUP BY name, state
	`);
	return summarizeQueueFailures(rowsOf<FailureRow>(counts));
}

/** The one-per-day budget for a sweep that cannot read its own evidence. */
export const READ_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let lastReadFailureAt = 0;

/** Test hook: the cooldown is module state, so a suite resets it rather than waiting a day. */
export function resetQueueAlarmStateForTest(): void {
	lastReadFailureAt = 0;
}

function alarmBody(summary: QueueFailureSummary): string {
	return (
		`<p style="margin:0 0 18px;">The job queue <code>${summary.queue}</code> is holding <strong>${summary.failed}</strong> failed and <strong>${summary.retry}</strong> retrying jobs in the last ${QUEUE_FAILURE_WINDOW_HOURS} hours.</p>` +
		`<p style="margin:0 0 18px;">A failed job has exhausted its retries, so whatever it was going to do did not happen — a transcode, a settlement, a listing sync. This report never re-runs one: retrying is only safe per queue, and some of these move money. Read the rows, then decide whether the work is re-enqueued by its own path.</p>` +
		`<p style="margin:0;color:#6b6878;font-size:12px;">Alarms at most once a day per queue while the rows persist. The burst that prompted this check was eleven render-paged jobs on 2026-10-19, found the next morning on the status page.</p>`
	);
}

/**
 * One sweep: read the counts, record and page for each queue above its threshold.
 *
 * The capture is the record; the mail is the tell. `alertDue` carries the same one-per-day
 * resurface rule the error tracker uses everywhere — a condition that persists is one
 * conversation, not a page every five minutes.
 */
export async function runQueueFailureReport(
	options: {
		now?: Date;
		read?: () => Promise<QueueFailureSummary[]>;
		send?: AlarmSender;
		capture?: typeof captureError;
		due?: typeof alertDue;
		mark?: typeof markAlerted;
	} = {},
): Promise<{
	ok: boolean;
	alarming: QueueFailureSummary[];
	alerted: number;
	sent: number;
	error?: string;
}> {
	const now = options.now ?? new Date();
	const read = options.read ?? readQueueFailures;
	const send = options.send ?? sendOperationalAlert;
	const capture = options.capture ?? captureError;
	const due = options.due ?? alertDue;
	const mark = options.mark ?? markAlerted;

	let summaries: QueueFailureSummary[];
	try {
		summaries = await read();
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		// The evidence is unreadable, which is itself the alarm — but the error tracker writes
		// through the same database, so this one has to mail directly and dedupe in memory.
		if (now.getTime() - lastReadFailureAt < READ_FAILURE_COOLDOWN_MS) {
			return { ok: false, alarming: [], alerted: 0, sent: 0, error };
		}
		lastReadFailureAt = now.getTime();
		const result = await send({
			subject: "Job queue: the failure report cannot read pgboss",
			html:
				`<p style="margin:0 0 18px;">The queue-failure report could not read <code>pgboss.job</code> — ${error} — so a burst of failed jobs would be invisible to it.</p>` +
				`<p style="margin:0;color:#6b6878;font-size:12px;">This message re-sends at most once a day. The health check's own queue probe answers separately on /health.</p>`,
		});
		if (!result.sent) {
			console.error("[queue-failures] warned nobody: the report could not read pgboss.");
		}
		return { ok: false, alarming: [], alerted: 0, sent: result.sent ? 1 : 0, error };
	}

	const alarming = alarmingQueues(summaries);
	let alerted = 0;
	let sent = 0;
	for (const summary of alarming) {
		const captured = await capture({
			source: "worker",
			message: `Job queue ${summary.queue} holds failed and retrying jobs.`,
			context: { route: `job:${summary.queue}`, method: "QUEUE" },
		});
		if (!captured) continue;
		alerted += 1;
		if (!(await due(captured))) continue;
		const result = await send({
			subject: `Job queue: ${summary.queue} has ${summary.failed} failed`,
			html: alarmBody(summary),
		});
		if (!result.sent) {
			console.error(
				`[queue-failures] warned nobody about ${summary.queue} — the send was refused.`,
			);
			continue;
		}
		sent += 1;
		await mark(captured.fingerprint);
		console.warn(`[queue-failures] operator notified: ${summary.queue}`);
	}

	return { ok: true, alarming, alerted, sent };
}

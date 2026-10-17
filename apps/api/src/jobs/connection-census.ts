// SPDX-License-Identifier: Apache-2.0
/**
 * The connection census — the standing check the 2026-10-10 burst stall bought.
 *
 * Two incidents established that a database connection budget this small must be watched,
 * because nothing else notices its failure: the 2026-09-18 crash, where a restarted worker
 * was refused by a cluster whose slots dead workers were still holding, and the 2026-10-10
 * burst stall, where pg-boss's pool timed out acquiring for five minutes and nothing alerted
 * — the Studio stopped advancing and the only reason anybody knew was that Parker looked.
 *
 * The job answers the standing-check question in two directions. **The census sweep** reads
 * the cluster's limits from `pg_settings` and its current backends from `pg_stat_activity`,
 * groups them by which machinery opened them, and alerts when the usable slots are nearly
 * gone. The threshold derives from the live settings rather than a typed 25, so a resize
 * changes the answer without changing the code. **The queue half** is called from the boss
 * error listener when the error is itself a connection-exhaustion error — the exact message
 * the 10-10 burst produced.
 *
 * 🚨 **The alarm path must work exactly when the database cannot.** The error tracker's
 * dedupe writes through the database, so it cannot persist against an exhausted cluster and
 * every alert through it would die as a console line nobody watches. The alarm therefore
 * dedupes **in memory** — one alarm per day, reset only by a process restart — and mails
 * through `sendOperationalAlert` directly. The failure direction of that choice is one
 * duplicate email after a restart, never silence. **A cluster the census cannot even read**
 * is the terminal shape of exhaustion rather than a failed job, so the catch raises the same
 * alarm instead of logging quietly.
 *
 * ⚠️ **Quiet runs log nothing.** Steady state sat at 8 of 22 in both census readings of
 * 2026-10; a healthy cluster would make a periodic log line one more thing nobody reads, and
 * silence is what makes the alarm mean something. Knob status: trim, pooler and resize are on
 * stand-down (Parker, 2026-10-15) pending this alarm's first real firing.
 *
 * The media lane (2026-10-17) changed the shape that stresses this budget most: the video and
 * audio jobs left their per-type queues for one single-file media queue (`QUEUES.MEDIA`),
 * worked one at a time, so a processing lane now holds the encode lock's one reserved session
 * connection for the job's duration, where before it overlapped two audio handlers' load
 * beside it. The steady-state budget did not move; the burst peak did, dropping below what
 * the 2026-10-17 burst read measured (pg-boss connection timeouts through a burst of eight).
 */

import { client } from "@anthers/db/client";
import { sendOperationalAlert } from "../services/email.js";

/** Alert when this many usable slots or fewer remain free. At 22 usable, the alarm fires at 20 in use. */
export const FREE_SLOT_MARGIN = 3;

/** One alarm per day until the condition clears — the noisy-channel budget the error tracker runs. */
export const ALARM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** A mail path, injectable so the suites can observe the decision rather than the provider. */
export type AlarmSender = (args: { subject: string; html: string }) => Promise<{ sent: boolean }>;

export interface ConnectionCensus {
	/** The cluster's `max_connections`, read live from `pg_settings`. */
	maxConnections: number;
	/** Slots reserved for superuser roles — unusable by the application, per the 2026-10-06 finding. */
	reserved: number;
	/** What the application can actually hold: `max_connections − reserved`. */
	usable: number;
	/** Client backends currently holding slots on this database, the census's own excluded. */
	used: number;
	/** `usable − used`. */
	free: number;
	/** The backends grouped by which machinery opened them — the burst census's by-pool figure. */
	byPool: Record<string, number>;
}

/** Which machinery a backend belongs to, read from its application name and last/active query. */
export function fingerprintBackend(applicationName: string, query: string): string {
	if (applicationName.toLowerCase().includes("pool")) return "pgbouncer";
	if (query.toLowerCase().includes("pgboss")) return "pg-boss pools";
	// The try spelling acquires, the plain hold-and-release spellings ride the same
	// reserved session, and a re-read session's last query answers to any of them, so the
	// rule matches the whole advisory-(un)lock family without naming it here — see the
	// transcode guard, whose textual scan owns those spellings.
	if (/advisory_(un)?lock/.test(query.toLowerCase())) return "postgres-js (locked session)";
	return "postgres-js (app queries)";
}

/**
 * The verdict, pure: alert when free usable slots have fallen below the margin. A cluster
 * comfortably inside its budget stays quiet, and the boundary is the one the 2026-10-06
 * check recorded: warn while three slots still exist to be lost.
 */
export function censusVerdict(census: ConnectionCensus): { alert: boolean; free: number } {
	const free = census.usable - census.used;
	return { alert: free < FREE_SLOT_MARGIN, free };
}

// ── The alarm's in-memory budget ─────────────────────────────────────────────

let lastAlarmAt = 0;

/** Test hook: the dedupe is module state, so a suite resets it rather than waiting a day. */
export function resetAlarmStateForTest(): void {
	lastAlarmAt = 0;
}

function alarmDue(now: Date): boolean {
	return now.getTime() - lastAlarmAt >= ALARM_COOLDOWN_MS;
}

function censusTable(census: ConnectionCensus): string {
	const rows = Object.entries(census.byPool)
		.map(
			([name, n]) =>
				`<tr><td style="padding:2px 12px 2px 0;">${n}</td><td style="padding:2px 0;">${name}</td></tr>`,
		)
		.join("");
	return (
		`<table style="border-collapse:collapse;font-size:14px;">` +
		`<tr><th style="text-align:left;padding:2px 12px 2px 0;">Connections</th>` +
		`<th style="text-align:left;padding:2px 0;">Pool</th></tr>` +
		rows +
		`<tr><td style="padding:2px 12px 2px 0;"><strong>${census.used}</strong></td>` +
		`<td style="padding:2px 0;">in use of ${census.usable} usable (${census.maxConnections} max − ${census.reserved} reserved)</td></tr>` +
		`</table>`
	);
}

function alarmSubject(what: string): string {
	return `Database connections: ${what}`;
}

function alarmBody(what: string, census: ConnectionCensus | null): string {
	const headline =
		census === null
			? `<p style="margin:0 0 18px;">The connection census could not read the cluster — ${what} — which is the terminal shape of exhaustion: even one more backend was refused. The 2026-09-18 incident presented this way ("remaining connection slots are reserved…").</p>`
			: `<p style="margin:0 0 18px;">The connection census found the cluster nearly out of usable slots. Progress writes queue and the Studio stalls — the 2026-10-10 burst's shape.</p>${censusTable(census)}`;
	const causes =
		`<p style="margin:0 0 18px;">Likely causes: backends lingering from replaced workers (the 09-18 shape — they clear as the cluster reaps them), a worker hung through its own deploy, or genuine burst demand (the 10-10 shape). A rolling deploy alone fits the budget, so an alarm during a calm deploy is a hung instance, not the deploy.</p>` +
		`<p style="margin:0;color:#6b6878;font-size:12px;">Re-alarms at most once a day until free slots return. Trim, pooler and resize are on stand-down pending the knob decision this alarm informs.</p>`;
	return headline + causes;
}

async function raiseAlarm(
	now: Date,
	what: string,
	census: ConnectionCensus | null,
	send: AlarmSender,
): Promise<boolean> {
	lastAlarmAt = now.getTime();
	const subject = alarmSubject(what);
	const result = await send({ subject, html: alarmBody(what, census) });
	if (result.sent) {
		console.warn(`[connection-census] operator notified: ${subject}`);
	} else {
		// Loud, because sendOperationalAlert already said why — unset OPS_ALERT_EMAIL or a
		// non-public deployment — but the census's own line keeps the two in one read.
		console.error(`[connection-census] warned nobody: "${subject}" — the send was refused.`);
	}
	return result.sent;
}

/** Read the census. Throws when the cluster cannot be asked — the caller treats that as the alarm. */
export async function readCensus(): Promise<ConnectionCensus> {
	const [limits] = await client<{ max_connections: string; reserved: string }[]>`
		select
			(select setting from pg_catalog.pg_settings where name = 'max_connections') as max_connections,
			(select setting from pg_catalog.pg_settings where name = 'superuser_reserved_connections') as reserved
	`;
	const rows = await client<{ application_name: string; state: string; query: string }[]>`
		select application_name, state, query
		from pg_stat_activity
		where datname is not null
		  and state is not null
		  and pid <> pg_backend_pid()
	`;
	const byPool: Record<string, number> = {};
	for (const row of rows) {
		// Another copy of this census — and any other pg_stat_activity reader — still holds a
		// real slot and counts toward `used`, but reads as machinery rather than a pool.
		const pool = /pg_stat_activity/.test(row.query)
			? "pg_stat_activity readers"
			: fingerprintBackend(row.application_name, row.query);
		byPool[pool] = (byPool[pool] ?? 0) + 1;
	}
	const maxConnections = Number(limits.max_connections);
	const reserved = Number(limits.reserved);
	const used = rows.length;
	return {
		maxConnections,
		reserved,
		usable: maxConnections - reserved,
		used,
		free: maxConnections - reserved - used,
		byPool,
	};
}

/**
 * One census sweep: read, decide, alarm at most once a day. Returns the facts the worker's
 * handler and the tests both assert on.
 */
export async function runConnectionCensus(
	now: Date = new Date(),
	send: AlarmSender = sendOperationalAlert,
	read: () => Promise<ConnectionCensus> = readCensus,
): Promise<{
	ok: boolean;
	alerted: boolean;
	sent: boolean;
	used?: number;
	usable?: number;
	byPool?: Record<string, number>;
	error?: string;
}> {
	let census: ConnectionCensus;
	try {
		census = await read();
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (!alarmDue(now)) return { ok: false, alerted: true, sent: false, error };
		const sent = await raiseAlarm(now, "the census could not read the cluster", null, send);
		return { ok: false, alerted: true, sent, error };
	}

	const { alert, free } = censusVerdict(census);
	if (!alert) {
		return {
			ok: true,
			alerted: false,
			sent: false,
			used: census.used,
			usable: census.usable,
			byPool: census.byPool,
		};
	}
	if (!alarmDue(now)) {
		return {
			ok: true,
			alerted: true,
			sent: false,
			used: census.used,
			usable: census.usable,
			byPool: census.byPool,
		};
	}
	const sent = await raiseAlarm(
		now,
		`${census.used} of ${census.usable} usable in use — ${free} free`,
		census,
		send,
	);
	return {
		ok: true,
		alerted: true,
		sent,
		used: census.used,
		usable: census.usable,
		byPool: census.byPool,
	};
}

// ── The half that watches pg-boss's own errors ──────────────────────────────

/**
 * Whether a pg-boss error is a connection-exhaustion error — the messages production has
 * actually produced. Everything else pg-boss raises is logged where it always was.
 */
export function isConnectionExhaustionError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		/pg-pool: timeout exceeded when trying to connect/.test(message) ||
		/remaining connection slots are reserved/.test(message) ||
		/too many clients already/.test(message) ||
		/too many connections/.test(message)
	);
}

/**
 * Called from the queue's error listener when the classification above says exhaustion.
 * Reads a census for a richer email when the cluster can still answer, tells what it was
 * told when it cannot, and always rides the same one-per-day budget.
 */
export async function reportConnectionAlarm(
	err: unknown,
	now: Date = new Date(),
	send: AlarmSender = sendOperationalAlert,
	read: () => Promise<ConnectionCensus> = readCensus,
): Promise<{ alerted: boolean; sent: boolean }> {
	const detail = err instanceof Error ? err.message : String(err);
	try {
		const census = await read();
		const { alert, free } = censusVerdict(census);
		if (!alarmDue(now)) return { alerted: false, sent: false };
		if (alert) {
			const sent = await raiseAlarm(
				now,
				`${census.used} of ${census.usable} usable in use — ${free} free`,
				census,
				send,
			);
			return { alerted: true, sent };
		}
		// The pool machinery hit its own ceiling while the cluster reports free slots — a pool
		// misconfiguration rather than cluster exhaustion, still worth one alarm. The error
		// goes in the log, because the census table would hide the real complaint.
		const sent = await raiseAlarm(
			now,
			`a pool connection failed while ${census.used} of ${census.usable} usable were in use`,
			null,
			send,
		);
		if (sent) {
			console.error(`[connection-census] the connection failure that raised this: ${detail}`);
		}
		return { alerted: true, sent };
	} catch {
		// The census read itself failed — that is the alarm, not a failure of it.
		if (!alarmDue(now)) return { alerted: false, sent: false };
		const sent = await raiseAlarm(now, "the census could not read the cluster", null, send);
		if (sent) {
			console.error(`[connection-census] the connection failure that raised this: ${detail}`);
		}
		return { alerted: true, sent };
	}
}

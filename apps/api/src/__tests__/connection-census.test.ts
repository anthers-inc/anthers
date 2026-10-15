// SPDX-License-Identifier: Apache-2.0
/**
 * The connection census decides, and the tests assert the decisions rather than the sends.
 *
 * The suite covers the three moments that matter and would otherwise only be exercised by a
 * real outage: the quiet run (a healthy cluster sends nothing — silence is the signal), the
 * alarm run (near-exhaustion or an unreadable cluster sends exactly once and then stays
 * silent for a day), and the classification of the pg-boss errors the 2026-10-10 burst
 * actually produced. The census read is injected, so no test manufactures real connection
 * pressure; the one integration test reads the test session's own Postgres and only asserts
 * that the read succeeds and stays quiet.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	ALARM_COOLDOWN_MS,
	censusVerdict,
	FREE_SLOT_MARGIN,
	fingerprintBackend,
	isConnectionExhaustionError,
	readCensus,
	reportConnectionAlarm,
	resetAlarmStateForTest,
	runConnectionCensus,
} from "../jobs/connection-census.js";
import { CRON_SCHEDULES, QUEUES } from "../jobs/queue.js";

function censusOf(used: number) {
	return {
		maxConnections: 25,
		reserved: 3,
		usable: 22,
		used,
		free: 22 - used,
		byPool: {
			"pg-boss pools": Math.min(used, 6),
			"postgres-js (app queries)": Math.max(0, used - 6),
		},
	};
}

/** A sender that records what it was offered instead of mailing anyone. */
function recorder() {
	const calls: Array<{ subject: string; html: string }> = [];
	return {
		calls,
		send: async (args: { subject: string; html: string }) => {
			calls.push(args);
			return { sent: true, messageId: "test" };
		},
	};
}

const HOUR = 60 * 60 * 1000;
const base = new Date("2026-10-15T12:00:00Z");

beforeEach(() => {
	resetAlarmStateForTest();
});

describe("censusVerdict", () => {
	it("stays quiet inside the margin, at the steady readings production actually showed", () => {
		expect(censusVerdict(censusOf(8)).alert).toBeFalse();
		expect(censusVerdict(censusOf(9)).alert).toBeFalse();
		// Free slots exactly at the margin are quiet — 3 free is "fits, warn me below this".
		expect(censusVerdict(censusOf(19)).alert).toBeFalse();
	});

	it("alerts at and beyond the boundary, and the margin it names is the docblock's", () => {
		expect(censusVerdict(censusOf(20)).alert).toBeTrue();
		expect(censusVerdict(censusOf(22)).alert).toBeTrue();
		expect(FREE_SLOT_MARGIN).toBe(3);
	});
});

describe("fingerprintBackend", () => {
	it("sorts the pools the census email reports", () => {
		expect(fingerprintBackend("", "select * from pgboss.job fetch")).toBe("pg-boss pools");
		expect(fingerprintBackend("", "select pg_try_advisory_lock(1)")).toBe(
			"postgres-js (locked session)",
		);
		expect(fingerprintBackend("pool", "select 1")).toBe("pgbouncer");
		expect(fingerprintBackend("", "update works set title = $1")).toBe("postgres-js (app queries)");
	});
});

describe("runConnectionCensus", () => {
	it("a healthy run goes quiet: nothing sent, nothing alerted", async () => {
		const { send, calls } = recorder();
		const result = await runConnectionCensus(base, send, async () => censusOf(8));
		expect(result.alerted).toBeFalse();
		expect(result.ok).toBeTrue();
		expect(result.used).toBe(8);
		expect(calls).toHaveLength(0);
	});

	it("a near-exhausted cluster sends once, then is silent within the day, then re-arms after it", async () => {
		const { send, calls } = recorder();
		const first = await runConnectionCensus(base, send, async () => censusOf(21));
		expect(first.alerted).toBeTrue();
		expect(first.sent).toBeTrue();
		expect(calls).toHaveLength(1);
		expect(calls[0].subject).toContain("21 of 22 usable in use — 1 free");
		expect(calls[0].html).toContain("pg-boss pools");

		const withinDay = await runConnectionCensus(
			new Date(base.getTime() + 5 * HOUR),
			send,
			async () => censusOf(21),
		);
		expect(withinDay.alerted).toBeTrue();
		expect(withinDay.sent).toBeFalse();
		expect(calls).toHaveLength(1);

		const afterDay = await runConnectionCensus(
			new Date(base.getTime() + ALARM_COOLDOWN_MS + HOUR),
			send,
			async () => censusOf(21),
		);
		expect(afterDay.sent).toBeTrue();
		expect(calls).toHaveLength(2);
	});

	it("a cluster the census cannot read is the alarm, not a failed job", async () => {
		const { send, calls } = recorder();
		const boom = async () => {
			throw new Error("timeout exceeded when trying to connect");
		};
		const result = await runConnectionCensus(base, send, boom);
		expect(result.ok).toBeFalse();
		expect(result.alerted).toBeTrue();
		expect(result.sent).toBeTrue();
		expect(calls[0].subject).toContain("could not read the cluster");

		// The re-read failure inside the cooldown stays silent too.
		const second = await runConnectionCensus(new Date(base.getTime() + HOUR), send, boom);
		expect(second.alerted).toBeTrue();
		expect(second.sent).toBeFalse();
		expect(calls).toHaveLength(1);
	});
});

describe("isConnectionExhaustionError", () => {
	it("recognizes the messages production has actually produced", () => {
		expect(
			isConnectionExhaustionError(new Error("pg-pool: timeout exceeded when trying to connect")),
		).toBeTrue();
		expect(
			isConnectionExhaustionError(
				new Error(
					'remaining connection slots are reserved for roles with the "SUPERUSER" attribute',
				),
			),
		).toBeTrue();
		expect(
			isConnectionExhaustionError(new Error("FATAL: sorry, too many clients already")),
		).toBeTrue();
		expect(isConnectionExhaustionError(new Error('syntax error at or near "from"'))).toBeFalse();
		expect(
			isConnectionExhaustionError(new Error('relation "pgboss.job" does not exist')),
		).toBeFalse();
	});
});

describe("reportConnectionAlarm", () => {
	it("raises the alarm from a boss error and reads the census for the email, riding the same budget", async () => {
		const { send, calls } = recorder();
		const err = new Error("pg-pool: timeout exceeded when trying to connect");

		const first = await reportConnectionAlarm(err, base, send, async () => censusOf(21));
		expect(first.alerted).toBeTrue();
		expect(first.sent).toBeTrue();
		expect(calls[0].subject).toContain("21 of 22 usable in use");

		const second = await reportConnectionAlarm(
			err,
			new Date(base.getTime() + HOUR),
			send,
			async () => censusOf(21),
		);
		expect(second.alerted).toBeFalse();
		expect(second.sent).toBeFalse();
		expect(calls).toHaveLength(1);
	});

	it("still alarms when the pool complains while the cluster itself reports room", async () => {
		const { send, calls } = recorder();
		const err = new Error("pg-pool: timeout exceeded when trying to connect");
		const result = await reportConnectionAlarm(err, base, send, async () => censusOf(8));
		expect(result.alerted).toBeTrue();
		expect(calls[0].subject).toContain("pool connection failed");
		expect(calls[0].subject).toContain("8 of 22 usable");
		expect(calls[0].html).not.toContain("<table"); // the census table would hide the real complaint
	});
});

describe("the queue keeps the watch registered", () => {
	it("the census queue and its fifteen-minute cron exist", () => {
		expect(QUEUES.CONNECTION_CENSUS).toBe("connection-census");
		const entry = CRON_SCHEDULES.find(([q]) => q === QUEUES.CONNECTION_CENSUS);
		expect(entry).toBeDefined();
		expect(entry![1]).toBe("*/15 * * * *");
	});
});

describe("readCensus against the session database", () => {
	// The session Postgres's budget is 100 with 3 reserved, and a session holds a handful of
	// backends at most — far inside any alarm threshold, so this asserts the integration shape
	// (a real read that succeeds and stays quiet) without manufacturing load.
	afterAll(() => resetAlarmStateForTest());

	it("reads real limits and stays quiet", async () => {
		const census = await readCensus();
		expect(census.maxConnections).toBeGreaterThan(0);
		expect(census.usable).toBe(census.maxConnections - census.reserved);
		expect(census.used).toBeLessThan(census.usable);
	});
});

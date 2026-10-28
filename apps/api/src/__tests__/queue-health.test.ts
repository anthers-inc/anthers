// SPDX-License-Identifier: Apache-2.0
/**
 * The queue-failure report decides, and the tests assert the decisions rather than the sends.
 *
 * The suite covers the three moments that matter and would otherwise need a real burst: the
 * quiet run (a healthy queue produces no capture and no mail — silence is the signal), the
 * burst (one capture and one mail per alarming queue, with the numbers kept per queue), and
 * the tracker's one-per-day resurface rule, which the injected `due` stands in for so the
 * suite never waits a day or mails anybody.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	alarmingQueues,
	FAILED_ALERT_THRESHOLD,
	RETRY_ALERT_THRESHOLD,
	readQueueFailures,
	resetQueueAlarmStateForTest,
	runQueueFailureReport,
	summarizeQueueFailures,
} from "../jobs/queue-health.js";
import type { CaptureResult } from "../services/error-tracker.js";

const base = new Date("2026-10-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function recorder() {
	const calls: Array<{ subject: string; html: string }> = [];
	return {
		calls,
		send: async (args: { subject: string; html: string }) => {
			calls.push(args);
			return { sent: true };
		},
	};
}

function captureRecorder() {
	const messages: string[] = [];
	let n = 0;
	return {
		messages,
		capture: async (captured: { message: string }): Promise<CaptureResult> => {
			messages.push(captured.message);
			n += 1;
			return { firstSeen: true, fingerprint: `fingerprint-${n}`, count: 1 };
		},
	};
}

beforeEach(() => {
	resetQueueAlarmStateForTest();
});

afterAll(() => {
	resetQueueAlarmStateForTest();
});

describe("summarizeQueueFailures", () => {
	it("folds failed and retry rows into one line per queue, in name order", () => {
		expect(
			summarizeQueueFailures([
				{ queue: "render-paged", state: "failed", n: 11 },
				{ queue: "render-paged", state: "retry", n: 2 },
				{ queue: "process-audio", state: "retry", n: 1 },
			]),
		).toEqual([
			{ queue: "process-audio", failed: 0, retry: 1 },
			{ queue: "render-paged", failed: 11, retry: 2 },
		]);
	});

	it("ignores states the report does not page on", () => {
		expect(summarizeQueueFailures([{ queue: "x", state: "active", n: 9 }])).toEqual([
			{ queue: "x", failed: 0, retry: 0 },
		]);
	});
});

describe("alarmingQueues", () => {
	it("alarms on one exhausted job, because the queue will not retry it again", () => {
		expect(FAILED_ALERT_THRESHOLD).toBe(1);
		expect(alarmingQueues([{ queue: "render-paged", failed: 1, retry: 0 }])).toHaveLength(1);
	});

	it("leaves an ordinary retry alone and alarms on a burst", () => {
		expect(RETRY_ALERT_THRESHOLD).toBe(5);
		expect(alarmingQueues([{ queue: "q", failed: 0, retry: 4 }])).toHaveLength(0);
		expect(alarmingQueues([{ queue: "q", failed: 0, retry: 5 }])).toHaveLength(1);
	});

	it("is quiet on an empty read", () => {
		expect(alarmingQueues([])).toHaveLength(0);
	});
});

describe("runQueueFailureReport", () => {
	it("goes quiet when nothing has failed", async () => {
		const { send, calls } = recorder();
		const { capture, messages } = captureRecorder();
		const result = await runQueueFailureReport({
			now: base,
			read: async () => [],
			send,
			capture,
		});
		expect(result.ok).toBeTrue();
		expect(result.alarming).toEqual([]);
		expect(result.alerted).toBe(0);
		expect(result.sent).toBe(0);
		expect(calls).toHaveLength(0);
		expect(messages).toHaveLength(0);
	});

	it("captures and pages once per alarming queue, keeping each queue's own numbers", async () => {
		const { send, calls } = recorder();
		const { capture, messages } = captureRecorder();
		const result = await runQueueFailureReport({
			now: base,
			read: async () => [
				{ queue: "process-audio", failed: 0, retry: 1 },
				{ queue: "render-paged", failed: 11, retry: 2 },
			],
			send,
			capture,
			due: async () => true,
		});
		expect(result.ok).toBeTrue();
		expect(result.alarming.map((s) => s.queue)).toEqual(["render-paged"]);
		expect(result.alerted).toBe(1);
		expect(result.sent).toBe(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("render-paged");
		expect(calls).toHaveLength(1);
		expect(calls[0].subject).toContain("11 failed");
		// The queue with an ordinary retry is not in the page at all.
		expect(calls[0].html).not.toContain("process-audio");
	});

	it("records but stays silent while the tracker's resurface window is closed", async () => {
		const { send, calls } = recorder();
		const { capture, messages } = captureRecorder();
		const result = await runQueueFailureReport({
			now: base,
			read: async () => [{ queue: "render-paged", failed: 3, retry: 0 }],
			send,
			capture,
			due: async () => false,
		});
		expect(result.alerted).toBe(1);
		expect(result.sent).toBe(0);
		expect(messages).toHaveLength(1);
		expect(calls).toHaveLength(0);
	});

	it("mails directly when the evidence cannot be read, at most once a day", async () => {
		const { send, calls } = recorder();
		const read = async () => {
			throw new Error('relation "pgboss.job" does not exist');
		};
		const first = await runQueueFailureReport({ now: base, read, send });
		expect(first.ok).toBeFalse();
		expect(first.sent).toBe(1);
		expect(calls).toHaveLength(1);

		const second = await runQueueFailureReport({
			now: new Date(base.getTime() + 60 * 60 * 1000),
			read,
			send,
		});
		expect(second.sent).toBe(0);
		expect(calls).toHaveLength(1);

		const third = await runQueueFailureReport({
			now: new Date(base.getTime() + DAY + 1),
			read,
			send,
		});
		expect(third.sent).toBe(1);
		expect(calls).toHaveLength(2);
	});
});

describe("readQueueFailures", () => {
	it("reads the test session's own database without throwing", async () => {
		// A fresh session has never started pg-boss, so the answer is an empty list rather
		// than an error — the same guard the Admin console's jobs panel carries.
		await expect(readQueueFailures()).resolves.toEqual([]);
	});
});

// SPDX-License-Identifier: Apache-2.0
/**
 * A cron job obeys the retry budget its queue declares.
 *
 * 🚨 **`boss.schedule` never saw `JOB_OPTIONS`.** The wrapper passed no send options, so every
 * cron-enqueued job ran on pg-boss's defaults, `retryLimit` 2 with `retryDelay` 0. The three
 * sweeps that failed inside the 2026-10-28 rollout each spent all three attempts in 66
 * milliseconds while the fault cleared itself in about ninety seconds; a declared 120-second
 * delay would have carried them over it. The wiring assertion is here because the failure was
 * a missing argument, which no type checks.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CRON_SCHEDULES, cronSendOptions, JOB_OPTIONS } from "../jobs/queue";

describe("cron send options", () => {
	it("carries the retry budget a queue declares", () => {
		expect(cronSendOptions("access-receipts")).toEqual({ retryLimit: 2, retryDelay: 120 });
	});

	it("leaves an undeclared queue on the defaults it always had", () => {
		expect(cronSendOptions("settle-cycle")).toEqual({});
	});

	it("never carries a long handler's expiry or heartbeat onto a sweep", () => {
		// A cron job that wedged must be re-delivered on pg-boss's 15-minute default, not held for
		// the twelve hours a media job declares.
		for (const [queue] of CRON_SCHEDULES) {
			const keys = Object.keys(cronSendOptions(queue));
			expect(keys.filter((key) => !["retryDelay", "retryLimit"].includes(key))).toEqual([]);
		}
	});

	it("is what the schedule call actually passes", () => {
		const source = readFileSync(new URL("../jobs/queue.ts", import.meta.url), "utf8");
		expect(source).toContain("cronSendOptions(queue)");
		expect(source).toMatch(/boss\.schedule\(queue, cronExpr, data, cronSendOptions\(queue\)\)/);
	});

	it("covers the queue the 2026-10-28 failures came from", () => {
		// `access-receipts` declares the 120-second delay that would have carried its failed sweep
		// over the rollout; the schedule call now hands it that delay.
		expect(JOB_OPTIONS["access-receipts"]?.retryDelay).toBeGreaterThanOrEqual(60);
		expect(cronSendOptions("access-receipts").retryDelay).toBe(
			JOB_OPTIONS["access-receipts"]?.retryDelay,
		);
	});
});

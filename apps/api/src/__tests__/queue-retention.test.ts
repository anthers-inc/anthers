// SPDX-License-Identifier: Apache-2.0
/**
 * A finished job's row is deleted a day after it completes — on every queue, including the
 * queues that already existed when the policy changed.
 *
 * 🚨 **The silent half is `updateQueue`.** `createQueue` is `INSERT … ON CONFLICT DO NOTHING`,
 * so a queue that already exists keeps whatever retention it was born with. Dropping the
 * update call leaves production on pg-boss's seven-day default while a fresh database — which
 * is what every test and every session gets — looks exactly right. Nothing fails; the table
 * just grows, which is how the 28 MB and 76,654 completed rows this policy answers were found
 * on 2026-10-28. So the assertion is over both calls, per queue.
 */
import { describe, expect, it } from "bun:test";
import { ensureQueues, FINISHED_JOB_RETENTION, QUEUES } from "../jobs/queue";

/**
 * The queues the loop is expected to cover: every one this code uses, plus the internal one
 * pg-boss sends delayed jobs through. The latter is why the count is not simply `QUEUES`.
 */
const COVERED = [...Object.values(QUEUES), "__pgboss__send-it"];

type Call = { method: string; name: string; options?: object };

function recorder() {
	const calls: Call[] = [];
	return {
		calls,
		boss: {
			async createQueue(name: string, options?: object) {
				calls.push({ method: "createQueue", name, options });
			},
			async updateQueue(name: string, options?: object) {
				calls.push({ method: "updateQueue", name, options });
			},
		},
	};
}

describe("queue retention", () => {
	it("creates every queue and moves each one onto the retention policy", async () => {
		const { calls, boss } = recorder();
		await ensureQueues(boss);

		for (const name of COVERED) {
			expect(
				calls.some((c) => c.method === "createQueue" && c.name === name),
				`${name} is created`,
			).toBe(true);
			expect(
				calls.some((c) => c.method === "updateQueue" && c.name === name),
				`${name} is moved onto the retention policy`,
			).toBe(true);
		}
		expect(calls).toHaveLength(COVERED.length * 2);
	});

	it("passes the same retention to both calls", async () => {
		const { calls, boss } = recorder();
		await ensureQueues(boss);
		for (const call of calls) {
			expect(call.options).toEqual(FINISHED_JOB_RETENTION);
		}
	});

	it("keeps a finished job for a day, and leaves the unfinished window alone", () => {
		expect(FINISHED_JOB_RETENTION.deleteAfterSeconds).toBe(86_400);
		// A tightened `retentionSeconds` would delete work that a long outage queued rather
		// than stale history, so the created/retry window stays at pg-boss's default.
		expect("retentionSeconds" in FINISHED_JOB_RETENTION).toBe(false);
	});
});

// SPDX-License-Identifier: Apache-2.0
/**
 * The worker's schema guard: check before serving, watch while serving, stop once.
 *
 * 🚨 **What this file proves is the decision, not the deploy.** A real rollout cannot be
 * staged in a suite, but the two things that made the 2026-10-28 failures possible are
 * testable: a build behind the database must not serve, and a worker already serving must
 * stop the moment the database moves ahead of it. Both were absent, so three sweeps ran
 * against dropped columns and burned their retries in 66 milliseconds.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { type SchemaStandingReader, schemaStandingNow, watchSchema } from "../jobs/schema-guard";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the boot check", () => {
	it("tells a behind build apart from a current one", async () => {
		expect(await schemaStandingNow(async () => "build-behind")).toBe("build-behind");
		expect(await schemaStandingNow(async () => "current")).toBe("current");
	});

	it("serves when the read itself fails, because unknown is not evidence of a moved schema", async () => {
		const failing: SchemaStandingReader = async () => {
			throw new Error("connection refused");
		};
		expect(await schemaStandingNow(failing)).toBe("unknown");
	});
});

describe("the watch", () => {
	it("stops once when the database moves ahead, and keeps the interval alive", async () => {
		let stops = 0;
		const stop = watchSchema({
			read: async () => "build-behind",
			onBehind: () => {
				stops += 1;
			},
			intervalMs: 5,
			log: () => {},
		});
		await sleep(40);
		expect(stops).toBe(1);
		stop();
	});

	it("never stops a worker whose schema still matches", async () => {
		let stops = 0;
		const stop = watchSchema({
			read: async () => "current",
			onBehind: () => {
				stops += 1;
			},
			intervalMs: 5,
			log: () => {},
		});
		await sleep(40);
		stop();
		expect(stops).toBe(0);
	});

	it("never stops a worker on an unreadable schema", async () => {
		let stops = 0;
		const stop = watchSchema({
			read: async () => {
				throw new Error("no database");
			},
			onBehind: () => {
				stops += 1;
			},
			intervalMs: 5,
			log: () => {},
		});
		await sleep(40);
		stop();
		expect(stops).toBe(0);
	});

	it("logs the stand-down, so the reason is readable in the worker's log", async () => {
		const lines: string[] = [];
		const stop = watchSchema({
			read: async () => "build-behind",
			onBehind: () => {},
			intervalMs: 5,
			log: (line) => lines.push(line),
		});
		await sleep(40);
		stop();
		expect(lines.join(" ")).toContain("database has applied a migration this build does not ship");
	});
});

describe("the worker wires the guard in", () => {
	/**
	 * The guard's placement is what makes it work, and no runtime test can see it without a
	 * live rollout: the boot check must run before pg-boss starts, or the worker has already
	 * begun polling, and the watch must exist at all.
	 */
	const worker = readFileSync(new URL("../jobs/worker.ts", import.meta.url), "utf8");

	it("checks the standing before it starts the queue", () => {
		const check = worker.indexOf("await schemaStandingNow()");
		const queue = worker.indexOf("await ensureQueueReady()");
		expect(check).toBeGreaterThan(-1);
		expect(queue).toBeGreaterThan(-1);
		expect(check).toBeLessThan(queue);
	});

	it("stands down rather than exiting, and watches while serving", () => {
		expect(worker).toContain("holdForReplacement()");
		expect(worker).toContain("watchSchema({");
		expect(worker).toContain("queue.stop({ graceful: true, timeout: 120_000 })");
	});
});

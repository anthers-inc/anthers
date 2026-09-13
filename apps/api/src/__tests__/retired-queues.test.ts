// SPDX-License-Identifier: Apache-2.0
/**
 * A queue removed from the code is retired in the database too.
 *
 * 🚨 **pg-boss keeps a schedule after the code that registered it is gone**, so deleting a
 * cron from `CRON_SCHEDULES` leaves the row an earlier deployment wrote, and it goes on creating
 * jobs no worker listens for. `RETIRED_QUEUES` is what the worker unschedules and deletes on
 * boot. These assertions keep the two lists from overlapping — a live queue on the retired
 * list would be unscheduled on every boot straight after being scheduled — and keep the worker
 * calling `retire` at all, which no behavioral test can see without a live pg-boss.
 */
import { describe, expect, it } from "bun:test";
import { CRON_SCHEDULES, QUEUES, RETIRED_QUEUES } from "../jobs/queue";

describe("retired queues", () => {
	it("names the cross-publishing queues that were removed", () => {
		expect(RETIRED_QUEUES).toContain("cross-publish");
		expect(RETIRED_QUEUES).toContain("fetch-metrics");
	});

	it("🚨 never retires a queue the code still runs or schedules", () => {
		const live = new Set<string>(Object.values(QUEUES));
		const scheduled = new Set<string>(CRON_SCHEDULES.map(([name]) => name));
		for (const name of RETIRED_QUEUES) {
			expect(live.has(name), `${name} is still in QUEUES`).toBe(false);
			expect(scheduled.has(name), `${name} is still in CRON_SCHEDULES`).toBe(false);
		}
	});

	it("is retired by the worker on boot", async () => {
		const worker = await Bun.file(new URL("../jobs/worker.ts", import.meta.url)).text();
		expect(worker).toMatch(/for \(const \w+ of RETIRED_QUEUES\) await queue\.retire\(/);
	});
});

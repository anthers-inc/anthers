// SPDX-License-Identifier: Apache-2.0
/**
 * What the two sync jobs say in the worker log when the row they were asked about is gone.
 *
 * ⚠️ **Nothing, and that silence is the behavior under test.** Every end-to-end run enqueues syncs
 * through the real API against the dev database and then resets its fixtures, so the next
 * `make dev` worker drains a backlog of jobs for rows that no longer exist. Logging each one
 * buried the lines that mean something — a write, a removal, a broken server or credential —
 * under dozens of `skipped (no_row)`, which is exactly the log a person learns to skim.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { syncAtprotoRecordJob } from "../jobs/sync-atproto-record.js";
import { syncWorkListingJob } from "../jobs/sync-work-listing.js";

/** An id no row will ever have. */
const GONE = -1;

let logged: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
	logged = [];
	spies = (["log", "warn", "error"] as const).map((level) =>
		spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		}),
	);
});

afterEach(() => {
	for (const spy of spies) spy.mockRestore();
});

describe("a sync for a row that no longer exists", () => {
	it("is silent for every record kind", async () => {
		for (const kind of ["post", "project", "comment", "review", "vote", "follow"] as const) {
			await syncAtprotoRecordJob({ kind, id: GONE });
		}
		expect(logged).toEqual([]);
	});

	it("is silent for a Work's listing", async () => {
		await syncWorkListingJob({ workId: GONE });
		expect(logged).toEqual([]);
	});
});

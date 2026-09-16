// SPDX-License-Identifier: Apache-2.0
/**
 * Nothing that decides a billing month may read the machine's local calendar.
 *
 * 🚨 **A local-time reader and a UTC reader agree on almost every input, which is what makes
 * this class of bug survive.** `getFullYear`, `getMonth` and `getDate` answer in whatever zone
 * the process happens to be in; `getUTCFullYear` and friends do not. Five separate functions
 * computed the billing-cycle key by hand, all of them local, and they were safe only because
 * they were *uniformly* wrong — every one of them agreed with every other.
 *
 * ⚠️ **Unifying four of them to UTC is what made the fifth dangerous**, which is the lesson
 * worth keeping. Anchoring every account to the 1st set `accounts.current_period_start` to
 * exactly midnight UTC, and midnight UTC is the single input a local reader gets wrong **by a
 * whole month** in any zone behind it. `stickerCycleFor` then recorded Stickers against a cycle
 * `distribute-pool` would never pay — a supporter's money aimed at a creator, reaching nobody,
 * with every total still adding up.
 *
 * 🚨 **No test could have caught it, which is why this is a source scan rather than a test of
 * behavior.** `bun test` runs with no `TZ` and behaves as UTC, so a local reader and a UTC
 * reader are indistinguishable to the whole suite. See the public wiki's *Writing Tests That
 * Can Fail*.
 *
 * The rule is narrow on purpose: it covers the files that decide what month money belongs to,
 * not every file that touches a `Date`. A deadline counted in business days and a parental
 * control that resets at the viewer's local midnight are both legitimately local.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { stripComments } from "./node-env-guard.test.js";

/**
 * The files that decide which billing month something belongs to.
 *
 * ⚠️ **An allowlist rather than a denylist, deliberately.** A denylist over the whole tree
 * would have to carve out every legitimate local-time reader, and each carve-out is a place a
 * real violation can hide. Adding a file here is the cost of it becoming money-deciding, and
 * that is a moment somebody should have to think about.
 */
const CYCLE_FILES = [
	"apps/api/src/jobs/distribute-pool.ts",
	"apps/api/src/jobs/settle-cycle.ts",
	"apps/api/src/jobs/calculate-crf.ts",
	"apps/api/src/routes/subscriptions.ts",
	"apps/api/src/routes/payments.ts",
	"apps/api/src/services/billing.ts",
	"apps/api/src/services/access.ts",
	"apps/api/src/services/support-reductions.ts",
	"apps/api/src/services/public-access.ts",
	"apps/api/src/services/sticker-void.ts",
	"packages/shared/src/billing-cycle.ts",
] as const;

/** The local-time getters. Their `getUTC*` counterparts are the whole point and are fine. */
const LOCAL_GETTERS =
	/\.(getFullYear|getMonth|getDate|getHours|setMonth|setFullYear|setDate)\s*\(/g;

/** Every local-time getter call in `source`, comments stripped. */
export function localTimeCalls(source: string): string[] {
	return [...stripComments(source).matchAll(LOCAL_GETTERS)].map((m) => m[1] as string);
}

describe("no local-time calendar reads where money is assigned to a month", () => {
	it("🚨 still recognizes a local read when it sees one", () => {
		// A pattern that stopped matching would leave the scan below green while the rule it
		// enforces quietly stopped being enforced.
		expect(localTimeCalls("const y = d.getFullYear();")).toEqual(["getFullYear"]);
		expect(localTimeCalls("d.setMonth(d.getMonth() - 1);")).toEqual(["setMonth", "getMonth"]);
		// The UTC forms are what this rule exists to push people toward.
		expect(localTimeCalls("const y = d.getUTCFullYear();")).toEqual([]);
		expect(localTimeCalls("const m = d.getUTCMonth();")).toEqual([]);
		// Comments explaining the rule name the forbidden calls and must not trip it.
		expect(localTimeCalls("// never use d.getMonth() here")).toEqual([]);
	});

	it("reads every file it claims to, so a renamed path cannot pass silently", async () => {
		for (const path of CYCLE_FILES) {
			const file = Bun.file(join(process.cwd(), path));
			expect(await file.exists(), `${path} is listed here but does not exist`).toBe(true);
		}
	});

	it("🚨 finds none in the files that decide a billing month", async () => {
		const offenders: string[] = [];
		for (const path of CYCLE_FILES) {
			const source = await Bun.file(join(process.cwd(), path)).text();
			const calls = localTimeCalls(source);
			if (calls.length > 0) offenders.push(`${path}: ${[...new Set(calls)].join(", ")}`);
		}
		expect(
			offenders,
			"these read the machine's local calendar in a file that decides which month money belongs to. Use @anthers/shared/billing-cycle, whose readers are UTC — and note that no behavioral test can catch this, because the test runner is itself UTC",
		).toEqual([]);
	});
});

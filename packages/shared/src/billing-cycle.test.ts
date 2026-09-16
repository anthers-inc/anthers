// SPDX-License-Identifier: Apache-2.0
/**
 * What a month is, and what starting part-way into one costs.
 *
 * Two things are being pinned here and only one of them is arithmetic. The arithmetic is
 * `reductionFor`, which decides how much of somebody's next charge comes back to them. The
 * other is the **time zone**, which is not a detail once every account in the world renews on
 * the same day: four functions computed this key in local time while the crons that consume it
 * run in UTC, so on a machine behind UTC the last hours of a month keyed the month that had
 * already ended at Stripe. Those assertions are the ones that would have caught it.
 */
import { describe, expect, it } from "bun:test";
import type Decimal from "decimal.js";
import {
	cycleEnd,
	cycleKeyFor,
	cycleStart,
	dayOfCycle,
	daysInCycle,
	isCycleKey,
	nextCycleKey,
	reductionFor,
} from "./billing-cycle";

describe("the cycle key", () => {
	it("is the first of the month the moment falls in", () => {
		expect(cycleKeyFor(new Date("2026-09-15T12:00:00Z"))).toBe("2026-09-01");
		expect(cycleKeyFor(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
		expect(cycleKeyFor(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
	});

	it("pads a single-digit month, because the key is compared as a string", () => {
		// `2026-9-01` sorts before `2026-10-01` and after `2026-01-01`, so an unpadded key
		// would quietly reorder a board and break every `WHERE billing_cycle = …`.
		expect(cycleKeyFor(new Date("2026-09-15T12:00:00Z"))).toBe("2026-09-01");
		expect(isCycleKey(cycleKeyFor(new Date("2026-09-15T12:00:00Z")))).toBe(true);
	});

	/**
	 * The values a mid-boundary instant has to resolve to. `2026-10-01T02:00Z` is still 30
	 * September in Denver, where this repository is written, so a reader using `getMonth()`
	 * answers September while Stripe has already renewed into October.
	 *
	 * ⚠️ **This test cannot catch that on its own, and the one below is what does.** `bun
	 * test` runs with no `TZ` and behaves as UTC, so a local-time implementation satisfies
	 * every assertion here — it was confirmed by writing one and watching this pass. **Any
	 * date test in this repository has the same hole**: asserting a UTC answer under a UTC
	 * runner asserts nothing about which reader the code used.
	 */
	it("reads UTC, never the machine's local time", () => {
		expect(cycleKeyFor(new Date("2026-10-01T02:00:00Z"))).toBe("2026-10-01");
		expect(cycleKeyFor(new Date("2026-09-30T23:00:00Z"))).toBe("2026-09-01");
		// And the same instant expressed in a local offset resolves to the same key.
		expect(cycleKeyFor(new Date("2026-09-30T20:00:00-06:00"))).toBe("2026-10-01");
	});

	/**
	 * 🚨 **The assertion the four local-time copies actually fail**, and the only one in this
	 * file that does. It drives one instant through four zones spanning the date line and
	 * requires the answer not to move; a reader of local time disagrees with itself in at
	 * least one of them, whatever zone the suite started in. Bun applies a change to
	 * `process.env.TZ` to every `Date` built afterward, which is what makes this possible at
	 * all — and the `finally` puts it back, because leaking a zone would silently re-time
	 * every test that runs after this file.
	 */
	it("gives the same answer whatever zone the process is in", () => {
		const boundary = new Date("2026-10-01T02:00:00Z");
		const original = process.env.TZ;
		try {
			const answers = new Set<string>();
			for (const tz of ["UTC", "America/Denver", "Pacific/Kiritimati", "Pacific/Midway"]) {
				process.env.TZ = tz;
				answers.add(cycleKeyFor(boundary));
				answers.add(`${cycleKeyFor(new Date("2026-09-30T23:00:00Z"))}|prev`);
			}
			expect([...answers].sort()).toEqual(["2026-09-01|prev", "2026-10-01"]);
		} finally {
			if (original === undefined) delete process.env.TZ;
			else process.env.TZ = original;
		}
	});

	it("round-trips through its own start", () => {
		for (const key of ["2026-01-01", "2026-02-01", "2026-09-01", "2026-12-01"]) {
			expect(cycleKeyFor(cycleStart(key))).toBe(key);
		}
	});
});

describe("the cycle's bounds", () => {
	it("runs from its own 1st to the next, exclusive", () => {
		expect(cycleStart("2026-09-01").toISOString()).toBe("2026-09-01T00:00:00.000Z");
		expect(cycleEnd("2026-09-01").toISOString()).toBe("2026-10-01T00:00:00.000Z");
	});

	it("rolls the year over", () => {
		expect(cycleEnd("2026-12-01").toISOString()).toBe("2027-01-01T00:00:00.000Z");
		expect(nextCycleKey("2026-12-01")).toBe("2027-01-01");
	});

	it("counts the days this particular month has, never an average", () => {
		expect(daysInCycle("2026-09-01")).toBe(30);
		expect(daysInCycle("2026-10-01")).toBe(31);
		expect(daysInCycle("2026-02-01")).toBe(28);
		// 2028 is a leap year — the reduction on a February start depends on it.
		expect(daysInCycle("2028-02-01")).toBe(29);
	});

	it("numbers the day of the month from one", () => {
		expect(dayOfCycle(new Date("2026-09-01T00:00:00Z"))).toBe(1);
		expect(dayOfCycle(new Date("2026-09-20T18:30:00Z"))).toBe(20);
	});
});

describe("the day-exact reduction", () => {
	const dollars = (d: Decimal) => d.toFixed(2);

	it("owes nothing to somebody who started on the 1st", () => {
		expect(dollars(reductionFor(12, new Date("2026-09-01T09:00:00Z")))).toBe("0.00");
	});

	/**
	 * The worked example from the decision: a $10 creator line started on the 20th of a
	 * 30-day month is charged $10 that day, and the nineteen days before it are what comes
	 * off the 1st. `10 × 19 / 30 = 6.333…`, so $6.33.
	 */
	it("pays back the days of the month before the line began", () => {
		expect(dollars(reductionFor(10, new Date("2026-09-20T12:00:00Z")))).toBe("6.33");
	});

	it("is exact to the day rather than to a step", () => {
		// Consecutive days differ, which is the property that made half-month steps
		// unnecessary. A stepped reduction would report the same figure for both.
		const a = reductionFor(12, new Date("2026-09-10T00:00:00Z"));
		const b = reductionFor(12, new Date("2026-09-11T00:00:00Z"));
		expect(dollars(a)).not.toBe(dollars(b));
		expect(b.greaterThan(a)).toBe(true);
	});

	it("uses the days in that month, so the same day differs across months", () => {
		// The 16th of a 30-day month is half of it; the 16th of a 31-day month is not.
		expect(dollars(reductionFor(30, new Date("2026-09-16T00:00:00Z")))).toBe("15.00");
		expect(dollars(reductionFor(30, new Date("2026-10-16T00:00:00Z")))).toBe("14.52");
	});

	it("never owes back more than the line itself", () => {
		// The last day of the month is the worst case, and it is still short of the whole.
		const late = reductionFor(12, new Date("2026-09-30T23:00:00Z"));
		expect(late.lessThan(12)).toBe(true);
		expect(dollars(late)).toBe("11.60");
	});

	it("rounds to cents, because a discount is charged in cents", () => {
		const r = reductionFor(7, new Date("2026-09-14T00:00:00Z"));
		expect(r.decimalPlaces()).toBeLessThanOrEqual(2);
	});

	it("owes nothing on a line of nothing", () => {
		expect(dollars(reductionFor(0, new Date("2026-09-20T00:00:00Z")))).toBe("0.00");
	});
});

// SPDX-License-Identifier: Apache-2.0
/**
 * The threshold table transcribed and its window math, table-tested — the Playbook's threshold
 * table restated as assertions, one per state row, plus a resolution of every window kind at a
 * moment each kind makes interesting.
 *
 * 🚨 **The window rows are the load-bearing ones.** Every state counts against its own span, so
 * a window resolved one quarter or one year off silently moves a state's numbers between
 * windows rather than breaking anything — the exact failure a forecast is supposed to prevent.
 * Each kind is tested at a moment where the boundary is real (mid-year, mid-quarter, before and
 * after Connecticut's October 1).
 */
import { describe, expect, it } from "bun:test";
import {
	earliestWindowStart,
	STATE_THRESHOLDS,
	type StateThreshold,
	thresholdFor,
	windowFor,
} from "./sales-tax-thresholds.js";

/** An ISO instant, for the table. */
function at(iso: string): Date {
	return new Date(iso);
}

describe("STATE_THRESHOLDS — the Playbook's table", () => {
	it("carries one row per state the Playbook lists, keyed by code", () => {
		// 50 states plus DC and Puerto Rico, as the Playbook's table rows them.
		expect(STATE_THRESHOLDS.length).toBe(52);
		const codes = new Set(STATE_THRESHOLDS.map((r) => r.state));
		// Every state plus DC and Puerto Rico, as the Playbook's table rows them.
		for (const code of [
			"AL",
			"AK",
			"AZ",
			"AR",
			"CA",
			"CO",
			"CT",
			"DE",
			"DC",
			"FL",
			"GA",
			"HI",
			"ID",
			"IL",
			"IN",
			"IA",
			"KS",
			"KY",
			"LA",
			"ME",
			"MD",
			"MA",
			"MI",
			"MN",
			"MS",
			"MO",
			"MT",
			"NE",
			"NV",
			"NH",
			"NJ",
			"NM",
			"NY",
			"NC",
			"ND",
			"OH",
			"OK",
			"OR",
			"PA",
			"PR",
			"RI",
			"SC",
			"SD",
			"TN",
			"TX",
			"UT",
			"VT",
			"VA",
			"WA",
			"WV",
			"WI",
			"WY",
		]) {
			expect(codes.has(code), `missing ${code}`).toBe(true);
		}
	});

	it("marks Colorado as the home state with no threshold, and the four no-sales-tax states", () => {
		const co = thresholdFor("CO") as StateThreshold;
		expect(co.homeState).toBe(true);
		expect(co.dollarThreshold).toBeNull();
		for (const code of ["DE", "MT", "NH", "OR"]) {
			const row = thresholdFor(code) as StateThreshold;
			expect(row.noSalesTax, `${code} should be a no-sales-tax state`).toBe(true);
			expect(row.dollarThreshold).toBeNull();
			expect(row.transactionThreshold).toBeNull();
		}
	});

	it("transcribes the headline thresholds the forecast turns on", () => {
		expect(thresholdFor("OK")?.dollarThreshold).toBe(10_000);
		expect(thresholdFor("OK")?.effectivelyAlwaysOn).toBe(true);
		expect(thresholdFor("CA")?.dollarThreshold).toBe(500_000);
		expect(thresholdFor("NY")?.dollarThreshold).toBe(500_000);
		expect(thresholdFor("NY")?.transactionThreshold).toBe(100);
		expect(thresholdFor("NY")?.relation).toBe("and");
		expect(thresholdFor("CT")?.relation).toBe("and");
		expect(thresholdFor("TX")?.dollarThreshold).toBe(500_000);
		expect(thresholdFor("AL")?.dollarThreshold).toBe(250_000);
		expect(thresholdFor("MS")?.dollarThreshold).toBe(250_000);
	});

	it("carries the transaction prong with its relation where the Playbook gives one", () => {
		// The OR states with a live tx prong — the real tripwire at Anthers' ticket sizes.
		const orWithTx = STATE_THRESHOLDS.filter((r) => r.relation === "or");
		for (const row of orWithTx) {
			expect(row.transactionThreshold, `${row.state} should carry a tx threshold`).not.toBeNull();
			expect(row.dollarThreshold).not.toBeNull();
		}
		// Repealed or never-had tx prongs carry no relation to misread.
		for (const code of ["IL", "KY", "NC", "UT", "GA"]) {
			const row = thresholdFor(code) as StateThreshold;
			expect(row.transactionThreshold, `${code}'s tx prong is gone`).toBeNull();
			expect(row.relation).toBeNull();
		}
	});

	it("flags exactly the rows the Playbook marks unverified", () => {
		const unverified = STATE_THRESHOLDS.filter((r) => !r.verified).map((r) => r.state);
		expect(unverified).toEqual(["KY", "MI"]);
		// Michigan keeps its tx prong meanwhile — a live prong is the expensive direction to be wrong in.
		const mi = thresholdFor("MI") as StateThreshold;
		expect(mi.transactionThreshold).toBe(200);
		expect(mi.relation).toBe("or");
	});
});

describe("windowFor — each measurement window, resolved", () => {
	it("returns null for the home state and the no-sales-tax states", () => {
		const now = at("2026-06-15T12:00:00Z");
		expect(windowFor("CO", now)).toBeNull();
		expect(windowFor("OR", now)).toBeNull();
		expect(windowFor("ZZ", now)).toBeNull();
	});

	it("resolves the current-or-prior-calendar-year window as the current calendar year", () => {
		const w = windowFor("AZ", at("2026-06-15T12:00:00Z"));
		expect(w).not.toBeNull();
		expect(w!.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
		expect(w!.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
	});

	it("resolves the previous-calendar-year window to last year, so January can start already over", () => {
		const w = windowFor("FL", at("2026-06-15T12:00:00Z"));
		expect(w!.start.toISOString()).toBe("2025-01-01T00:00:00.000Z");
		expect(w!.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("resolves the plain trailing-12-months window back to the same calendar day", () => {
		const w = windowFor("OK", at("2026-06-15T12:00:00Z"));
		expect(w!.start.toISOString()).toBe("2025-06-15T12:00:00.000Z");
		expect(w!.end.toISOString()).toBe("2026-06-15T12:00:00.000Z");
		// February-29 rollover: the leap day has no counterpart twelve months earlier, so it
		// lands on March 1 — one day early rather than one day late, which is the safe
		// direction (a window that starts slightly later never misses a sale).
		const leap = windowFor("OK", at("2024-02-29T00:00:00Z"));
		expect(leap!.start.toISOString()).toBe("2023-03-01T00:00:00.000Z");
	});

	it("ends the quarterly-reviewed windows at the most recent quarter boundary, not at now", () => {
		// Illinois, mid-Q3: the window ends at July 1, not at the current day.
		const il = windowFor("IL", at("2026-08-15T12:00:00Z"));
		expect(il!.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
		expect(il!.start.toISOString()).toBe("2025-07-01T00:00:00.000Z");
		// Missouri, same kind.
		const mo = windowFor("MO", at("2026-02-15T12:00:00Z"));
		expect(mo!.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
		expect(mo!.start.toISOString()).toBe("2025-01-01T00:00:00.000Z");
		// Minnesota, same quarter-end arithmetic under its own kind.
		const mn = windowFor("MN", at("2026-08-15T12:00:00Z"));
		expect(mn!.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
		expect(mn!.start.toISOString()).toBe("2025-07-01T00:00:00.000Z");
	});

	it("ends Connecticut's window at the Sept 30 that has most recently passed", () => {
		// Before Oct 1: the window is the 12 months ending last Sept 30.
		const summer = windowFor("CT", at("2026-06-15T12:00:00Z"));
		expect(summer!.end.toISOString()).toBe("2025-10-01T00:00:00.000Z");
		expect(summer!.start.toISOString()).toBe("2024-10-01T00:00:00.000Z");
		// From Oct 1: the new window — cross both prongs by the next Sept 30, duty begins Oct 1.
		const october = windowFor("CT", at("2026-10-01T00:00:00Z"));
		expect(october!.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
		expect(october!.start.toISOString()).toBe("2025-10-01T00:00:00.000Z");
	});

	it("resolves New York's four preceding sales-tax quarters", () => {
		const w = windowFor("NY", at("2026-08-15T12:00:00Z"));
		expect(w!.start.toISOString()).toBe("2025-07-01T00:00:00.000Z");
		expect(w!.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
	});

	it("resolves Puerto Rico's fiscal-year window as the calendar year, for Anthers", () => {
		const w = windowFor("PR", at("2026-06-15T12:00:00Z"));
		expect(w!.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
		expect(w!.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
	});

	it("answers for every state that carries a window, with a span that is real", () => {
		for (const row of STATE_THRESHOLDS) {
			const w = windowFor(row.state, at("2026-06-15T12:00:00Z"));
			if (row.window === "none") {
				expect(w, `${row.state} has no window`).toBeNull();
				continue;
			}
			expect(w, `${row.state} resolved no window`).not.toBeNull();
			expect(w!.start.getTime()).toBeLessThan(w!.end.getTime());
		}
	});

	it("gives the widest reach as January 1 of last year — the fetch floor for every state", () => {
		expect(earliestWindowStart(at("2026-06-15T12:00:00Z")).toISOString()).toBe(
			"2025-01-01T00:00:00.000Z",
		);
	});
});

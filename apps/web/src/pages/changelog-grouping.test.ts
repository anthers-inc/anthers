// SPDX-License-Identifier: Apache-2.0
//
// The changelog page's month grouping, pinned. Lives beside the page it tests, like
// `finish-face.test.ts` beside FinishSignupPage: the grouping is a pure function on the
// page module, testable directly.
//
// 🚨 **Why a test, and why synthetic fixtures.** The grouping exists so a `####.##.0`
// release and the `####.##.1` / `####.##.2` hotfixes after it read as one month's full
// set of changes. The live `CHANGELOG` cannot express that yet — its one release has a
// month to itself — so a test written only against live data would pass a grouping
// that splits per release, which is exactly the behavior this task replaced. The
// synthetic fixtures below carry the shape the page exists for.
//
// ⚠️ **The grouping is derived, so it can drift.** `changelog.ts` carries no month
// field on purpose (the exporter must not have to reproduce one), which makes
// `groupedByMonth` the only place that decides what a month is. A change to it — a
// different cut of the date, a version-derived month instead of a date-derived one —
// changes the page's structure in a way no typecheck can see.

import { describe, expect, it } from "bun:test";
import type { ChangelogRelease } from "../content/changelog";
import { CHANGELOG } from "../content/changelog";
import { groupedByMonth } from "./ChangelogPage";

/** A minimal entry carrying only what the grouping reads, unless a test extends it. */
const release = (version: string, date: string): ChangelogRelease => ({
	version,
	date,
	lede: `${version}.`,
	entries: [`Shipped in ${version}.`],
});

describe("groupedByMonth folds the changelog into months, newest first", () => {
	it("puts the .0/.1/.2 releases of one month under one section, dividers preserving each version", () => {
		const months = groupedByMonth([
			release("2026.10.2", "2026-10-18"),
			release("2026.10.1", "2026-10-09"),
			release("2026.10.0", "2026-10-02"),
			release("2026.09.0", "2026-09-11"),
		]);

		expect(months.map((m) => m.label)).toEqual(["October 2026", "September 2026"]);
		expect(months[0].releases.map((r) => r.version)).toEqual([
			"2026.10.2",
			"2026.10.1",
			"2026.10.0",
		]);
		expect(months[1].releases.map((r) => r.version)).toEqual(["2026.09.0"]);
	});

	it("derives the month from the entry's date, not the version — a release shipping into the next month lands where it shipped", () => {
		// The case that decides it: a `####.##.5` numbered for one month that ships early
		// in the next. A version-derived grouping files it under its number's month, where
		// the user can't find it by when it shipped.
		const months = groupedByMonth([
			release("2026.10.5", "2026-11-02"),
			release("2026.10.0", "2026-10-02"),
		]);

		expect(months.map((m) => m.label)).toEqual(["November 2026", "October 2026"]);
		expect(months[0].releases.map((r) => r.version)).toEqual(["2026.10.5"]);
	});

	it("labels every month of the year correctly, not just the ones the live data names", () => {
		const monthNumbers = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
		// Newest first, so December leads.
		const months = groupedByMonth(
			monthNumbers.reverse().map((mm) => release(`2026.${Number(mm)}.0`, `2026-${mm}-15`)),
		);
		// The full year renders with the right names — a typo in a month the page has
		// never shown would otherwise sit silently until that month arrives.
		expect(months.map((m) => m.label)).toEqual([
			"December 2026",
			"November 2026",
			"October 2026",
			"September 2026",
			"August 2026",
			"July 2026",
			"June 2026",
			"May 2026",
			"April 2026",
			"March 2026",
			"February 2026",
			"January 2026",
		]);
	});

	it("keeps the live changelog folded correctly — every release of the real data under its own month, newest first", () => {
		const months = groupedByMonth();

		// Every release appears exactly once, in `CHANGELOG`'s own order within its month.
		const versions = months.flatMap((m) => m.releases.map((r) => r.version));
		expect(versions).toEqual(CHANGELOG.map((r) => r.version));
	});

	it("makes each month's key and releases agree — no release filed under a month its date does not name", () => {
		for (const month of groupedByMonth()) {
			for (const r of month.releases) {
				expect(`${month.label} ← ${r.version} (${r.date.slice(0, 7)})`).toBe(
					`${month.label} ← ${r.version} (${month.key})`,
				);
			}
		}
	});
});

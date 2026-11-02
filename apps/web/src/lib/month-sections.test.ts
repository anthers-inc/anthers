// SPDX-License-Identifier: Apache-2.0
/**
 * The creator profile's month grouping.
 *
 * The two rules a reader notices are the ones pinned here: a month with nothing in it
 * gains no heading, and a stretch of empty months is one spacer rather than one per
 * month. The renderer draws what this returns, so a defect here is a timeline that
 * says the wrong thing about when a creator published.
 */
import { describe, expect, it } from "bun:test";
import { monthSections } from "./month-sections";

interface Item {
	title: string;
	date: string;
}

/** A local-midday timestamp, so the month it groups into is the same in every timezone. */
const at = (year: number, month: number, day = 10): string =>
	new Date(year, month, day, 12).toISOString();

const item = (title: string, date: string): Item => ({ title, date });

describe("monthSections", () => {
	it("groups a month's entries together and orders months newest first", () => {
		const sections = monthSections(
			[
				item("october", at(2026, 9, 1)),
				item("november early", at(2026, 10, 2)),
				item("november late", at(2026, 10, 20)),
			],
			(i) => i.date,
		);

		expect(sections.map((section) => section.kind)).toEqual(["month", "month"]);
		const [newest, oldest] = sections;
		expect(newest).toMatchObject({ key: "2026-11", label: "November 2026", kind: "month" });
		if (newest.kind !== "month" || oldest.kind !== "month") throw new Error("expected months");
		expect(newest.items.map((i) => i.title)).toEqual(["november late", "november early"]);
		expect(oldest.items.map((i) => i.title)).toEqual(["october"]);
	});

	it("puts a spacer where one month had nothing, and no heading for that month", () => {
		const sections = monthSections(
			[item("october", at(2026, 9, 4)), item("august", at(2026, 7, 9))],
			(i) => i.date,
		);

		expect(sections.map((section) => section.kind)).toEqual(["month", "gap", "month"]);
		expect(sections[1]).toMatchObject({
			kind: "gap",
			label: "No content in September 2026",
			months: ["September 2026"],
		});
		// The next heading is the next month that actually had content.
		if (sections[2].kind !== "month") throw new Error("expected a month");
		expect(sections[2].label).toBe("August 2026");
	});

	it("collapses consecutive empty months into one spacer naming the span", () => {
		const sections = monthSections(
			[item("newest", at(2026, 10, 2)), item("oldest", at(2026, 7, 2))],
			(i) => i.date,
		);

		expect(sections.map((section) => section.kind)).toEqual(["month", "gap", "month"]);
		expect(sections[1]).toMatchObject({
			kind: "gap",
			label: "No content from September 2026 to October 2026",
			months: ["October 2026", "September 2026"],
		});
	});

	it("draws no spacer before the newest month or after the oldest", () => {
		const oneMonth = monthSections([item("only", at(2026, 10, 2))], (i) => i.date);
		expect(oneMonth.map((section) => section.kind)).toEqual(["month"]);

		const adjacent = monthSections(
			[item("newer", at(2026, 10, 2)), item("older", at(2026, 9, 2))],
			(i) => i.date,
		);
		expect(adjacent.map((section) => section.kind)).toEqual(["month", "month"]);
	});

	it("walks the calendar across a year boundary", () => {
		const adjacent = monthSections(
			[item("january", at(2026, 0, 2)), item("december", at(2025, 11, 2))],
			(i) => i.date,
		);
		expect(adjacent.map((section) => section.kind)).toEqual(["month", "month"]);

		const skipped = monthSections(
			[item("january", at(2026, 0, 2)), item("november", at(2025, 10, 2))],
			(i) => i.date,
		);
		expect(skipped.map((section) => section.kind)).toEqual(["month", "gap", "month"]);
		expect(skipped[1]).toMatchObject({
			kind: "gap",
			label: "No content in December 2025",
		});
	});

	it("trails entries with no date under their own heading instead of dropping them", () => {
		const sections = monthSections(
			[item("dated", at(2026, 10, 2)), item("no date", ""), item("unparseable", "some other day")],
			(i) => i.date,
		);

		expect(sections.map((section) => section.kind)).toEqual(["month", "undated"]);
		const undated = sections[1];
		if (undated.kind !== "undated") throw new Error("expected an undated section");
		expect(undated.label).toBe("Undated");
		expect(undated.items.map((i) => i.title)).toEqual(["no date", "unparseable"]);
	});

	it("returns nothing for an empty list", () => {
		expect(monthSections([], (i: Item) => i.date)).toEqual([]);
	});
});

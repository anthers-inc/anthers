// SPDX-License-Identifier: Apache-2.0
/**
 * The Badges and Time tabs' structural contract after the 2026-11-12 rework.
 *
 * The pieces Parker asked for are mostly arrangements rather than behaviors: one collection
 * with Anthers first, the All Badges selection, the details section and its
 * Multiple-Badges-Selected state, and the Time Pool moving to its own tab with the activity
 * record following the month above it. Each is a decision a refactor can quietly undo while
 * every card still renders, so each is pinned here — the same source-text guard family as
 * `two-tabs.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const badges = read("BadgesSection.tsx");
const timePool = read("TimePoolSection.tsx");
const activity = read("ActivityDetailsSection.tsx");
const settings = read("../../pages/SettingsPage.tsx");

describe("the Badges tab is one collection", () => {
	it("puts the Anthers tile before the creator tiles", () => {
		expect(badges).toContain('name="Anthers"');
		expect(badges.indexOf('name="Anthers"')).toBeLessThan(badges.indexOf("{creatorBadges.map"));
	});

	it("offers the whole collection as one wide control", () => {
		expect(badges).toContain("All Badges");
		expect(badges).toContain('aria-pressed={selected === "all"}');
	});

	it("keeps the details section and its all-badges state", () => {
		expect(badges).toContain("Badge Details");
		expect(badges).toContain("Multiple Badges Selected");
	});

	it("draws the rolling five-month row from the server's charge record", () => {
		expect(badges).toContain("badge-months");
		expect(badges).toContain("Monthly Charges");
		expect(badges).toContain("Estimated");
		expect(badges).toContain("prorate");
	});

	it("no longer carries the Time Pool table", () => {
		expect(badges).not.toContain("Where Your Month Went");
		expect(badges).not.toContain("cycleTableTotals");
	});
});

describe("the Time tab owns the pool and the activity record", () => {
	it("is a tab below Purchases", () => {
		expect(settings).toContain('{ id: "time", label: "Time" }');
		const purchases = settings.indexOf('{ id: "purchases"');
		const time = settings.indexOf('{ id: "time"');
		const identity = settings.indexOf('{ id: "identity"');
		expect(purchases).toBeLessThan(time);
		expect(time).toBeLessThan(identity);
	});

	it("renders the pool above the activity record from one month", () => {
		expect(settings).toContain("<TimeSection />");
		expect(settings).toContain('id: "time"');
		expect(settings).toContain("<TimePoolSection cycle={cycle}");
		expect(settings).toContain("<ActivityDetailsSection cycle={cycle} />");
	});

	it("shows the by-time and directed halves of the same pool", () => {
		expect(timePool).toContain("Directed by You");
		expect(timePool).toContain("timePoolTotals");
		expect(timePool).toContain("stickerAmount");
	});

	it("renames the record and stops carrying its own month control", () => {
		expect(activity).toContain("Activity Details");
		expect(activity).not.toContain("This billing period");
		expect(activity).not.toContain("previousCycleKey");
		expect(activity).toContain("export default function ActivityDetailsSection({ cycle }");
	});

	it("leaves the activity record out of Activity & Data", () => {
		expect(settings).not.toContain("<ActivityHistorySection");
	});
});

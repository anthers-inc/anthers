// SPDX-License-Identifier: Apache-2.0
/**
 * The Badges tab's structural contract after the 2026-11-10 cleanup.
 *
 * Two of the changes Parker asked for are absences rather than features — the ladder chips
 * under a held Badge, and the creator-earnings card on a supporter's page — and neither has
 * a behavior a test can exercise. Pinning them as source facts is the same guard the
 * two-tab rework uses (`../pages/two-tabs.test.ts`): each is a decision a refactor can
 * quietly undo, and the card would keep rendering while it did.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const badges = read("BadgesSection.tsx");
const studioSettings = read("../../../../../packages/web-shared/src/pages/StudioSettingsPage.tsx");

describe("a held Badge card shows the Badge held", () => {
	it("does not repeat the creator's whole ladder as chips", () => {
		expect(badges).not.toContain("row.rungs.map");
		expect(badges).not.toContain("badge badge-xs");
	});

	it("still finds the held rung's position for the emblem it draws", () => {
		expect(badges).toContain("row.rungs.findIndex");
	});
});

describe("the month table totals its own columns", () => {
	it("reads every total from the one arithmetic module", () => {
		expect(badges).toContain("cycleTableTotals");
	});

	it("ends with a Totals row and no Time-Pool-only tail", () => {
		expect(badges).toContain(">Totals</span>");
		expect(badges).not.toContain("Time Pool total");
	});
});

describe("creator earnings live in Creator Settings", () => {
	it("the Badges tab neither fetches nor renders them", () => {
		expect(badges).not.toContain("Your Creator Earnings");
		expect(badges).not.toContain("subscriptions.earnings");
	});

	it("the Creator Settings page carries the card", () => {
		expect(studioSettings).toContain("Your Creator Earnings");
		expect(studioSettings).toContain("subscriptions.earnings");
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The supporters page publishes names and an order, and never a number.
 *
 * 🚨 **The property under test is what the page CANNOT be read to say.** Every assertion
 * here is about disclosure rather than layout: no amount reaches the output, no group is
 * small enough to identify one person's bracket, and no ordering inside a group re-encodes
 * the figure the bands exist to withhold.
 */
import { describe, expect, it } from "bun:test";
import {
	groupSupporters,
	MIN_BAND_SIZE,
	SUPPORTER_BAND_THRESHOLDS,
	sortSupporters,
	supporterBand,
} from "./supporters";

const person = (displayName: string, lifetimeDollars: number) => ({
	username: displayName.toLowerCase(),
	displayName,
	lifetimeDollars,
});

describe("grouping supporters", () => {
	it("puts a bigger lifetime total in an earlier group", () => {
		expect(supporterBand(1000)).toBeLessThan(supporterBand(100));
		expect(supporterBand(100)).toBeLessThan(supporterBand(1));
		// The thresholds are inclusive at the boundary, so landing exactly on one promotes.
		for (const t of SUPPORTER_BAND_THRESHOLDS) {
			expect(supporterBand(t)).toBeLessThan(supporterBand(t - 0.01));
		}
	});

	it("🚨 never publishes an amount — the output carries names only", () => {
		const groups = groupSupporters([
			person("Ada", 900),
			person("Grace", 800),
			person("Linus", 700),
			person("Ken", 5),
			person("Bjarne", 4),
			person("Alan", 3),
		]);
		for (const group of groups) {
			for (const entry of group) {
				expect(Object.keys(entry).sort()).toEqual(["displayName", "username"]);
			}
		}
	});

	it("🚨 never renders a group small enough to name one person's bracket", () => {
		// One big giver and a crowd below. A band of one would say exactly what that person
		// gave, which is the disclosure the bands exist to avoid.
		const groups = groupSupporters([
			person("Solo", 10_000),
			...Array.from({ length: 8 }, (_, i) => person(`Person${i}`, 1)),
		]);
		for (const group of groups) expect(group.length).toBeGreaterThanOrEqual(MIN_BAND_SIZE);
		// And they are still on the page — merged downward, never dropped.
		expect(groups.flat().some((e) => e.displayName === "Solo")).toBe(true);
	});

	it("⭐ merges downward, so a merge can only ever understate what somebody gave", () => {
		const groups = groupSupporters([
			person("Big", 10_000),
			person("Mid1", 200),
			person("Mid2", 200),
			person("Mid3", 200),
		]);
		// The lone top-band giver joins the group below rather than standing alone above it.
		expect(groups).toHaveLength(1);
		expect(groups[0].map((e) => e.displayName)).toContain("Big");
	});

	it("sorts inside a group alphabetically, never by amount", () => {
		const groups = groupSupporters([person("Zoe", 900), person("adam", 800), person("Mary", 700)]);
		// `adam` gave less than `Zoe` and still comes first — case-insensitively.
		expect(groups[0].map((e) => e.displayName)).toEqual(["adam", "Mary", "Zoe"]);
	});

	it("falls back to the username when somebody has no display name", () => {
		const sorted = sortSupporters([
			{ username: "zed", displayName: null },
			{ username: "amy", displayName: null },
		]);
		expect(sorted.map((e) => e.username)).toEqual(["amy", "zed"]);
	});

	it("returns nothing at all rather than empty groups when nobody is listed", () => {
		expect(groupSupporters([])).toEqual([]);
	});
});

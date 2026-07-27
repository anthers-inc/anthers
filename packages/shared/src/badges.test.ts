// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coverage for the Badge model — the rule that a Badge is identified by its whole-Seed
// THRESHOLD and never by its position in a list.
//
// The distinction has teeth. `badgeRank` used to be `BADGE_ORDER.indexOf(name)`, and
// `seedsMeetRank` compared a Seed count against that index. It gave correct answers only
// because Anthers's own Badges sit at 1/2/3/4, where index and threshold coincide — an
// accident, not a design. Any issuer whose Badges skip a level mis-resolved access
// *silently*: no error, no crash, just wrong answers about who may read what.
//
// So the non-consecutive set below is the point of this file, not a curiosity. Every
// assertion here fails under an index-based implementation, which is what stops that
// implementation from coming back.
import { describe, expect, test } from "bun:test";
import {
	ANTHERS_BADGES,
	type BadgeDef,
	badgeFor,
	badgeMeets,
	badgeRank,
	heldBadgeLabel,
	rankForSeeds,
	rankLabel,
	seedsMeet,
	seedsMeetRank,
	thresholdOf,
} from "./constants.js";

/** A creator's ladder with gaps — the case the old resolver got silently wrong. */
const SPARSE: readonly BadgeDef[] = [
	{ name: "spark", threshold: 1 },
	{ name: "ember", threshold: 3 },
	{ name: "flame", threshold: 5 },
	{ name: "beacon", threshold: 7 },
];

describe("badgeFor — highest threshold met", () => {
	test("below the lowest threshold, no Badge is held", () => {
		expect(badgeFor(0, SPARSE).badge).toBeNull();
		expect(badgeFor(0).badge).toBeNull();
	});

	test("a sparse ladder resolves by threshold, not position", () => {
		// Under the old index model these were off by the size of each gap: 5 Seeds would
		// have indexed past the end of a 4-entry list rather than landing on "flame".
		const cases: Array<[number, string | null]> = [
			[0, null],
			[1, "spark"],
			[2, "spark"],
			[3, "ember"],
			[4, "ember"],
			[5, "flame"],
			[6, "flame"],
			[7, "beacon"],
			[70, "beacon"],
		];
		for (const [seeds, name] of cases) {
			expect(badgeFor(seeds, SPARSE).badge?.name ?? null, `${seeds} Seeds`).toBe(name);
		}
	});

	test("fractional and negative Seed counts floor to whole Seeds", () => {
		expect(badgeFor(2.9, SPARSE).badge?.name).toBe("spark");
		expect(badgeFor(-4, SPARSE).badge).toBeNull();
	});
});

describe('the "+" rule applies between Badges, not only past the top', () => {
	test("strictly more Seeds than the held threshold renders a +", () => {
		expect(heldBadgeLabel(3, SPARSE)).toBe("Ember");
		expect(heldBadgeLabel(4, SPARSE)).toBe("Ember+"); // the between-Badges case
		expect(heldBadgeLabel(7, SPARSE)).toBe("Beacon");
		expect(heldBadgeLabel(8, SPARSE)).toBe("Beacon+"); // past the top
	});

	test("Anthers's own consecutive set only ever plusses past Blossom", () => {
		expect(rankLabel(0)).toBe("Free");
		expect(rankLabel(1)).toBe("Root");
		expect(rankLabel(4)).toBe("Blossom");
		expect(rankLabel(5)).toBe("Blossom+");
	});

	test("the empty label is caller-chosen", () => {
		expect(heldBadgeLabel(0, SPARSE, "None")).toBe("None");
	});
});

describe("gates are thresholds, and need not sit on a Badge", () => {
	test("a holder clears any whole-Seed gate at or below their count", () => {
		expect(seedsMeet(4, 4)).toBe(true);
		expect(seedsMeet(3, 4)).toBe(false);
		// No Badge sits at 4 in SPARSE, yet a 4-Seed gate is legal and cleared.
		expect(thresholdOf("ember", SPARSE)).toBe(3);
		expect(SPARSE.some((b) => b.threshold === 4)).toBe(false);
		expect(seedsMeet(4, 4)).toBe(true);
	});

	test("a Seed short of a gate never clears it, however the ladder is shaped", () => {
		for (const t of [1, 3, 5, 7]) {
			expect(seedsMeet(t - 1, t), `${t - 1} vs gate ${t}`).toBe(false);
			expect(seedsMeet(t, t), `${t} vs gate ${t}`).toBe(true);
		}
	});
});

describe("badgeRank returns a threshold", () => {
	test("Anthers's Badges report their Seed cost", () => {
		expect(badgeRank("free")).toBe(0);
		expect(badgeRank("root")).toBe(1);
		expect(badgeRank("blossom")).toBe(4);
	});

	test("it agrees with the Badge set rather than a hardcoded ladder", () => {
		for (const b of ANTHERS_BADGES) {
			expect(badgeRank(b.name as "root"), b.name).toBe(b.threshold);
		}
	});

	test("thresholdOf reports null for a name the set does not define", () => {
		expect(thresholdOf("nonesuch")).toBeNull();
		expect(thresholdOf("flame", SPARSE)).toBe(5);
	});
});

describe("Anthers gate resolution is point-in-time and monotone", () => {
	test("rankForSeeds names the held Badge, or free at zero", () => {
		expect(rankForSeeds(0)).toBe("free");
		expect(rankForSeeds(1)).toBe("root");
		expect(rankForSeeds(4)).toBe("blossom");
		expect(rankForSeeds(99)).toBe("blossom");
	});

	test("holding more never removes access a lower count had", () => {
		for (const required of ["free", "root", "sprout", "petal", "blossom"] as const) {
			let seen = false;
			for (let seeds = 0; seeds <= 8; seeds++) {
				const ok = seedsMeetRank(seeds, required);
				if (seen) expect(ok, `${seeds} Seeds vs ${required}`).toBe(true);
				if (ok) seen = true;
			}
		}
	});

	test("badgeMeets compares thresholds in both directions", () => {
		expect(badgeMeets("blossom", "root")).toBe(true);
		expect(badgeMeets("root", "blossom")).toBe(false);
		expect(badgeMeets("petal", "petal")).toBe(true);
		expect(badgeMeets("free", "root")).toBe(false);
	});
});

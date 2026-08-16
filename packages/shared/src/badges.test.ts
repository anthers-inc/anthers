// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coverage for the Badge model — the rule that a Badge is identified by its **amount**
// and never by its position in a list.
//
// The distinction has teeth. The retired `badgeRank` was `BADGE_ORDER.indexOf(name)`, and
// the retired `seedsMeetRank` compared a held count against that index. It gave correct
// answers only because Anthers' own Badges sat at 1/2/3/4 Seeds, where index and threshold
// coincide — an accident, not a design. Any issuer whose Badges skip a level mis-resolved
// access *silently*: no error, no crash, just wrong answers about who may read what.
//
// 🚨 **That accident is now impossible to rely on, which is why this file grew rather than
// shrank.** Thresholds became dollars on 2026-08-16 when the Seed retired as a unit, so a
// creator's ladder is an arbitrary set of amounts and non-consecutive is the ORDINARY case.
// What replaces the index hazard is a float one: two `numeric` columns compared with `>=`.
// The sparse ladder below is deliberately not round for exactly that reason.
import { describe, expect, test } from "bun:test";
import {
	ANTHERS_BADGES,
	amountLabel,
	amountMeets,
	type BadgeDef,
	type BadgeKey,
	badgeFor,
	heldBadgeLabel,
	heldBadgeName,
	thresholdForBadge,
	thresholdOf,
} from "./constants.js";

/**
 * A creator's ladder with gaps AND cents — the two cases a resolver gets silently wrong.
 *
 * $2.50 and $7.30 are the point: under the retired whole-Seed model neither could exist,
 * and both are now perfectly ordinary things for a creator to charge.
 */
const SPARSE: readonly BadgeDef[] = [
	{ name: "spark", threshold: 1 },
	{ name: "ember", threshold: 2.5 },
	{ name: "flame", threshold: 5 },
	{ name: "beacon", threshold: 7.3 },
];

describe("badgeFor — highest threshold met", () => {
	test("below the lowest threshold, no Badge is held", () => {
		expect(badgeFor(0, SPARSE).badge).toBeNull();
		expect(badgeFor(0).badge).toBeNull();
	});

	test("a sparse ladder resolves by threshold, not position", () => {
		// Under the old index model these were off by the size of each gap: $5 would have
		// indexed past the end of a 4-entry list rather than landing on "flame".
		const cases: Array<[number, string | null]> = [
			[0, null],
			[0.99, null],
			[1, "spark"],
			[2, "spark"],
			[2.5, "ember"],
			[4.99, "ember"],
			[5, "flame"],
			[7.29, "flame"],
			[7.3, "beacon"],
			[70, "beacon"],
		];
		for (const [amount, name] of cases) {
			expect(badgeFor(amount, SPARSE).badge?.name ?? null, `$${amount}`).toBe(name);
		}
	});

	test("a negative amount holds nothing", () => {
		expect(badgeFor(-4, SPARSE).badge).toBeNull();
	});

	/**
	 * 🚨 The bug the whole-Seed model made impossible and the dollar model invites.
	 *
	 * `0.1 + 0.2 !== 0.3` is the oldest float bug there is, and a Badge threshold is now a
	 * `numeric` column compared against another `numeric` column. A supporter giving exactly
	 * what a Badge asks must hold it — a naive `>=` on the parsed doubles is one
	 * representation away from denying them, with no error anywhere.
	 */
	test("giving exactly the threshold clears it, however the arithmetic got there", () => {
		expect(badgeFor(0.1 + 0.2, [{ name: "third", threshold: 0.3 }]).badge?.name).toBe("third");
		expect(badgeFor(7.3, SPARSE).badge?.name).toBe("beacon");
		expect(badgeFor(2.5 + 4.8, SPARSE).badge?.name).toBe("beacon");
		// And a cent short still misses — the fix must not round the gate open.
		expect(badgeFor(7.29, SPARSE).badge?.name).toBe("flame");
	});
});

describe('the "+" rule applies between Badges, not only past the top', () => {
	test("giving strictly more than the held threshold renders a +", () => {
		expect(heldBadgeLabel(2.5, SPARSE)).toBe("Ember");
		expect(heldBadgeLabel(3, SPARSE)).toBe("Ember+"); // the between-Badges case
		expect(heldBadgeLabel(7.3, SPARSE)).toBe("Beacon");
		expect(heldBadgeLabel(8, SPARSE)).toBe("Beacon+"); // past the top
	});

	test("a single cent over a threshold is still a +", () => {
		// Cheap to get wrong once thresholds carry cents, and it is what a "+" means.
		expect(heldBadgeLabel(7.31, SPARSE)).toBe("Beacon+");
	});

	test("Anthers' own set only ever plusses past Blossom", () => {
		expect(heldBadgeLabel(0)).toBe("Free");
		expect(heldBadgeLabel(3)).toBe("Root");
		expect(heldBadgeLabel(12)).toBe("Blossom");
		expect(heldBadgeLabel(15)).toBe("Blossom+");
	});

	test("the empty label is caller-chosen", () => {
		expect(heldBadgeLabel(0, SPARSE, "None")).toBe("None");
	});
});

describe("gates are thresholds, and need not sit on a Badge", () => {
	test("a supporter clears any gate at or below what they give", () => {
		expect(amountMeets(4, 4)).toBe(true);
		expect(amountMeets(3, 4)).toBe(false);
		// No Badge sits at $4 in SPARSE, yet a $4 gate is legal and cleared.
		expect(thresholdOf("ember", SPARSE)).toBe(2.5);
		expect(SPARSE.some((b) => b.threshold === 4)).toBe(false);
		expect(amountMeets(4, 4)).toBe(true);
	});

	test("a cent short of a gate never clears it, however the ladder is shaped", () => {
		for (const t of [1, 2.5, 5, 7.3]) {
			expect(amountMeets(t - 0.01, t), `$${t - 0.01} vs gate $${t}`).toBe(false);
			expect(amountMeets(t, t), `$${t} vs gate $${t}`).toBe(true);
		}
	});

	/**
	 * 🚨 **Cents are ROUNDED, not floored — and a sabotage is the only reason this test is
	 * right.**
	 *
	 * The first version of this asserted `amountMeets(1.15, 1.15)` and claimed flooring
	 * would deny it. **It would not**: both sides floor identically, so a symmetric
	 * comparison survives flooring untouched, and replacing `Math.round` with `Math.floor`
	 * failed **zero** of 978 tests. Predicted two. The prediction being wrong was the
	 * finding — the docstring's reasoning was wrong and the test was asserting a property
	 * the implementation did not need.
	 *
	 * The real hazard is **asymmetry**: a held amount reached by ADDING two allocations,
	 * against a threshold stored as one literal. `$1.00 + $1.14` is `2.1399999999999997`,
	 * which floors to 213 cents against a `$2.14` threshold's 214 — so a supporter who paid
	 * exactly the asking amount is refused, silently. There are 2,180 such pairs under $2
	 * alone (counted, not estimated). Rounding has none.
	 */
	test("an amount reached by ADDING allocations still clears the threshold it equals", () => {
		// The pair that made the sabotage fail, so the sabotage stays meaningful.
		expect(1 + 1.14).not.toBe(2.14); // the premise, asserted so it cannot rot
		expect(amountMeets(1 + 1.14, 2.14)).toBe(true);
		expect(amountMeets(3.03 + 1, 4.03)).toBe(true);
		expect(amountMeets(7.97 + 1, 8.97)).toBe(true);
		// …and a genuinely short payer is still short.
		expect(amountMeets(1 + 1.13, 2.14)).toBe(false);
	});

	test("symmetric equality holds too, whichever amounts are used", () => {
		for (const a of [1.15, 2.9, 8.7, 0.29, 2.01]) expect(amountMeets(a, a)).toBe(true);
		expect(amountMeets(4.99, 5)).toBe(false);
	});
});

describe("thresholdForBadge returns a threshold", () => {
	test("Anthers' Badges report their monthly cost", () => {
		expect(thresholdForBadge("free")).toBe(0);
		expect(thresholdForBadge("root")).toBe(3);
		expect(thresholdForBadge("blossom")).toBe(12);
	});

	test("it agrees with the Badge set rather than a hardcoded ladder", () => {
		for (const b of ANTHERS_BADGES) {
			expect(thresholdForBadge(b.name as "root"), b.name).toBe(b.threshold);
		}
	});

	test("thresholdOf reports null for a name the set does not define", () => {
		expect(thresholdOf("nonesuch")).toBeNull();
		expect(thresholdOf("flame", SPARSE)).toBe(5);
	});
});

describe("Anthers Badge resolution is point-in-time and monotone", () => {
	test("heldBadgeName names the held Badge, or free at zero", () => {
		expect(heldBadgeName(0)).toBe("free");
		expect(heldBadgeName(3)).toBe("root");
		expect(heldBadgeName(12)).toBe("blossom");
		expect(heldBadgeName(99)).toBe("blossom");
	});

	test("giving more never removes access a smaller amount had", () => {
		for (const required of ["free", "root", "sprout", "petal", "blossom"] as const) {
			let seen = false;
			// In cents, because the whole point is that the axis is continuous now.
			for (let c = 0; c <= 2400; c += 25) {
				const ok = amountMeets(c / 100, thresholdForBadge(required));
				if (seen) expect(ok, `$${c / 100} vs ${required}`).toBe(true);
				if (ok) seen = true;
			}
		}
	});

	// The retired `badgeMeets(held, required)` compared two Badge NAMES. Comparing their
	// thresholds directly is the same answer without the intermediate collapse, and keeps
	// the assertion that a Badge-to-Badge comparison is threshold arithmetic either way.
	test("comparing two Badges compares their thresholds, in both directions", () => {
		const meets = (held: BadgeKey, required: BadgeKey) =>
			amountMeets(thresholdForBadge(held), thresholdForBadge(required));
		expect(meets("blossom", "root")).toBe(true);
		expect(meets("root", "blossom")).toBe(false);
		expect(meets("petal", "petal")).toBe(true);
		expect(meets("free", "root")).toBe(false);
	});
});

describe("amountLabel — the one place an amount is written for a human", () => {
	/**
	 * 🚨 The cents case is why this function exists. `${9.5}` renders **"$9.5"**, which
	 * reads as a typo — and when it appears beside a correctly formatted copy of the same
	 * number, as a bug. Both shipped on 2026-08-16: the access table's threshold hint said
	 * `$9.5+/month` under a heading that said `$9.50`, and the gauntlet advertised a rung as
	 * "at least $9.50 ($9.5)".
	 */
	test("a rung carrying cents keeps both of them", () => {
		expect(amountLabel(9.5)).toBe("$9.50");
		expect(amountLabel("9.5")).toBe("$9.50");
		expect(amountLabel(12.99)).toBe("$12.99");
		expect(amountLabel(0.5)).toBe("$0.50");
	});

	test("a whole dollar loses the .00 — the common case stays clean", () => {
		expect(amountLabel(3)).toBe("$3");
		expect(amountLabel("21")).toBe("$21");
		expect(amountLabel(0)).toBe("$0");
	});

	// Same normalisation as everything else that reads an amount: it goes through `cents`,
	// so a negative floors and sub-cent precision drops rather than reaching a reader.
	test("it normalises rather than trusting its input", () => {
		expect(amountLabel(-5)).toBe("$0");
		expect(amountLabel(null)).toBe("$0");
		expect(amountLabel(undefined)).toBe("$0");
		expect(amountLabel(3.004)).toBe("$3");
		expect(amountLabel(3.006)).toBe("$3.01");
	});

	// The float the Badge model actually has to survive: 1.15 * 100 is 114.999… in binary,
	// and truncating instead of rounding would render "$1.14".
	test("it rounds the binary-float amounts the ladder can genuinely hold", () => {
		expect(amountLabel(1.15)).toBe("$1.15");
		expect(amountLabel(2.9)).toBe("$2.90");
	});
});

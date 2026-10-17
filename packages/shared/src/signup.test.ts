// SPDX-License-Identifier: Apache-2.0
//
// The signup picks shape, and the amount a backed creator's pick bills.
//
// `normalizePicks` reads whatever an older shape left in storage (a bare handle, a rung
// id gone missing) into the shape every reader honors, and `directedAmountFor` is the one
// function both places that quote and bill a pick resolve by — /signup's chips, its echo,
// and /finish's summary and charge. The fallbacks are the whole point: a pick carries a
// rung id, never a price, so every dollar a signup charges is a threshold a creator's own
// ladder states.

import { describe, expect, test } from "bun:test";
import { PUBLIC_ACCESS_PRICE } from "./constants";
import { directedAmountFor, normalizePicks, picksAreEmpty } from "./signup";

/** A two-rung ladder, ascending, as the listing ships it. */
const LADDER = [
	{ id: 11, threshold: "1.00" },
	{ id: 42, threshold: "7.50" },
];

describe("normalizePicks", () => {
	test("reads the current shape through", () => {
		const picks = normalizePicks({
			badge: "root",
			follow: ["meadow"],
			badges: [{ handle: "meadow", badgeId: 42 }],
		});
		expect(picks).toEqual({
			badge: "root",
			follow: ["meadow"],
			badges: [{ handle: "meadow", badgeId: 42 }],
		});
	});

	test("reads a handle-only entry as the lowest rung, the convention it was written by", () => {
		// A pending row or a session-storage blob written before per-rung picks existed.
		const picks = normalizePicks({ badge: null, follow: [], badges: ["meadow"] });
		expect(picks.badges).toEqual([{ handle: "meadow", badgeId: null }]);
	});

	test("coerces an unanswerable id onto the same null the resolution reads as lowest", () => {
		const picks = normalizePicks({
			badges: [
				{ handle: "meadow", badgeId: 0 },
				{ handle: "hedge", badgeId: 3.5 },
				{ handle: "brook" },
			],
		});
		expect(picks.badges).toEqual([
			{ handle: "meadow", badgeId: null },
			{ handle: "hedge", badgeId: null },
			{ handle: "brook", badgeId: null },
		]);
	});

	test("one pick per creator, and nothing that is not a pick", () => {
		const picks = normalizePicks({ badges: ["meadow", { handle: "meadow", badgeId: 42 }] });
		expect(picks.badges).toEqual([{ handle: "meadow", badgeId: 42 }]);
		expect(normalizePicks({ badges: null }).badges).toEqual([]);
	});
});

describe("directedAmountFor", () => {
	test("a resolved rung bills exactly the threshold the ladder names", () => {
		expect(directedAmountFor({ badgeId: 42 }, LADDER)).toBe(7.5);
		expect(directedAmountFor({ badgeId: 11 }, LADDER)).toBe(1);
	});

	test("a rung the ladder no longer reports reads as the lowest rung", () => {
		// The ladder was edited between pick and commit; the pick is still honored, at the
		// rung every ladder has — never at a price the pick carried, because it carries none.
		expect(directedAmountFor({ badgeId: 99 }, LADDER)).toBe(1);
		expect(directedAmountFor({ badgeId: null }, LADDER)).toBe(1);
	});

	test("a creator with no ladder reads as the entry price, what that pick meant", () => {
		// Handle-only signups backed every creator at the Public Access price; a stored pick
		// whose creator has no configured ladder still means that.
		expect(directedAmountFor({ badgeId: 42 }, [])).toBe(PUBLIC_ACCESS_PRICE);
		expect(directedAmountFor({ badgeId: null }, undefined)).toBe(PUBLIC_ACCESS_PRICE);
	});
});

describe("the picks' emptiness", () => {
	test("an empty answer is empty, and a backed rung is not nothing", () => {
		const empty = normalizePicks({ badge: null, follow: [], badges: [] });
		const backed = normalizePicks({ badge: null, follow: [], badges: [{ handle: "m", badgeId: 1 }] });
		expect(picksAreEmpty(empty)).toBe(true);
		expect(picksAreEmpty(backed)).toBe(false);
	});
});
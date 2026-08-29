// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The free-limit prompt's headline number.
//
// 🚨 This exists because the number is **copy**, and copy is where a stale figure hides
// best: 21.01 §9.4 says "paid six times more for your attention", and six is not a fact
// about the world — it is `timePoolFor($3) / FREE_TIME_POOL`, a ratio between two dials,
// one of which is explicitly provisional. Nothing errors when a dial moves and the
// sentence doesn't. Same family as the generated econ figures, and the same rule: a
// published number with a formula behind it is derived, never transcribed.
//
// ⚠️ **A FUNCTION rather than a constant, and that is a copy problem rather than a
// naming one.** The multiple depends on what *this* user gives, so a page saying "six
// times" is asserting something about a specific amount and has to say which. At the $3
// Public Access price it is still 6.
import { describe, expect, test } from "bun:test";
import {
	FREE_TIME_POOL,
	formatMultiple,
	PUBLIC_ACCESS_PRICE,
	timePoolFor,
	timePoolMultipleFor,
} from "./constants.js";

describe("the multiple supporting Anthers buys", () => {
	test("is the ratio of the two dials, not a number of its own", () => {
		// Deliberately re-derived from the dials rather than asserted as `6`. Pinning the
		// literal would make this test agree with the copy while both were wrong — which
		// is the exact failure it exists to prevent.
		expect(timePoolMultipleFor(PUBLIC_ACCESS_PRICE)).toBe(
			timePoolFor(PUBLIC_ACCESS_PRICE) / FREE_TIME_POOL,
		);
	});

	test("is what today's dials actually work out to at the Public Access price", () => {
		// The one place the current value IS asserted, so a dial change is visible in a
		// diff rather than silently absorbed. If this fails, the dials moved — update it
		// deliberately and check the copy still reads well at the new number.
		expect(timePoolMultipleFor(PUBLIC_ACCESS_PRICE)).toBe(6);
	});

	test("defaults to the Public Access price, because that is what copy means by it", () => {
		// Copy that says "six times" is talking about the $3 conversion moment. Making that
		// the default is what stops a caller silently quoting the multiple for $0.
		expect(timePoolMultipleFor()).toBe(timePoolMultipleFor(PUBLIC_ACCESS_PRICE));
	});

	test("scales with what you give, which is the whole reason it stopped being a constant", () => {
		expect(timePoolMultipleFor(6)).toBe(12);
		expect(timePoolMultipleFor(1.5)).toBe(3);
		// And it is continuous now — an amount between the rungs has an answer.
		expect(timePoolMultipleFor(4.5)).toBe(9);
	});

	test("is worth stating and greater than one", () => {
		// Supporting for less Time Pool than the free subsidy would make the whole
		// conversion argument backwards, and the prompt would be advertising a downgrade.
		expect(timePoolMultipleFor(PUBLIC_ACCESS_PRICE)).toBeGreaterThan(1);
	});
});

describe("formatMultiple", () => {
	test("keeps whole numbers whole", () => {
		expect(formatMultiple(6)).toBe("6×");
		expect(formatMultiple(1)).toBe("1×");
	});

	test("goes to one decimal when the dials stop dividing evenly", () => {
		// $1.50 / $0.40 = 3.75. Rounding to "4×" would overstate what supporting buys, and
		// "3.75×" reads like a spreadsheet.
		expect(formatMultiple(1.5 / 0.4)).toBe("3.8×");
		expect(formatMultiple(1.5 / 0.35)).toBe("4.3×");
	});
});

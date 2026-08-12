// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The free-limit prompt's headline number.
//
// 🚨 This exists because the number is **copy**, and copy is where a stale figure hides
// best: 21.01 §9.4 says "paid six times more for your attention", and six is not a fact
// about the world — it is `TIME_POOL_PER_SEED / FREE_TIME_POOL`, a ratio between two
// dials, one of which is explicitly provisional. Nothing errors when a dial moves and
// the sentence doesn't. Same family as the generated econ figures, and the same rule: a
// published number with a formula behind it is derived, never transcribed.
import { describe, expect, test } from "bun:test";
import {
	FREE_TIME_POOL,
	FREE_TIME_POOL_MULTIPLE,
	formatMultiple,
	TIME_POOL_PER_SEED,
} from "./constants.js";

describe("the multiple a Seed buys", () => {
	test("is the ratio of the two dials, not a number of its own", () => {
		// Deliberately re-derived from the dials rather than asserted as `6`. Pinning the
		// literal would make this test agree with the copy while both were wrong — which
		// is the exact failure it exists to prevent.
		expect(FREE_TIME_POOL_MULTIPLE).toBe(TIME_POOL_PER_SEED / FREE_TIME_POOL);
	});

	test("is what today's dials actually work out to", () => {
		// The one place the current value IS asserted, so a dial change is visible in a
		// diff rather than silently absorbed. If this fails, the dials moved — update it
		// deliberately and check the copy still reads well at the new number.
		expect(FREE_TIME_POOL_MULTIPLE).toBe(6);
	});

	test("is worth stating and greater than one", () => {
		// A Seed that bought less Time Pool than the free subsidy would make the whole
		// conversion argument backwards, and the prompt would be advertising a downgrade.
		expect(FREE_TIME_POOL_MULTIPLE).toBeGreaterThan(1);
	});
});

describe("formatMultiple", () => {
	test("keeps whole numbers whole", () => {
		expect(formatMultiple(6)).toBe("6×");
		expect(formatMultiple(1)).toBe("1×");
	});

	test("goes to one decimal when the dials stop dividing evenly", () => {
		// $1.50 / $0.40 = 3.75. Rounding to "4×" would overstate what a Seed buys, and
		// "3.75×" reads like a spreadsheet.
		expect(formatMultiple(1.5 / 0.4)).toBe("3.8×");
		expect(formatMultiple(1.5 / 0.35)).toBe("4.3×");
	});
});

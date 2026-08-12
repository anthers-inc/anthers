// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Public Access meter's policy. Pure, so the whole rule is exercised here without a
// database — the DB half (`apps/api/src/services/public-access.ts`) only feeds it, and
// the enforcement half is pinned in `apps/api/src/__tests__/public-access-meter.test.ts`.
import { describe, expect, test } from "bun:test";
import {
	FREE_PUBLIC_ACCESS_HOURS,
	FREE_PUBLIC_ACCESS_SECONDS,
	publicAccessBudget,
} from "./public-access.js";

const HOUR = 3600;

describe("the free allowance", () => {
	test("is 10 hours a month, in whatever unit you ask for", () => {
		expect(FREE_PUBLIC_ACCESS_HOURS).toBe(10);
		expect(FREE_PUBLIC_ACCESS_SECONDS).toBe(10 * HOUR);
	});

	test("a free account starts with the whole allowance and may watch", () => {
		const b = publicAccessBudget(0, 0);
		expect(b.unlimited).toBe(false);
		expect(b.remainingSeconds).toBe(FREE_PUBLIC_ACCESS_SECONDS);
		expect(b.allowed).toBe(true);
	});

	test("spending draws it down exactly, and it never goes negative", () => {
		expect(publicAccessBudget(0, 4 * HOUR).remainingSeconds).toBe(6 * HOUR);
		// Overspend is possible — a batch can land while the last of the budget is in
		// flight — and must clamp rather than report a negative remainder to the UI.
		expect(publicAccessBudget(0, 99 * HOUR).remainingSeconds).toBe(0);
		expect(publicAccessBudget(0, 99 * HOUR).allowed).toBe(false);
	});

	test("exactly spent is spent — the boundary is >0, not >=0", () => {
		// The case this exists to refuse: starting one more stream on an empty budget.
		// An off-by-one here reads as "you have 0 hours left, enjoy your stream".
		expect(publicAccessBudget(0, FREE_PUBLIC_ACCESS_SECONDS - 1).allowed).toBe(true);
		expect(publicAccessBudget(0, FREE_PUBLIC_ACCESS_SECONDS).allowed).toBe(false);
	});
});

describe("what a Seed given to Anthers does", () => {
	/**
	 * The model's central claim about access, and the reason it is asserted across a wide
	 * range rather than at one value: **access is binary and arrives whole at the first
	 * Seed.** Nothing above it buys more. A regression here would most likely look like
	 * someone reintroducing a ladder — a limit that scales per Seed — which is precisely
	 * the stratified commons that retiring Anthers Gates was for.
	 */
	test("one Seed removes the limit, and every count above it is identical", () => {
		const one = publicAccessBudget(1, 500 * HOUR);
		expect(one.unlimited).toBe(true);
		expect(one.allowed).toBe(true);
		expect(one.limitSeconds).toBeNull();
		expect(one.remainingSeconds).toBeNull();

		for (const seeds of [2, 3, 4, 5, 12, 100]) {
			expect(publicAccessBudget(seeds, 500 * HOUR)).toEqual(one);
		}
	});

	test("a Seed-holder who has watched enormously is still allowed", () => {
		// There is no accumulation to exhaust — the point of "unlimited".
		expect(publicAccessBudget(1, 10_000 * HOUR).allowed).toBe(true);
	});

	test("a fractional or negative Seed count is not a Seed", () => {
		// Seeds are indivisible $3 units; a partial one cannot exist outside legacy rows,
		// and must not round up into free unlimited access.
		expect(publicAccessBudget(0.9, 0).unlimited).toBe(false);
		expect(publicAccessBudget(-3, 0).unlimited).toBe(false);
	});
});

describe("the shape of the answer", () => {
	test("usage is reported even when unlimited, so the UI can still show it", () => {
		expect(publicAccessBudget(2, 3 * HOUR).usedSeconds).toBe(3 * HOUR);
	});

	test("usage is floored and never negative", () => {
		expect(publicAccessBudget(0, -5).usedSeconds).toBe(0);
		expect(publicAccessBudget(0, 90.7).usedSeconds).toBe(90);
	});
});

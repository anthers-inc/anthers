// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Public Access meter's policy. Pure, so the whole rule is exercised here without a
// database — the DB half (`apps/api/src/services/public-access.ts`) only feeds it, and
// the enforcement half is pinned in `apps/api/src/__tests__/public-access-meter.test.ts`.
import { describe, expect, test } from "bun:test";
import { PUBLIC_ACCESS_PRICE } from "./constants.js";
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

describe("what supporting Anthers does", () => {
	/**
	 * The model's central claim about access, asserted across a wide range rather than at
	 * one value: **access is binary and arrives whole at the Public Access price.** Nothing
	 * above it buys more. A regression here would most likely look like someone
	 * reintroducing a ladder — a limit that scales with the amount — which is precisely the
	 * stratified commons that retiring Anthers Gates was for.
	 */
	test("the Public Access price removes the limit, and every amount above it is identical", () => {
		const at = publicAccessBudget(PUBLIC_ACCESS_PRICE, 500 * HOUR);
		expect(at.unlimited).toBe(true);
		expect(at.allowed).toBe(true);
		expect(at.limitSeconds).toBeNull();
		expect(at.remainingSeconds).toBeNull();

		for (const amount of [3.01, 6, 9, 12, 25, 300]) {
			expect(publicAccessBudget(amount, 500 * HOUR)).toEqual(at);
		}
	});

	/**
	 * 🚨 **The regression test for a live production defect.** This function took a Seed
	 * COUNT and tested `Math.floor(seeds) >= 1` until 2026-08-17, while its caller had
	 * already been converted to pass DOLLARS — so every amount from $1.00 to $2.99 bought
	 * unlimited access priced at $3.
	 *
	 * The suite could not see it, because it also still called this in Seeds. That is what
	 * a green suite looks like when a **contract** moves rather than an implementation, and
	 * it is why these cases are pinned by amount rather than by unit-free integers.
	 */
	test("an amount below the price does NOT buy unlimited access", () => {
		for (const amount of [0.01, 0.99, 1, 1.5, 2, 2.99]) {
			const b = publicAccessBudget(amount, 0);
			expect(b.unlimited, `$${amount}`).toBe(false);
			expect(b.limitSeconds, `$${amount}`).toBe(FREE_PUBLIC_ACCESS_SECONDS);
		}
		// And the cent either side of the threshold, since the comparison is in cents.
		expect(publicAccessBudget(PUBLIC_ACCESS_PRICE - 0.01, 0).unlimited).toBe(false);
		expect(publicAccessBudget(PUBLIC_ACCESS_PRICE, 0).unlimited).toBe(true);
	});

	test("a supporter who has watched enormously is still allowed", () => {
		// There is no accumulation to exhaust — the point of "unlimited".
		expect(publicAccessBudget(PUBLIC_ACCESS_PRICE, 10_000 * HOUR).allowed).toBe(true);
	});

	test("a negative amount is not support", () => {
		expect(publicAccessBudget(-3, 0).unlimited).toBe(false);
	});
});

describe("the shape of the answer", () => {
	test("usage is reported even when unlimited, so the UI can still show it", () => {
		expect(publicAccessBudget(PUBLIC_ACCESS_PRICE, 3 * HOUR).usedSeconds).toBe(3 * HOUR);
	});

	test("usage is floored and never negative", () => {
		expect(publicAccessBudget(0, -5).usedSeconds).toBe(0);
		expect(publicAccessBudget(0, 90.7).usedSeconds).toBe(90);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The floor on a creator-set amount, and the three ways to get it wrong that look right.
 *
 * 🚨 **The rule is "$0 or at least $0.50, and nothing in between."** Stripe will not process
 * a charge below its minimum, so an amount in that gap is not a cheap price — it is one
 * nobody can pay, and the creator finds out through a stranger failing at checkout.
 *
 * ⚠️ **A flat `Math.max(0.5, price)` is the wrong shape and would be a catastrophe.** $0 with
 * Allow checked is exactly what Public Access is, so a plain minimum puts a price on every
 * free Work on the platform. That is why there is a predicate rather than a `.min()` at each
 * of the validators, and why zero is asserted here first.
 *
 * ⭐ **This is not the granularity floor `constants.ts` forbids**, and the distinction is
 * worth holding: that one was justified by card-fee proportionality, which died when one
 * subscription came to carry everything a user gives. Stripe's minimum says something else
 * entirely — not *this charge is uneconomic* but *this charge cannot exist*.
 */
import { describe, expect, it } from "bun:test";
import { isChargeableAmount, PUBLIC_ACCESS_PRICE, STRIPE_MIN_CHARGE } from "./constants.js";

describe("isChargeableAmount", () => {
	it("🚨 admits $0, because free is the commons and not a price", () => {
		// The assertion that has to come first. A flat minimum would fail this one, and
		// failing it would put a price on every Public Access Work there is.
		expect(isChargeableAmount(0)).toBe(true);
	});

	it("🚨 refuses everything strictly between zero and the floor", () => {
		for (const amount of [0.01, 0.25, 0.32, 0.49]) {
			expect(isChargeableAmount(amount), `$${amount}`).toBe(false);
		}
	});

	it("admits the floor itself, and everything above it", () => {
		// ⚠️ `0.5` is not exactly representable, which is why the predicate compares in
		// cents. A floor that rejected its own boundary value on one code path and not
		// another would be worse than no floor at all.
		expect(isChargeableAmount(STRIPE_MIN_CHARGE)).toBe(true);
		for (const amount of [0.51, 0.99, 1, PUBLIC_ACCESS_PRICE, 9.5, 250]) {
			expect(isChargeableAmount(amount), `$${amount}`).toBe(true);
		}
	});

	it("⭐ agrees with itself across the whole cent range, with exactly one boundary", () => {
		// Derived rather than spot-checked: the only transition between $0.01 and $10.00
		// must be at the floor. A predicate with a second boundary — a rounding artifact,
		// or a stray clamp — would pass every example above and still be wrong.
		const transitions: number[] = [];
		let previous = isChargeableAmount(0.01);
		for (let cents = 2; cents <= 1000; cents++) {
			const now = isChargeableAmount(cents / 100);
			if (now !== previous) transitions.push(cents / 100);
			previous = now;
		}
		expect(transitions).toEqual([STRIPE_MIN_CHARGE]);
	});

	it("refuses what is not a number at all, rather than letting it through", () => {
		// `Number("")` is 0 and `Number("abc")` is NaN, and both reach this from a money
		// string. Zero is legitimately chargeable; NaN is not, and a comparison against it
		// is false in every direction — so it has to be refused explicitly or `>=` lets it
		// fall to whichever branch happens to be written first.
		expect(isChargeableAmount(Number.NaN)).toBe(false);
		expect(isChargeableAmount(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isChargeableAmount(-1)).toBe(false);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coverage for the two most load-bearing functions in the money model —
// `badgePriceBreakdown` and `calculateFees`. The badge model's central invariant
// after the 2026-07-17 revision is that Price decomposes exactly into five
// destinations (Payments + Time Pool + Seeds + Community Share), so a stray edit
// to any frozen dial that breaks the sum is caught here.
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { BADGE_ORDER, BADGE_PLANS, type Badge, SEED_PRICE } from "./constants.js";
import { badgePlanViews, badgePriceBreakdown, calculateFees } from "./fees.js";

const PAID: Badge[] = ["root", "sprout", "petal", "blossom"];

/** V4 baseline dollars to creators (Time Pool + Seeds) that the revision must beat. */
const V4_TO_CREATORS: Record<string, number> = { root: 3, sprout: 6, petal: 12, blossom: 22 };

describe("badgePriceBreakdown", () => {
	test("price = payments + timePool + seeds + communityShare, to the cent, every paid tier", () => {
		for (const badge of PAID) {
			const b = badgePriceBreakdown(badge);
			const sum = b.payments.plus(b.timePool).plus(b.seeds).plus(b.communityShare);
			expect(sum.toFixed(2)).toBe(b.price.toFixed(2));
		}
	});

	test("free pays $0 — no payments, no Community Share, but a subsidised Time Pool", () => {
		const b = badgePriceBreakdown("free");
		expect(b.price.toNumber()).toBe(0);
		expect(b.payments.toNumber()).toBe(0);
		expect(b.communityShare.toNumber()).toBe(0);
		expect(b.subsidised).toBe(true);
		expect(b.timePool.toNumber()).toBeGreaterThan(0);
	});

	test("every paid tier delivers more to creators than V4", () => {
		for (const badge of PAID) {
			const b = badgePriceBreakdown(badge);
			expect(b.toCreators.toNumber()).toBeGreaterThan(V4_TO_CREATORS[badge]);
		}
	});

	test("toCreators is exactly timePool + seeds", () => {
		for (const badge of BADGE_ORDER) {
			const b = badgePriceBreakdown(badge);
			expect(b.toCreators.toFixed(2)).toBe(b.timePool.plus(b.seeds).toFixed(2));
		}
	});

	test("seeds = plan.seeds × SEED_PRICE", () => {
		for (const badge of PAID) {
			const b = badgePriceBreakdown(badge);
			expect(b.seeds.toNumber()).toBe(BADGE_PLANS[badge].seeds * SEED_PRICE);
		}
	});
});

describe("badgePlanViews", () => {
	test("exposes payments, and money fields render to two decimals", () => {
		const views = badgePlanViews();
		expect(views).toHaveLength(BADGE_ORDER.length);
		for (const v of views) {
			expect(v.payments).toMatch(/^\d+\.\d{2}$/);
			expect(v.timePool).toMatch(/^\d+\.\d{2}$/);
			expect(v.communityShare).toMatch(/^\d+\.\d{2}$/);
			expect(v.toCreators).toMatch(/^\d+\.\d{2}$/);
		}
	});
});

describe("calculateFees — direct purchase, zero-cut pass-through", () => {
	test("creator receives the full listed price", () => {
		const f = calculateFees(new Decimal("10.00"), { type: "service" });
		expect(f.creatorEarnings.toFixed(2)).toBe("10.00");
	});

	test("physical AFF is 1% of price with no delivery fee", () => {
		const f = calculateFees(new Decimal("30.00"), { type: "physical" });
		expect(f.crfFee.toFixed(2)).toBe("0.30");
		expect(f.deliveryFee.toNumber()).toBe(0);
	});

	test("fees and tax ride on top — buyer pays more than the price", () => {
		const f = calculateFees(new Decimal("20.00"), { type: "service" });
		expect(f.buyerTotal.toNumber()).toBeGreaterThan(20);
	});
});

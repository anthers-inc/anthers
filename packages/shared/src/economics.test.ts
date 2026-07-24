// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coverage for the support-model money functions. The central invariant is that
// each Anthers-Seed's $3 conserves exactly into bandwidth + Time Pool + Foundation
// (Payments rides on top, never inside a Seed), so a stray edit to a dial that
// breaks the sum — or that lets Payments leak into a Seed — is caught here.
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { BADGE_ORDER, SEED_PRICE, TIME_POOL_PER_SEED, timePoolFor } from "./constants.js";
import {
	anthersSeedBreakdown,
	calculateFees,
	cardFee,
	rankViews,
	supportBreakdown,
} from "./fees.js";

const PAID_SEEDS = [1, 2, 3, 4];

describe("anthersSeedBreakdown", () => {
	test("seed value + Time Pool + bandwidth + Foundation conserve exactly, every count", () => {
		for (const n of PAID_SEEDS) {
			const b = anthersSeedBreakdown(n, { bandwidthGiB: 30 * n });
			expect(b.seedValue.toFixed(2)).toBe((SEED_PRICE * n).toFixed(2));
			const sum = b.timePool.plus(b.bandwidth).plus(b.foundation);
			expect(sum.toFixed(2)).toBe(b.seedValue.toFixed(2));
		}
	});

	test("Time Pool is $1.50 per Anthers-Seed", () => {
		for (const n of PAID_SEEDS) {
			expect(anthersSeedBreakdown(n).timePool.toNumber()).toBe(TIME_POOL_PER_SEED * n);
		}
	});

	test("Foundation is the remainder — it shrinks as bandwidth grows (shock absorber)", () => {
		const light = anthersSeedBreakdown(1, { bandwidthGiB: 10 });
		const heavy = anthersSeedBreakdown(1, { bandwidthGiB: 60 });
		expect(heavy.foundation.lt(light.foundation)).toBe(true);
		expect(heavy.timePool.toFixed(2)).toBe(light.timePool.toFixed(2)); // Time Pool stays fixed
	});

	test("free rank (0 Seeds) pays $0 and funds no Foundation, but has a subsidised Time Pool", () => {
		const b = anthersSeedBreakdown(0);
		expect(b.seedValue.toNumber()).toBe(0);
		expect(b.foundation.toNumber()).toBe(0);
		expect(b.subsidised).toBe(true);
		expect(b.timePool.toNumber()).toBeGreaterThan(0);
	});
});

describe("cardFee (Payments, on top)", () => {
	test("is 2.9% + $0.30 on the charge, and $0 when nothing is charged", () => {
		expect(cardFee(3).toFixed(2)).toBe("0.39");
		expect(cardFee(0).toNumber()).toBe(0);
	});
});

describe("supportBreakdown", () => {
	test("directed Seeds reach creators 100%; Payments is one card fee on top of the whole subtotal", () => {
		// 2 creator-Seeds + 1 Anthers-Seed, light streaming.
		const s = supportBreakdown({ anthersSeeds: 1, creatorSeeds: 2, bandwidthGiB: 20 });
		expect(s.creatorDirect.toFixed(2)).toBe("6.00"); // 2 × $3, 100%
		expect(s.seedsSubtotal.toFixed(2)).toBe("9.00"); // (2 + 1) × $3
		expect(s.payments.toFixed(2)).toBe(cardFee(9).toFixed(2)); // one fee on $9, on top
		expect(s.total.toFixed(2)).toBe(s.seedsSubtotal.plus(s.payments).toFixed(2));
		expect(s.toCreators.toFixed(2)).toBe(s.creatorDirect.plus(s.timePool).toFixed(2));
	});

	test("a pure-direct user (no Anthers-Seed) still pays only Seeds + on-top Payments", () => {
		const s = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
		expect(s.creatorDirect.toFixed(2)).toBe("3.00");
		expect(s.foundation.toNumber()).toBe(0);
		expect(s.payments.toFixed(2)).toBe("0.39");
		expect(s.total.toFixed(2)).toBe("3.39"); // matches the Subscribe page
	});
});

describe("rankViews", () => {
	test("one row per rank; price = $3 × Anthers-Seed count; money renders to 2dp", () => {
		const views = rankViews();
		expect(views).toHaveLength(BADGE_ORDER.length);
		views.forEach((v, i) => {
			expect(v.anthersSeeds).toBe(i);
			expect(v.price).toBe(SEED_PRICE * i);
			expect(v.timePool).toMatch(/^\d+\.\d{2}$/);
			expect(v.supportsAnthers).toMatch(/^\d+\.\d{2}$/);
			expect(Number(v.timePool)).toBe(timePoolFor(i));
		});
	});
});

describe("calculateFees — direct purchase, zero-cut pass-through (unchanged)", () => {
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

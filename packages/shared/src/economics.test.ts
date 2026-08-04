// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coverage for the support-model money functions. The central invariant is that
// each Anthers-Seed's $3 conserves exactly into bandwidth + Time Pool + Payments +
// Foundation, so a stray edit to a dial that breaks the sum is caught here.
// Payments moved INSIDE the price on 2026-08-03 — it is charged on the whole batched
// monthly charge and split pro-rata, and only sales tax is ever added on top.
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { BADGE_ORDER, SEED_PRICE, TIME_POOL_PER_SEED, timePoolFor } from "./constants.js";
import {
	anthersSeedBreakdown,
	badgeViews,
	calculateFees,
	cardFee,
	paymentsSplit,
	supportBreakdown,
} from "./fees.js";

const PAID_SEEDS = [1, 2, 3, 4];

describe("anthersSeedBreakdown", () => {
	test("seed value + Time Pool + bandwidth + Foundation conserve exactly, every count", () => {
		for (const n of PAID_SEEDS) {
			const payments = paymentsSplit(n, 0).anthers;
			const b = anthersSeedBreakdown(n, { bandwidthGiB: 30 * n, payments });
			expect(b.seedValue.toFixed(2)).toBe((SEED_PRICE * n).toFixed(2));
			const sum = b.timePool.plus(b.bandwidth).plus(b.payments).plus(b.foundation);
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

	/**
	 * The shock absorber has no floor, and that is deliberate rather than an oversight:
	 * the remainder is a plain subtraction, so a heavy enough streamer drives it negative
	 * — which is the true statement that this user cost the Foundation money, and the
	 * number the accounting wants. Clamping here would silently break the conservation
	 * invariant asserted above (the parts would no longer sum to the seed value).
	 *
	 * The clamp belongs at the boundary that persists it, and lives there: `settle-cycle.ts`
	 * writes `Decimal.max(0, foundation)` to the ledger and the cycle snapshot, because both
	 * report what the Foundation *received*, which is never less than nothing. That clamp is
	 * pinned end-to-end in `apps/api/src/__tests__/payments-stripe.test.ts`. (The identical
	 * line in `billing.ts`'s `snapshotCycle` is defensive only and cannot currently fire —
	 * that path passes no bandwidth, so its remainder is always $1.50 per Seed.)
	 */
	test("Foundation can go negative — the remainder has no floor, by design", () => {
		// One Seed ($3) against 200 GiB at $0.01/GiB: $3.00 − $1.50 Time Pool − $2.00 = −$0.50.
		const b = anthersSeedBreakdown(1, { bandwidthGiB: 200 });
		expect(b.foundation.isNegative()).toBe(true);
		expect(b.foundation.toFixed(2)).toBe("-0.50");
		// Conservation still holds exactly, which is the reason not to clamp here.
		expect(b.timePool.plus(b.bandwidth).plus(b.foundation).toFixed(2)).toBe(b.seedValue.toFixed(2));
		// The Time Pool is untouched: creators are paid the same by a user who cost more
		// to serve than they paid in.
		expect(b.timePool.toFixed(2)).toBe("1.50");
	});
});

describe("cardFee (Payments, inside the price)", () => {
	test("is 2.9% + $0.30 on the charge, and $0 when nothing is charged", () => {
		expect(cardFee(3).toFixed(2)).toBe("0.39");
		expect(cardFee(0).toNumber()).toBe(0);
	});

	test("the flat $0.30 is per CHARGE, so batching is what makes the rate fall", () => {
		// The whole argument for a $3 Seed rather than a $1 one, and for one monthly
		// charge rather than per-creator billing.
		// cardFee rounds to whole cents, so these are the rates a user actually pays.
		expect(cardFee(3).div(3).toNumber()).toBeCloseTo(0.13, 2); // ~13% borne alone
		expect(cardFee(12).div(12).toNumber()).toBeCloseTo(0.054, 3); // ~5.4% batched
		expect(cardFee(12).lessThan(cardFee(3).mul(4))).toBe(true); // one charge beats four
	});
});

describe("supportBreakdown", () => {
	test("the Seed price is all-in: Payments comes out of the charge, never on top", () => {
		// 2 creator-Seeds + 1 Anthers-Seed, light streaming.
		const s = supportBreakdown({ anthersSeeds: 1, creatorSeeds: 2, bandwidthGiB: 20 });
		expect(s.creatorDirect.toFixed(2)).toBe("6.00"); // 2 × $3 gross
		expect(s.seedsSubtotal.toFixed(2)).toBe("9.00"); // (2 + 1) × $3
		expect(s.payments.toFixed(2)).toBe(cardFee(9).toFixed(2)); // one fee on the whole $9
		// The user pays the subtotal and nothing more — sales tax is the only add-on,
		// and it is applied by the caller, not here.
		expect(s.total.toFixed(2)).toBe("9.00");
	});

	test("Payments splits pro-rata; creators are paid net and the split reconstructs the fee", () => {
		const s = supportBreakdown({ anthersSeeds: 1, creatorSeeds: 2, bandwidthGiB: 20 });
		const split = paymentsSplit(1, 2);
		// Two-thirds of the charge is directed, so two-thirds of the fee is.
		expect(split.creator.plus(split.anthers).toFixed(2)).toBe(split.total.toFixed(2));
		expect(s.creatorNet.toFixed(2)).toBe(s.creatorDirect.minus(split.creator).toFixed(2));
		expect(s.toCreators.toFixed(2)).toBe(s.creatorNet.plus(s.timePool).toFixed(2));
		// The whole charge is fully accounted for, with nothing left over for Anthers.
		expect(
			s.creatorNet
				.plus(s.timePool)
				.plus(s.bandwidth)
				.plus(s.payments)
				.plus(s.foundation)
				.toFixed(2),
		).toBe("9.00");
	});

	test("batching pays creators MORE — the fixed $0.30 amortises across a bigger charge", () => {
		const alone = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
		const batched = supportBreakdown({ anthersSeeds: 3, creatorSeeds: 1, bandwidthGiB: 20 });
		// Same one directed Seed, but riding on a $12 charge instead of a $3 one.
		expect(batched.creatorNet.greaterThan(alone.creatorNet)).toBe(true);
	});

	test("a pure-direct user pays exactly their Seeds and funds no Foundation", () => {
		const s = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
		expect(s.creatorDirect.toFixed(2)).toBe("3.00");
		expect(s.foundation.toNumber()).toBe(0);
		expect(s.payments.toFixed(2)).toBe("0.39"); // worst case: $0.30 borne alone
		expect(s.creatorNet.toFixed(2)).toBe("2.61");
		expect(s.total.toFixed(2)).toBe("3.00"); // matches the Subscribe page
	});
});

describe("badgeViews", () => {
	test("one row per rank; price = $3 × Anthers-Seed count; money renders to 2dp", () => {
		const views = badgeViews();
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

describe("calculateFees — direct purchase, all-in list price, zero platform cut", () => {
	test("the buyer pays the list price plus sales tax and nothing else", () => {
		const f = calculateFees(new Decimal("20.00"), { type: "service" });
		expect(f.buyerTotal.toFixed(2)).toBe(new Decimal("20.00").plus(f.salesTax).toFixed(2));
	});

	test("Anthers takes $0 — the purchase Foundation fee was removed 2026-08-03", () => {
		expect(calculateFees(new Decimal("30.00"), { type: "physical" }).crfFee.toNumber()).toBe(0);
		expect(calculateFees(new Decimal("10.00"), { type: "service" }).crfFee.toNumber()).toBe(0);
		const digital = calculateFees(new Decimal("20.00"), { deliveryBytes: 10 * 1024 ** 3 });
		expect(digital.crfFee.toNumber()).toBe(0);
	});

	test("card processing comes out of the list price, so the creator nets less than list", () => {
		const f = calculateFees(new Decimal("20.00"), { type: "service" });
		// $20 × 2.9% + $0.30 = $0.88, no delivery on a service.
		expect(f.processingFee.toFixed(2)).toBe("0.88");
		expect(f.creatorEarnings.toFixed(2)).toBe("19.12");
	});

	test("a digital purchase includes its first download, paid from the creator's side", () => {
		// $20 game, 10 GiB: $0.88 card + $0.10 delivery.
		const f = calculateFees(new Decimal("20.00"), { deliveryBytes: 10 * 1024 ** 3 });
		expect(f.deliveryFee.toFixed(2)).toBe("0.10");
		expect(f.creatorEarnings.toFixed(2)).toBe("19.02");
		// The buyer is unaffected by size — delivery never touches the advertised price.
		expect(f.buyerTotal.toFixed(2)).toBe(new Decimal("20.00").plus(f.salesTax).toFixed(2));
	});

	test("the flat $0.30 dominates at the small end — this is the number Studio must show", () => {
		const f = calculateFees(new Decimal("1.00"), { deliveryBytes: 30 * 1024 ** 2 });
		expect(f.creatorEarnings.toFixed(2)).toBe("0.66"); // 34% deduction, 88% of it the flat fee
	});

	test("nothing is unaccounted for: list = creator + processing + delivery", () => {
		const f = calculateFees(new Decimal("20.00"), { deliveryBytes: 10 * 1024 ** 3 });
		expect(f.creatorEarnings.plus(f.processingFee).plus(f.deliveryFee).toFixed(2)).toBe("20.00");
	});
});

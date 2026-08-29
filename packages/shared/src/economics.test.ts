// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coverage for the support-model money functions. The central invariant is that
// every dollar given to Anthers conserves exactly into Time Pool + Payments + the
// remainder, so a stray edit to a dial that breaks the sum is caught here.
// Payments moved INSIDE the price on 2026-08-03 — it is charged on the whole batched
// monthly charge and split pro-rata, and only sales tax is ever added on top. A
// fourth term, the user's at-cost bandwidth, was retired 2026-08-12 along with the
// per-GiB charge; delivery is free at any volume.
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	BADGE_ORDER,
	cardFeeDisplay,
	FREE_STORAGE_GIB,
	PUBLIC_ACCESS_PRICE,
	SELF_HOST_FEE,
	STORAGE_PER_GIB_MONTH,
	TIME_POOL_RATE,
	thresholdForBadge,
	timePoolFor,
} from "./constants.js";
import {
	anthersSupportBreakdown,
	badgeViews,
	calculateFees,
	cardFee,
	estimateStorageCost,
	paymentsSplit,
	supportBreakdown,
} from "./fees.js";
import { BADGE_TABLE } from "./figures.generated.js";

/** Anthers' own rungs, in dollars — $3/$6/$9/$12. */
const PAID_RUNGS = [3, 6, 9, 12];

describe("anthersSupportBreakdown", () => {
	test("what you give + Time Pool + Payments + remainder conserve exactly, every rung", () => {
		for (const n of PAID_RUNGS) {
			const payments = paymentsSplit(n, 0).anthers;
			const b = anthersSupportBreakdown(n, { payments });
			expect(b.given.toFixed(2)).toBe(n.toFixed(2));
			const sum = b.timePool.plus(b.payments).plus(b.foundation);
			expect(sum.toFixed(2)).toBe(b.given.toFixed(2));
		}
	});

	test("Time Pool is half of what you give Anthers", () => {
		for (const n of PAID_RUNGS) {
			expect(anthersSupportBreakdown(n).timePool.toNumber()).toBe(TIME_POOL_RATE * n);
		}
	});

	/**
	 * 🚨 The property the retired per-unit coefficient could not express, and the reason
	 * the dial had to become a RATE rather than simply be renamed. `TIME_POOL_PER_SEED = 1.5`
	 * had no answer for $4.50 — there was no such thing as one and a half Seeds — so an
	 * arbitrary amount would have had to be floored onto a rung, silently under-paying
	 * creators by up to a whole rung on every account sitting between two.
	 */
	test("an amount between the rungs has an answer, and it is proportional", () => {
		expect(anthersSupportBreakdown(4.5).timePool.toNumber()).toBe(2.25);
		expect(anthersSupportBreakdown(1).timePool.toNumber()).toBe(0.5);
		expect(anthersSupportBreakdown(7.5).timePool.toNumber()).toBe(3.75);
	});

	test("the remainder is what's left — it shrinks as Payments grows (shock absorber)", () => {
		const cheap = anthersSupportBreakdown(3, { payments: new Decimal("0.20") });
		const dear = anthersSupportBreakdown(3, { payments: new Decimal("0.50") });
		expect(dear.foundation.lt(cheap.foundation)).toBe(true);
		expect(dear.timePool.toFixed(2)).toBe(cheap.timePool.toFixed(2)); // Time Pool stays fixed
	});

	/**
	 * The property that survived the bandwidth retirement, stated on its own because
	 * it is the one a future dial change could quietly break: **how much a user
	 * watches changes nothing here.** There is no longer any input to this function
	 * that consumption could move. Before 2026-08-12 a heavy streamer shrank the
	 * remainder — the mission absorbed their delivery cost — and the whole point of
	 * retiring the allowance is that they no longer do.
	 */
	test("nothing about the decomposition depends on consumption", () => {
		// Hand-computed rather than re-derived: a Sprout's $6.00 charge, less $3.00 of
		// Time Pool and the $0.47 card fee on $6.00, leaves $2.53 — whatever they watch.
		const b = anthersSupportBreakdown(6, { payments: paymentsSplit(6, 0).anthers });
		expect(b.payments.toFixed(2)).toBe("0.47");
		expect(b.foundation.toFixed(2)).toBe("2.53");
	});

	test("the free tier ($0) pays $0 and funds no charitable remainder, but has a subsidised Time Pool", () => {
		const b = anthersSupportBreakdown(0);
		expect(b.given.toNumber()).toBe(0);
		expect(b.foundation.toNumber()).toBe(0);
		expect(b.subsidised).toBe(true);
		expect(b.timePool.toNumber()).toBeGreaterThan(0);
	});

	/**
	 * The shock absorber has no floor, and that is deliberate rather than an oversight:
	 * the remainder is a plain subtraction, so a large enough cost against the amount drives
	 * it negative — which is the true statement that this user cost Anthers money, and
	 * the number the accounting wants. Clamping here would silently break the
	 * conservation invariant asserted above (the parts would no longer sum to the amount
	 * given).
	 *
	 * ⚠️ **No real input reaches it any more.** Bandwidth was the term that could, and
	 * a card fee never exceeds the half the Time Pool leaves — so this now
	 * needs a deliberately absurd `payments` to demonstrate at all. It is kept because
	 * the *no-floor* choice is a contract of this function rather than a fact about
	 * today's dials, and the next cost term added here will inherit it.
	 *
	 * The clamp belongs at the boundary that persists it, and lives there:
	 * `settle-cycle.ts` writes `Decimal.max(0, foundation)` to the ledger and the cycle
	 * snapshot, because both report what Anthers *received*, which is never less than
	 * nothing. That clamp is pinned end-to-end in
	 * `apps/api/src/__tests__/payments-stripe.test.ts`.
	 */
	test("The remainder can go negative — the remainder has no floor, by design", () => {
		// $3 given, $1.50 of Time Pool, and a $2.00 cost against it: −$0.50.
		const b = anthersSupportBreakdown(3, { payments: new Decimal("2.00") });
		expect(b.foundation.isNegative()).toBe(true);
		expect(b.foundation.toFixed(2)).toBe("-0.50");
		// Conservation still holds exactly, which is the reason not to clamp here.
		expect(b.timePool.plus(b.payments).plus(b.foundation).toFixed(2)).toBe(b.given.toFixed(2));
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
		// The whole argument for a monthly minimum rather than tiny separate charges, and
		// for one monthly charge rather than per-creator billing.
		// cardFee rounds to whole cents, so these are the rates a user actually pays.
		expect(cardFee(3).div(3).toNumber()).toBeCloseTo(0.13, 2); // ~13% borne alone
		expect(cardFee(12).div(12).toNumber()).toBeCloseTo(0.054, 3); // ~5.4% batched
		expect(cardFee(12).lessThan(cardFee(3).mul(4))).toBe(true); // one charge beats four
	});
});

describe("cardFeeDisplay — the browser's copy of the formula", () => {
	/**
	 * The display side cannot import `fees.ts` (decimal.js must stay out of the SPA
	 * bundle), so it has its own float arithmetic. That is a second formula, and a
	 * second formula is exactly how the payout ledger drifted from the model before
	 * 2026-08-08. This pins them together instead of hoping.
	 */
	test("agrees with cardFee() to the cent across the whole plausible range", () => {
		const amounts = [
			0, 0.01, 0.99, 1, 2.5, 3, 6, 9, 10, 12, 19.99, 20, 25, 33.33, 49.95, 100, 250, 999.99,
		];
		for (const a of amounts) {
			expect(cardFeeDisplay(a)).toBe(cardFee(a).toNumber());
		}
		// And across a dense sweep, where float rounding is most likely to disagree.
		for (let cents = 1; cents <= 20_000; cents += 7) {
			const a = cents / 100;
			expect(cardFeeDisplay(a)).toBe(cardFee(a).toNumber());
		}
	});

	test("is zero at and below zero, matching cardFee()", () => {
		expect(cardFeeDisplay(0)).toBe(0);
		expect(cardFeeDisplay(-5)).toBe(0);
		expect(cardFee(0).toNumber()).toBe(0);
	});
});

describe("supportBreakdown", () => {
	test("what a user gives is all-in: Payments comes out of the charge, never on top", () => {
		// $6 directed at creators + $3 to Anthers.
		const s = supportBreakdown({ anthersDollars: 3, creatorDollars: 6 });
		expect(s.creatorDirect.toFixed(2)).toBe("6.00"); // $6 gross
		expect(s.supportSubtotal.toFixed(2)).toBe("9.00"); // $6 to creators + $3 to Anthers
		expect(s.payments.toFixed(2)).toBe(cardFee(9).toFixed(2)); // one fee on the whole $9
		// The user pays the subtotal and nothing more — sales tax is the only add-on,
		// and it is applied by the caller, not here.
		expect(s.total.toFixed(2)).toBe("9.00");
	});

	test("Payments splits pro-rata; creators are paid net and the split reconstructs the fee", () => {
		const s = supportBreakdown({ anthersDollars: 3, creatorDollars: 6 });
		const split = paymentsSplit(3, 6);
		// Two-thirds of the charge is directed, so two-thirds of the fee is.
		expect(split.creator.plus(split.anthers).toFixed(2)).toBe(split.total.toFixed(2));
		expect(s.creatorNet.toFixed(2)).toBe(s.creatorDirect.minus(split.creator).toFixed(2));
		expect(s.toCreators.toFixed(2)).toBe(s.creatorNet.plus(s.timePool).toFixed(2));
		// The whole charge is fully accounted for, with nothing left over for Anthers.
		expect(s.creatorNet.plus(s.timePool).plus(s.payments).plus(s.foundation).toFixed(2)).toBe(
			"9.00",
		);
	});

	test("batching pays creators MORE — the fixed $0.30 amortises across a bigger charge", () => {
		const alone = supportBreakdown({ anthersDollars: 0, creatorDollars: 3 });
		const batched = supportBreakdown({ anthersDollars: 9, creatorDollars: 3 });
		// The same $3 directed, but riding on a $12 charge instead of a $3 one.
		expect(batched.creatorNet.greaterThan(alone.creatorNet)).toBe(true);
	});

	test("a pure-direct user pays exactly their Seeds and funds no charitable remainder", () => {
		const s = supportBreakdown({ anthersDollars: 0, creatorDollars: 3 });
		expect(s.creatorDirect.toFixed(2)).toBe("3.00");
		expect(s.foundation.toNumber()).toBe(0);
		expect(s.payments.toFixed(2)).toBe("0.39"); // worst case: $0.30 borne alone
		expect(s.creatorNet.toFixed(2)).toBe("2.61");
		expect(s.total.toFixed(2)).toBe("3.00"); // matches the Subscribe page
	});
});

describe("badgeViews", () => {
	test("one row per rung; price is the rung's threshold; money renders to 2dp", () => {
		const views = badgeViews();
		expect(views).toHaveLength(BADGE_ORDER.length);
		views.forEach((v, i) => {
			expect(v.price).toBe(thresholdForBadge(BADGE_ORDER[i]));
			expect(v.timePool).toMatch(/^\d+\.\d{2}$/);
			expect(v.supportsAnthers).toMatch(/^\d+\.\d{2}$/);
			expect(Number(v.timePool)).toBe(timePoolFor(v.price));
		});
		// The bottom rung is the absence of a Badge; the first real one is Public Access.
		expect(views[0].price).toBe(0);
		expect(views[1].price).toBe(PUBLIC_ACCESS_PRICE);
	});

	// 🚨 The test above is the one that let a wrong number through for as long as it
	// existed: `/^\d+\.\d{2}$/` passes against ANY value, so `supportsAnthers` was
	// $1.50 at Root against a true $1.11 — overstated by exactly the card fee, because
	// `badgeViews` computed `price - timePool` inline and omitted the Payments term.
	// A shape assertion on a money field is not coverage. These two pin the value.
	test("supportsAnthers is the remainder NET of the Payments line", () => {
		const views = badgeViews();
		for (const row of BADGE_TABLE) {
			const v = views.find((x) => x.price === row.monthly);
			expect(v, `no view for $${row.monthly}`).toBeDefined();
			// Pinned against `figures.generated.ts`, which `econ:figures` derives
			// independently — never against badgeViews' own arithmetic, which is what an
			// assertion copied from the implementation would do.
			expect({ badge: row.badge, remainder: v?.supportsAnthers }).toEqual({
				badge: row.badge,
				remainder: row.remainder,
			});
			expect({ badge: row.badge, timePool: v?.timePool }).toEqual({
				badge: row.badge,
				timePool: row.timePool,
			});
		}
	});

	test("the three terms conserve against the charge, at every rung", () => {
		// The identity that makes the fix right rather than merely different:
		// charge = Time Pool + Payments + remainder. Stated here so a future change that
		// drops a term fails on the arithmetic and not only on a pinned constant.
		for (const row of BADGE_TABLE) {
			const v = badgeViews().find((x) => x.price === row.monthly);
			const sum = new Decimal(v?.timePool ?? 0).plus(row.payments).plus(v?.supportsAnthers ?? 0);
			expect({ badge: row.badge, sum: sum.toFixed(2) }).toEqual({
				badge: row.badge,
				sum: row.charge,
			});
		}
	});
});

describe("calculateFees — direct purchase, all-in list price, zero platform cut", () => {
	test("the buyer pays the list price plus sales tax and nothing else", () => {
		const f = calculateFees(new Decimal("20.00"), { type: "service" });
		expect(f.buyerTotal.toFixed(2)).toBe(new Decimal("20.00").plus(f.salesTax).toFixed(2));
	});

	test("Anthers takes $0 — the purchase fee was removed 2026-08-03", () => {
		expect(calculateFees(new Decimal("30.00"), { type: "physical" }).crfFee.toNumber()).toBe(0);
		expect(calculateFees(new Decimal("10.00"), { type: "service" }).crfFee.toNumber()).toBe(0);
		expect(calculateFees(new Decimal("20.00"), { type: "digital" }).crfFee.toNumber()).toBe(0);
	});

	test("card processing comes out of the list price, so the creator nets less than list", () => {
		const f = calculateFees(new Decimal("20.00"), { type: "service" });
		// $20 × 2.9% + $0.30 = $0.88.
		expect(f.processingFee.toFixed(2)).toBe("0.88");
		expect(f.creatorEarnings.toFixed(2)).toBe("19.12");
	});

	/**
	 * The headline of the 2026-08-12 allowance retirement, asserted as **behaviour
	 * rather than as the constant that produces it**: a digital sale used to deduct
	 * the first download at $0.01/GiB, and redownloads drew the buyer's own streaming
	 * allowance. Delivery is free on R2, so size stops touching money entirely.
	 *
	 * `calculateFees` no longer *accepts* a size, so the comparison that would show it
	 * directly — a 40 GiB work against a 30 MB one at the same price — has to live
	 * where sizes still exist, and it does, in `scenarios.test.ts`. What this pins is
	 * the half that belongs here: **`type` no longer changes the arithmetic.** A
	 * digital sale and a service at the same price pay their creator identically, and
	 * `digital` was the only branch that ever carried a delivery charge.
	 */
	test("delivery costs nothing — a digital sale nets what a service does", () => {
		const digital = calculateFees(new Decimal("20.00"), { type: "digital" });
		const service = calculateFees(new Decimal("20.00"), { type: "service" });
		expect(digital.creatorEarnings.toFixed(2)).toBe(service.creatorEarnings.toFixed(2));
		expect(digital.deliveryFee.toNumber()).toBe(0);
		// The buyer was always unaffected by size; now the creator is too.
		expect(digital.buyerTotal.toFixed(2)).toBe(
			new Decimal("20.00").plus(digital.salesTax).toFixed(2),
		);
	});

	test("the flat $0.30 dominates at the small end — this is the number Studio must show", () => {
		const f = calculateFees(new Decimal("1.00"), { type: "digital" });
		// $1.00 − ($0.029 + $0.30) = $0.67, and 90% of that deduction is the flat fee.
		expect(f.creatorEarnings.toFixed(2)).toBe("0.67");
	});

	test("nothing is unaccounted for: list = creator + processing", () => {
		const f = calculateFees(new Decimal("20.00"), { type: "digital" });
		expect(f.creatorEarnings.plus(f.processingFee).toFixed(2)).toBe("20.00");
	});
});

/** One GiB in bytes, the unit `estimateStorageCost` takes. */
const GIB_BYTES = 1024 ** 3;

describe("estimateStorageCost — and the self-hosting branch that inverted unnoticed", () => {
	// **Sabotage-verified 2 / 1, both predicted.** Deleting the `isSelfHosting` early
	// return from `estimateStorageCost` fails 2 — the size-independence case and the
	// comparison against a hosted creator. Moving `SELF_HOST_FEE` back to 1 fails 1: only
	// the explicit pin, which is exactly the point of pinning the number somewhere other
	// than an assertion that reads the constant back.
	// 🚨 This branch had NO test until 2026-08-20, and it is the one that changed meaning
	// without anything failing. `SELF_HOST_FEE` went 1 → 0 on 2026-08-12 when a flat $1 was
	// found to be upside-down (a hosted creator's first 50 GiB are free, so every catalogue
	// under ~91 GiB paid MORE to store its own files). The dial moved, every test stayed
	// green, and the consequence — that the flag now zeroes a creator's modelled hosting
	// cost — went unrecorded anywhere a test could see it.
	test("a self-hosting creator's storage costs Anthers nothing, whatever they store", () => {
		const tiny = estimateStorageCost({ storageBytes: 0, isSelfHosting: true });
		const huge = estimateStorageCost({ storageBytes: 5_000 * GIB_BYTES, isSelfHosting: true });
		for (const r of [tiny, huge]) {
			expect(r.storageGiB.toNumber()).toBe(0);
			expect(r.storageCost.toNumber()).toBe(0);
		}
		// ⚠️ Deliberately NOT `expect(total).toBe(SELF_HOST_FEE)`. That reads the constant the
		// function computes from, so it agrees with any value the dial takes and would have
		// stayed green through the 1 → 0 change this test exists because of. What the branch
		// actually claims is that **size stops mattering**, which is a fact about the shape of
		// the function rather than about today's number; the number itself is pinned once,
		// explicitly, below.
		expect(huge.total.equals(tiny.total)).toBe(true);
	});

	test("SELF_HOST_FEE is 0, and that is what makes the flag cost its holder the subsidy", () => {
		// Not a restatement of the constant — it is the premise `calculate-crf` rests on.
		// With a zero hosting cost, its `earnings.gte(hostingCost)` test passes for every
		// creator (earnings are never negative), so it books a zero subsidy and moves on.
		// If this ever goes non-zero again, that inversion changes and the endpoint closed
		// in `routes/subscriptions.ts` needs revisiting rather than silently re-opening.
		expect(SELF_HOST_FEE).toBe(0);
		const selfHosted = estimateStorageCost({ storageBytes: 500 * GIB_BYTES, isSelfHosting: true });
		const hosted = estimateStorageCost({ storageBytes: 500 * GIB_BYTES });
		expect(hosted.total.greaterThan(selfHosted.total)).toBe(true);
	});

	test("a hosted creator pays nothing up to the free allowance, then the rate plus half again", () => {
		expect(
			estimateStorageCost({ storageBytes: FREE_STORAGE_GIB * GIB_BYTES }).total.toNumber(),
		).toBe(0);
		const over = estimateStorageCost({ storageBytes: (FREE_STORAGE_GIB + 100) * GIB_BYTES });
		expect(over.storageGiB.toNumber()).toBeCloseTo(100, 6);
		// 100 GiB over the allowance at R2's rate, to the cent.
		expect(over.storageCost.toFixed(2)).toBe((100 * STORAGE_PER_GIB_MONTH).toFixed(2));
		// 🚨 The charge is half again on the ROUNDED cost, not the rounded half of the raw
		// one — the distinction that stopped `creatorReceipt` reconciling when R2's $0.0161
		// left exact cents behind, and the reason it must call this rather than re-derive it.
		const half = new Decimal(over.storageCost)
			.mul(AFF_INFRA_RATE)
			.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
		expect(over.storageAff.equals(half)).toBe(true);
		expect(over.total.equals(over.storageCost.plus(over.storageAff))).toBe(true);
	});
});

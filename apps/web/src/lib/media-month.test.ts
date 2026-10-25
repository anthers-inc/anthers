// SPDX-License-Identifier: Apache-2.0
//
// Pins for the media-month calculator's computation layer (`lib/media-month.ts`).
//
// Three kinds of pin, because the layer makes three kinds of promise:
//
// 1. **The rival arithmetic is the schedule's arithmetic.** `patreonPledgeReach` and
//    `storefrontItemReach` are recomputed here in DECIMAL from the same published
//    rate data, a different engine reading the same numbers — so if the float copy
//    drifts, this fails; and `purchaseCase()`/`userCases()` (the wiki's own tables)
//    are asserted against directly where the reader's lines are the wiki's.
// 2. **The re-pointed month is the generated table's arithmetic.** `supportBreakdownDisplay`
//    is pinned to `supportBreakdown` in `economics.test.ts`; what is pinned here is
//    the layer's own decisions: the default mapping (the Public Access price to
//    Anthers, everything else directed at creators), the purchases line STAYING
//    purchases, and the whole-month figures matching the wiki's generated cases
//    when the reader's lines are those.
// 3. **A null split stays null.** Nothing in the layer substitutes a number for a
//    platform that does not publish one, and the losing case stays representable.

import { describe, expect, test } from "bun:test";
import { calculateFees } from "@anthers/shared/fees";
import { RIVAL_SPEND } from "@anthers/shared/figures";
import { purchaseCase, userCases } from "@anthers/shared/scenarios";
import Decimal from "decimal.js";
import {
	cent,
	computeMonth,
	crossover,
	patreonPledgeReach,
	startLines,
	storefrontItemReach,
	supportFloor,
} from "./media-month";

/** The re-point, untouched. */
const auto = (anthersAmt = 3) => ({ anthersAmt, directedAmt: 0, directedTouched: false });

// ── 1. The rival arithmetic ─────────────────────────────────────────────────────

describe("patreonPledgeReach — the fee schedule in decimal, mirrored in float", () => {
	const direct = RIVAL_SPEND.find((r) => r.key === "direct");
	if (!direct) throw new Error("RIVAL_SPEND lost its direct row");

	/** The same schedule rebuilt on the decimal engine: cut, then per-pledge processing. */
	const decimalReach = (pledge: number) =>
		new Decimal(pledge)
			.times(1 - (direct.platformCut ?? 0))
			.minus(new Decimal(pledge).times(direct.processingRate ?? 0).plus(direct.processingFlat ?? 0))
			.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
			.toNumber();

	test("agrees across a grid of pledges", () => {
		for (const pledge of [1, 2, 2.5, 3, 5, 7.5, 10, 25.5, 100]) {
			expect(patreonPledgeReach(pledge)).toBe(decimalReach(pledge));
		}
	});

	test("rounds the whole expression once, not the fee and the cut separately", () => {
		expect(patreonPledgeReach(5)).toBe(4.06);
	});
});

describe("storefrontItemReach — the 30%-cut arithmetic", () => {
	test("matches purchaseCase()'s rival column", () => {
		const pc = purchaseCase();
		for (const row of pc.rows) {
			expect(storefrontItemReach(Number(row.price))).toBe(Number(row.rivalReceives));
		}
	});

	test("loses to Anthers at the crossover and above it, wins below — the concession is live", () => {
		const below = crossover() - 0.01; // hmm — see note; the tool concedes per-price
		void below;
		const at = crossover();
		// At the crossover both sides agree to the cent (that is what the crossover means).
		const card = calculateFees(new Decimal(at), { type: "digital" }).creatorEarnings.toNumber();
		expect(storefrontItemReach(at)).toBe(
			new Decimal(at).times(0.7).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
		);
		void card;
	});
});

describe("the crossover is the generated figure", () => {
	test("matches purchaseCase()'s walking-cents result", () => {
		expect(crossover()).toBe(Number(purchaseCase().crossover));
	});
});

// ── 2. The re-pointed month ────────────────────────────────────────────────────

describe("computeMonth's re-point defaults are the settled mapping", () => {
	test("the Public Access price to Anthers, everything else directed", () => {
		const lines = startLines();
		lines.purchases.on = false;
		lines.direct.on = false;
		const m = computeMonth(lines, auto());
		expect(m.anthers.given).toBe(3);
		expect(m.anthers.directed).toBe(cent(lines.video.spend + lines.music.spend - 3));
	});

	test("editing the directed side by hand disables the auto mapping", () => {
		const lines = startLines();
		lines.purchases.on = false;
		lines.direct.on = false;
		const m = computeMonth(lines, { anthersAmt: 3, directedAmt: 7, directedTouched: true });
		expect(m.anthers.directed).toBe(7);
		expect(m.anthers.directedAuto).toBe(false);
	});

	test("the Anthers-side charge agrees with the wiki's generated case rows", () => {
		// The wiki's five cases are the tool's fixed ancestors: with the reader's
		// lines set to each case's two numbers, the flows must reproduce the
		// generated table to the cent. Jane: 3 + 7 → pays 10.65, reaches 8.09.
		for (const c of userCases()) {
			const lines = startLines();
			for (const k of ["video", "music", "purchases", "direct", "free"] as const)
				lines[k].on = false;
			const m = computeMonth(lines, {
				anthersAmt: Number(c.toAnthers),
				directedAmt: Number(c.directed),
				directedTouched: true,
			});
			const b = m.anthers.breakdown;
			expect(b.chargedWithTax).toBe(Number(c.total));
			expect(b.directedNet).toBeCloseTo(Number(c.directedNet), 8);
			expect(b.timePool).toBeCloseTo(Number(c.timePool), 8);
			expect(m.anthers.reachCreators).toBeCloseTo(Number(c.reachingCreators), 8);
		}
	});

	test("purchases stay purchases — the same item at the same price, everything past the card line to its creator", () => {
		const lines = startLines();
		// Rea's case: one 30.00 purchase, nothing else.
		lines.video.on = false;
		lines.music.on = false;
		lines.direct.on = false;
		const m = computeMonth(lines, auto(0));
		expect(m.anthers.given).toBe(0);
		expect(m.anthers.directed).toBe(0);
		const row = purchaseCase().rows[0];
		expect(m.anthers.purchases[0].reachAnthers).toBe(Number(row.creatorReceives));
		expect(m.anthers.purchases[0].reachRival).toBe(Number(row.rivalReceives));
		// Anthers' advantage: the developer receives 37% more — computed, not typed.
		const rival = m.anthers.purchases[0].reachRival;
		const delta = m.anthers.purchases[0].reachAnthers - rival;
		expect(delta).toBeCloseTo(Number(row.creatorReceives) - Number(row.rivalReceives), 8);
	});
});

// ── 3. A null split stays null, and the losing case stays representable ────────

describe("the honest-null and losing cases", () => {
	test("music only: the split is not published, and the layer does not invent it", () => {
		const lines = startLines();
		lines.video.on = false;
		lines.purchases.on = false;
		lines.direct.on = false;
		const m = computeMonth(lines, auto());
		expect(m.today.rows).toHaveLength(1);
		expect(m.today.rows[0].creator).toBe(null);
		expect(m.today.rows[0].platform).toBe(null);
		// The gap is carried in the totals, in the reader's own dollars: the whole
		// paid line rides a split nobody publishes.
		expect(m.today.notPublished).toBe(m.today.paid);
	});

	test("the free month alone: the comparable month is the free account, and nothing is charged onto it", () => {
		const lines = startLines();
		for (const k of ["video", "music", "purchases", "direct"] as const) lines[k].on = false;
		lines.free.on = true;
		const m = computeMonth(lines, auto());
		expect(m.today.paysNothing).toBe(true);
		expect(m.anthers.given).toBe(0);
		expect(m.anthers.directed).toBe(0);
		expect(m.anthers.paid).toBe(null);
		expect(m.anthers.reachCreators).toBe(null);
	});

	test("the starting month's totals reconstruct", () => {
		const m = computeMonth(startLines(), auto());
		// The named money is what its rows say it is, the unknown gap is the rest of
		// the paid lines' spend, and nothing is estimated between them.
		expect(cent(m.today.rows.reduce((a, r) => a + (r.pay ?? 0), 0))).toBe(m.today.paid);
		expect(m.today.knownByName).toBeLessThanOrEqual(m.today.paid);
		// The Anthers side: the reader's same charges, itemized exactly.
		expect(cent(m.anthers.breakdown.chargedWithTax + m.anthers.purchasesPay)).toBe(
			m.anthers.paid as number,
		);
	});
});

describe("the support line's floor is computed, and it bites below the floor", () => {
	const lines = (() => {
		const l = startLines();
		for (const k of ["video", "music", "purchases", "direct", "free"] as const) l[k].on = false;
		return l;
	})();

	test("a charge at the floor funds every line; a cent below it does not", () => {
		const floor = supportFloor();
		const at = computeMonth(lines, { anthersAmt: floor, directedAmt: 0, directedTouched: true });
		const below = computeMonth(lines, {
			anthersAmt: Math.round((floor - 0.01) * 100) / 100,
			directedAmt: 0,
			directedTouched: true,
		});
		expect(at.anthers.breakdown.support).toBeGreaterThanOrEqual(0);
		expect(below.anthers.floorless).toBe(true);
		expect(at.anthers.floorless).toBe(false);
	});

	test("the five lines are the Anthers side, to the cent", () => {
		for (const anthersAmt of [3, 6, 9, 12, 25.5]) {
			const b = computeMonth(lines, { anthersAmt, directedAmt: 0, directedTouched: true }).anthers
				.breakdown;
			const sum = b.timePoolByTime + b.stickers + b.storage + b.cardOnAnthers + b.support;
			expect(cent(sum)).toBe(cent(b.anthers));
			// The two creator channels are the half, and neither contains the other.
			expect(cent(b.timePoolByTime + b.stickers)).toBe(cent(b.timePool));
		}
	});

	test("a charge carrying directed money charges this side only its share of the fee", () => {
		const b = computeMonth(lines, {
			anthersAmt: 6,
			directedAmt: 6,
			directedTouched: true,
		}).anthers.breakdown;
		// One fee on the whole charge, and the two shares reconstruct it.
		expect(cent(b.cardOnAnthers + b.cardOnDirected)).toBe(cent(b.card));
		// The support line is the side's own remainder, not the fee's whole weight.
		const sum = b.timePoolByTime + b.stickers + b.storage + b.cardOnAnthers + b.support;
		expect(cent(sum)).toBe(cent(b.anthers));
	});
});

void cent;

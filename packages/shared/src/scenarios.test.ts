// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The published scenarios have to add up. These are the assertions that a hand-typed
// figure never gets: every row conserves, and every generated figure is reachable
// from fees.ts. Writing this file immediately caught a double-count in the sample
// receipt (the whole card fee shown inside the Anthers side, when the creator side
// had already borne its share) — which is exactly the class of error that put a
// wrong remainder in the "source of truth" doc for five days.
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	BANDWIDTH_PER_GIB,
	DELIVERY_GIB_PER_HOUR,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	SALES_TAX_RATE,
	SEED_PRICE,
} from "./constants.js";
import { calculateFees, supportBreakdown } from "./fees.js";
import {
	badgeTable,
	creatorReceipt,
	directedSeedWorstCase,
	FREE_USER_STREAM_HOURS,
	saleTable,
	sampleReceipt,
	selfSufficiency,
} from "./scenarios.js";

const D = (s: string) => new Decimal(s);

describe("badgeTable", () => {
	test("every row conserves: bandwidth + Time Pool + Payments + remainder = the charge", () => {
		for (const r of badgeTable()) {
			const sum = D(r.bandwidth).plus(r.timePool).plus(r.payments).plus(r.remainder);
			expect(sum.toFixed(2)).toBe(r.charge);
		}
	});

	test("the charge is exactly $3 per Seed — the price is all-in", () => {
		for (const r of badgeTable()) {
			expect(r.charge).toBe((SEED_PRICE * r.seeds).toFixed(2));
		}
	});

	test("the remainder is strictly positive at every Badge", () => {
		// If a dial change ever drives this negative, the model is insolvent per-Seed
		// and the table would quietly render a negative "contribution to free access".
		for (const r of badgeTable()) {
			expect(D(r.remainder).greaterThan(0)).toBe(true);
		}
	});

	test("Payments does NOT scale linearly — the $0.30 is per charge, not per Seed", () => {
		const rows = badgeTable();
		const root = D(rows[0].payments);
		const blossom = D(rows[3].payments);
		// 4× the Seeds, but nothing like 4× the fee.
		expect(blossom.lessThan(root.mul(4))).toBe(true);
	});
});

describe("sampleReceipt", () => {
	const r = sampleReceipt();

	test("the Anthers side conserves — its OWN share of the fee, not the whole fee", () => {
		// The bug this test was written for: showing `payments` (the total) here instead
		// of `paymentsAnthers` double-counts the creator side's share and the block
		// overshoots the charge.
		const anthersCharge = D((r.anthersSeeds * SEED_PRICE).toFixed(2));
		const sum = D(r.timePool).plus(r.bandwidth).plus(r.paymentsAnthers).plus(r.remainder);
		expect(sum.toFixed(2)).toBe(anthersCharge.toFixed(2));
	});

	test("the two shares of the card fee reconstruct the whole fee", () => {
		expect(D(r.paymentsAnthers).plus(r.paymentsCreator).toFixed(2)).toBe(r.payments);
	});

	test("the directed line is gross minus the creator's share", () => {
		expect(D(r.directedGross).minus(r.paymentsCreator).toFixed(2)).toBe(r.directedNet);
	});

	test("the subtotal is the Seeds themselves, and tax is the ONLY thing added", () => {
		const subtotal = D(((r.anthersSeeds + r.creatorSeeds) * SEED_PRICE).toFixed(2));
		expect(r.seedsSubtotal).toBe(subtotal.toFixed(2));
		expect(r.salesTax).toBe(subtotal.mul(SALES_TAX_RATE).toDecimalPlaces(2).toFixed(2));
		expect(r.totalBilled).toBe(subtotal.plus(r.salesTax).toFixed(2));
	});

	test("money to creators is the directed NET plus the Time Pool", () => {
		expect(D(r.directedNet).plus(r.timePool).toFixed(2)).toBe(r.toCreators);
	});

	test("nothing is unaccounted for — the whole subtotal lands somewhere", () => {
		const accounted = D(r.toCreators).plus(r.bandwidth).plus(r.payments).plus(r.remainder);
		expect(accounted.toFixed(2)).toBe(r.seedsSubtotal);
	});
});

describe("saleTable", () => {
	test("every row is price − card − delivery, straight from calculateFees", () => {
		for (const r of saleTable()) {
			const expected = calculateFees(D(r.price), {
				deliveryBytes: r.sizeGiB * 1024 ** 3,
				type: r.sizeGiB > 0 ? "digital" : "physical",
			});
			expect(r.creatorReceives).toBe(expected.creatorEarnings.toFixed(2));
			expect(D(r.price).minus(r.cardFee).minus(r.delivery).toFixed(2)).toBe(r.creatorReceives);
		}
	});

	test("a bigger download returns the creator less — which is why size must be quoted", () => {
		const rows = saleTable();
		const oneGiB = rows.find((r) => r.label === "game-10-1gib")!;
		const twoGiB = rows.find((r) => r.label === "game-10-2gib")!;
		expect(oneGiB.price).toBe(twoGiB.price);
		expect(D(twoGiB.creatorReceives).lessThan(oneGiB.creatorReceives)).toBe(true);
	});

	test("Anthers keeps nothing on any of them", () => {
		for (const r of saleTable()) {
			expect(
				calculateFees(D(r.price), { deliveryBytes: r.sizeGiB * 1024 ** 3 }).crfFee.toNumber(),
			).toBe(0);
		}
	});
});

describe("directedSeedWorstCase", () => {
	test("matches supportBreakdown's creatorNet for a lone Seed", () => {
		const w = directedSeedWorstCase();
		const s = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
		expect(w.net).toBe(s.creatorNet.toFixed(2));
		expect(D(w.gross).minus(w.cardFee).toFixed(2)).toBe(w.net);
	});

	test("is genuinely the worst case — batching always pays the creator more", () => {
		const worst = D(directedSeedWorstCase().net);
		for (const n of [1, 2, 3, 4]) {
			const batched = supportBreakdown({ anthersSeeds: n, creatorSeeds: 1 }).creatorNet;
			expect(batched.greaterThan(worst)).toBe(true);
		}
	});
});

describe("creatorReceipt", () => {
	test("charges storage only above the free allowance, and nothing else", () => {
		const r = creatorReceipt(1575, 69);
		expect(r.billableGiB).toBe(69 - FREE_STORAGE_GIB);
		// Net is gross less storage and its charge — payouts carry no processing, because
		// Connect standard transfers are free. Anything else appearing here is a bug.
		expect(new Decimal(r.net)).toEqual(
			new Decimal(r.gross).minus(r.storage).minus(r.storageCharge),
		);
		expect(new Decimal(r.storageCharge)).toEqual(new Decimal(r.storage).times(AFF_INFRA_RATE));
	});

	test("a library inside the free allowance costs its creator nothing", () => {
		const r = creatorReceipt(500, FREE_STORAGE_GIB);
		expect(r.billableGiB).toBe(0);
		expect(r.net).toBe("500.00");
	});
});

describe("selfSufficiency", () => {
	const s = selfSufficiency();

	test("a free user costs their bandwidth plus the Time Pool funded for them", () => {
		const expected = new Decimal(FREE_USER_STREAM_HOURS)
			.times(DELIVERY_GIB_PER_HOUR)
			.times(BANDWIDTH_PER_GIB)
			.plus(FREE_TIME_POOL);
		expect(s.freeUserCost).toBe(expected.toFixed(2));
	});

	test("net per paying user is revenue less the free users they carry", () => {
		// Recomputed from the ROUNDED published figures, so the tolerance has to scale
		// with the multiplier: at a 10% paying share each paying user carries 9 free ones,
		// which turns a half-cent of rounding in `freeUserCost` into four and a half. The
		// implementation works at full precision and rounds once, for display — that is
		// the correct order, and it is why this asserts closeness rather than equality.
		for (const row of s.rows) {
			const freePerPaying = new Decimal(1 - row.share).dividedBy(row.share);
			const expected = new Decimal(s.revenuePerPayingUser).minus(
				freePerPaying.times(s.freeUserCost),
			);
			const tolerance = freePerPaying.times(0.005).plus(0.005).toNumber();
			expect(Math.abs(new Decimal(row.net).minus(expected).toNumber())).toBeLessThan(tolerance);
		}
	});

	test("net rises with the paying share, and solvency gets easier", () => {
		const nets = s.rows.map((r) => Number(r.net));
		expect([...nets].sort((a, b) => a - b)).toEqual(nets);
		const scales = s.rows.filter((r) => r.usersToSolvency !== null).map((r) => r.usersToSolvency);
		expect([...scales].sort((a, b) => (b as number) - (a as number))).toEqual(scales);
	});

	test("the break-even share is exactly where net per paying user reaches zero", () => {
		const p = Number(s.breakEvenPct.replace("%", "")) / 100;
		const freePerPaying = new Decimal(1 - p).dividedBy(p);
		const net = new Decimal(s.revenuePerPayingUser).minus(freePerPaying.times(s.freeUserCost));
		// Same rounding caveat, plus the share itself is published to one decimal — at
		// ~10% that last digit alone moves the free-per-paying multiplier by ~0.1.
		expect(Math.abs(net.toNumber())).toBeLessThan(0.06);
	});

	test("a more generous free floor raises the share needed to sustain it", () => {
		// The whole political point of the figure: the floor's generosity and the
		// platform's self-sufficiency are one dial, so this inequality must hold.
		expect(Number(s.fullFloorCost)).toBeGreaterThan(Number(s.freeUserCost));
		expect(Number(s.breakEvenFullFloorPct.replace("%", ""))).toBeGreaterThan(
			Number(s.breakEvenPct.replace("%", "")),
		);
	});
});

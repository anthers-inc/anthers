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
import { SALES_TAX_RATE, SEED_PRICE } from "./constants.js";
import { calculateFees, supportBreakdown } from "./fees.js";
import { badgeTable, directedSeedWorstCase, saleTable, sampleReceipt } from "./scenarios.js";

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

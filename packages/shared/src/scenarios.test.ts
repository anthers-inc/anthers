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
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	PUBLIC_ACCESS_PRICE,
	SALES_TAX_RATE,
} from "./constants.js";
import { calculateFees, supportBreakdown } from "./fees.js";
import {
	affordable,
	averageSupport,
	crossover,
	floorPayingShare,
	modelAt,
	NO_STAFFING,
	payingBadgeMix,
	remainderPerPayingAccount,
	staffingForPhase,
} from "./growth.js";
import {
	badgeTable,
	creatorReceipt,
	directedSupportWorstCase,
	PAYING_BADGE_MIX,
	saleTable,
	sampleReceipt,
	selfSufficiency,
} from "./scenarios.js";

const D = (s: string) => new Decimal(s);

describe("badgeTable", () => {
	test("every row conserves: Time Pool + Payments + remainder = the charge", () => {
		for (const r of badgeTable()) {
			const sum = D(r.timePool).plus(r.payments).plus(r.remainder);
			expect(sum.toFixed(2)).toBe(r.charge);
		}
	});

	test("the charge IS the rung's amount — the price is all-in", () => {
		for (const r of badgeTable()) {
			expect(r.charge).toBe(r.monthly.toFixed(2));
		}
	});

	test("the first rung is the Public Access price, and nothing above it buys more access", () => {
		// The one Anthers amount that is a product decision rather than a dial: $3 opens
		// the whole commons, and the rungs above it buy standing, never reach.
		expect(badgeTable()[0].monthly).toBe(PUBLIC_ACCESS_PRICE);
	});

	test("the remainder is strictly positive at every Badge", () => {
		// If a dial change ever drives this negative, the model is insolvent at that Badge
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
		const anthersCharge = D(r.anthersDollars.toFixed(2));
		const sum = D(r.timePool).plus(r.paymentsAnthers).plus(r.remainder);
		expect(sum.toFixed(2)).toBe(anthersCharge.toFixed(2));
	});

	test("the two shares of the card fee reconstruct the whole fee", () => {
		expect(D(r.paymentsAnthers).plus(r.paymentsCreator).toFixed(2)).toBe(r.payments);
	});

	test("the directed line is gross minus the creator's share", () => {
		expect(D(r.directedGross).minus(r.paymentsCreator).toFixed(2)).toBe(r.directedNet);
	});

	test("the subtotal is what was given, and tax is the ONLY thing added", () => {
		const subtotal = D((r.anthersDollars + r.creatorDollars).toFixed(2));
		expect(r.supportSubtotal).toBe(subtotal.toFixed(2));
		expect(r.salesTax).toBe(subtotal.mul(SALES_TAX_RATE).toDecimalPlaces(2).toFixed(2));
		expect(r.totalBilled).toBe(subtotal.plus(r.salesTax).toFixed(2));
	});

	test("money to creators is the directed NET plus the Time Pool", () => {
		expect(D(r.directedNet).plus(r.timePool).toFixed(2)).toBe(r.toCreators);
	});

	test("nothing is unaccounted for — the whole subtotal lands somewhere", () => {
		const accounted = D(r.toCreators).plus(r.payments).plus(r.remainder);
		expect(accounted.toFixed(2)).toBe(r.supportSubtotal);
	});
});

describe("saleTable", () => {
	test("every row is price − card, straight from calculateFees", () => {
		for (const r of saleTable()) {
			const expected = calculateFees(D(r.price), { type: r.sizeGiB > 0 ? "digital" : "physical" });
			expect(r.creatorReceives).toBe(expected.creatorEarnings.toFixed(2));
			expect(D(r.price).minus(r.cardFee).toFixed(2)).toBe(r.creatorReceives);
		}
	});

	/**
	 * This assertion is **inverted from what it said until 2026-08-12**, and the
	 * inversion is the whole change. It used to read *"a bigger download returns the
	 * creator less — which is why size must be quoted"*: the two $10 rows differ only
	 * in declared size, and a 2 GiB game returned a cent less than a 1 GiB one because
	 * the first download was deducted at $0.01/GiB.
	 *
	 * Delivery is free at any volume on R2, so they must now agree exactly — and these
	 * two scenarios are the only place left in the model where the same price is
	 * declared at two different sizes, which is what makes them worth keeping.
	 */
	test("size no longer changes take-home — the two $10 rows agree exactly", () => {
		const rows = saleTable();
		const oneGiB = rows.find((r) => r.label === "game-10-1gib")!;
		const twoGiB = rows.find((r) => r.label === "game-10-2gib")!;
		expect(oneGiB.price).toBe(twoGiB.price);
		expect(twoGiB.sizeGiB).toBeGreaterThan(oneGiB.sizeGiB);
		expect(twoGiB.creatorReceives).toBe(oneGiB.creatorReceives);
	});

	test("Anthers keeps nothing on any of them", () => {
		for (const r of saleTable()) {
			expect(calculateFees(D(r.price), { type: "digital" }).crfFee.toNumber()).toBe(0);
		}
	});
});

describe("directedSupportWorstCase", () => {
	test("matches supportBreakdown's creatorNet for a lone monthly gift", () => {
		const w = directedSupportWorstCase();
		const s = supportBreakdown({ anthersDollars: 0, creatorDollars: PUBLIC_ACCESS_PRICE });
		expect(w.net).toBe(s.creatorNet.toFixed(2));
		expect(D(w.gross).minus(w.cardFee).toFixed(2)).toBe(w.net);
	});

	test("is genuinely the worst case — batching always pays the creator more", () => {
		const worst = D(directedSupportWorstCase().net);
		for (const anthersDollars of [3, 6, 9, 12]) {
			const batched = supportBreakdown({
				anthersDollars,
				creatorDollars: PUBLIC_ACCESS_PRICE,
			}).creatorNet;
			expect(batched.greaterThan(worst)).toBe(true);
		}
	});

	/**
	 * 🚨 The claim the retired $3 unit rested on, and it is now checkable at any amount.
	 *
	 * "A $1 charge loses ~33% to processing, a $3 charge ~13%" was the whole written
	 * justification for a granularity floor. It is still true of a charge **in isolation**
	 * — and irrelevant, because since PR #223 one subscription carries everything a user
	 * gives, so the fixed $0.30 is paid once a month whatever the denomination. A creator
	 * set at $1 beside anything else is not paying a $1 charge's processing.
	 */
	test("a small amount is only expensive ALONE, which is why the floor went", () => {
		const alone = supportBreakdown({ anthersDollars: 0, creatorDollars: 1 });
		const deduction = D("1").minus(alone.creatorNet).dividedBy(1);
		expect(deduction.toNumber()).toBeGreaterThan(0.3); // ~33% — the old argument

		// The same $1 riding on a month that already carries the Public Access price.
		const batched = supportBreakdown({ anthersDollars: PUBLIC_ACCESS_PRICE, creatorDollars: 1 });
		const share = D("1").minus(batched.creatorNet).dividedBy(1);
		expect(share.toNumber()).toBeLessThan(0.12);
	});
});

describe("creatorReceipt", () => {
	/**
	 * ⚠️ The charge assertion here **used to restate the code** — `storageCharge ===
	 * storage × AFF_INFRA_RATE` — and passed for as long as it did only because $0.02
	 * a GiB put every step on an exact cent. Moving to R2's $0.0161 broke it
	 * immediately: the charge is half of the *rounded* storage cost ($0.31 → $0.16),
	 * not the rounded half of the raw one ($0.155). The formula was right about the
	 * model and wrong about the money, and nothing would have said so.
	 *
	 * So the figures below are computed by hand: 19 billable GiB × $0.0161 = $0.3059,
	 * which is $0.31 to the cent, and half again on that is $0.155 → $0.16.
	 */
	test("charges storage only above the free allowance, and nothing else", () => {
		const r = creatorReceipt(1575, 69);
		expect(r.billableGiB).toBe(69 - FREE_STORAGE_GIB);
		expect(r.storage).toBe("0.31");
		expect(r.storageCharge).toBe("0.16");
		// Net is gross less storage and its charge — payouts carry no processing (Connect
		// standard transfers are free) and delivery costs nothing. Anything else appearing
		// here is a bug.
		expect(r.net).toBe("1574.53");
		expect(new Decimal(r.net)).toEqual(
			new Decimal(r.gross).minus(r.storage).minus(r.storageCharge),
		);
		// Half again, to the cent — the rate itself is a vendor pass-through and may move,
		// but the multiplier is the dial that funds the mission.
		expect(AFF_INFRA_RATE).toBe(0.5);
	});

	test("a library inside the free allowance costs its creator nothing", () => {
		const r = creatorReceipt(500, FREE_STORAGE_GIB);
		expect(r.billableGiB).toBe(0);
		expect(r.net).toBe("500.00");
	});
});

describe("selfSufficiency", () => {
	const s = selfSufficiency();

	test("a free user costs the Time Pool funded for them, and nothing else", () => {
		expect(s.freeUserCost).toBe(new Decimal(FREE_TIME_POOL).toFixed(2));
	});

	/**
	 * 🚨 **The assertion that retires the two-floor warning.**
	 *
	 * Until 2026-08-16 this module and `growth.ts` answered the same question with two
	 * different models — a hand-typed four-rung Badge mix here, a geometric decay there —
	 * and published **10.3%** and **8.8%** for the floor paying share. 61.01 had to carry a
	 * warning naming which one governed, and the ladder could only be re-derived by reviving
	 * a file that had been retired to the Graveyard.
	 *
	 * Asserting that the two now agree is the guard against that reopening. It is cheap
	 * precisely because there is only one model left: if this ever fails, someone has given
	 * `selfSufficiency` a second opinion again.
	 */
	test("the floor here is the floor the growth ladder uses — one model, one number", () => {
		expect(Number(s.breakEvenPct.replace("%", ""))).toBeCloseTo(
			floorPayingShare({ staffing: NO_STAFFING }) * 100,
			1,
		);
	});

	test("the mix is the growth model's, averaging 2.20 Seeds per payer", () => {
		expect(s.averageSupport).toBe(averageSupport(payingBadgeMix()).toFixed(2));
		expect(Number(s.revenuePerPayingUser)).toBeCloseTo(
			remainderPerPayingAccount(PAYING_BADGE_MIX),
			2,
		);
	});

	/**
	 * The rows report the two lines 11.02 and 61.01 were implicitly comparing all along, so
	 * each must equal the ladder's own landmark at that share. A `FIXED_MONTHLY_OVERHEAD`
	 * of $12,600 stood here instead, sourced to nothing — which is how the two documents
	 * came to disagree without either being wrong on its own terms.
	 */
	test("each row's landmarks are the ladder's, at that paying share", () => {
		for (const row of s.rows) {
			expect(row.selfFunding).toBe(
				crossover(affordable, { payingShare: row.share, staffing: NO_STAFFING }),
			);
			expect(row.fullTime).toBe(
				crossover(affordable, { payingShare: row.share, staffing: staffingForPhase(10) }),
			);
		}
	});

	test("net rises with the paying share, and both landmarks get nearer", () => {
		const nets = s.rows.map((r) => Number(r.net));
		expect([...nets].sort((a, b) => a - b)).toEqual(nets);
		for (const key of ["selfFunding", "fullTime"] as const) {
			const scales = s.rows.map((r) => r[key]).filter((n): n is number => n !== null);
			expect([...scales].sort((a, b) => b - a)).toEqual(scales);
		}
	});

	/**
	 * `net` is the model's **slope** — what one more account does to the budget, divided
	 * across the paying cohort carrying it. So the break-even share is where it reaches
	 * zero, and asserting that is asserting what the figure means rather than how it is
	 * computed. The old version of this test recomputed `revenue − freePerPaying × cost`,
	 * which was the implementation copied into the test file and could only ever agree.
	 */
	test("net per paying user reaches zero exactly at the break-even share", () => {
		const floor = Number(s.breakEvenPct.replace("%", "")) / 100;
		const netAt = (share: number) => {
			const at = (n: number) =>
				modelAt({ accounts: n, payingShare: share, staffing: NO_STAFFING }).programs;
			return (at(2e6) - at(1e6)) / 1e6 / share;
		};
		// `breakEvenPct` is published to one decimal, so `floor` can sit up to half a
		// tenth of a percent off the true crossing — and `net` is per PAYING account, so
		// that half-step is divided by the share and comes back magnified. The tolerance
		// is derived from the publishing precision rather than tuned until it passed:
		// a bare 0.01 looks tighter and is only an assertion about today's rounding.
		const halfStep = 0.0005;
		const slopePerShare = Number(s.revenuePerPayingUser) + Number(s.freeUserCost);
		expect(Math.abs(netAt(floor))).toBeLessThan((halfStep * slopePerShare) / floor);
		expect(netAt(floor - 0.02)).toBeLessThan(0);
		expect(netAt(floor + 0.02)).toBeGreaterThan(0);
	});

	/**
	 * The sensitivity that used to sit here — *"a more generous free floor raises the
	 * share needed to sustain it"* — was retired with the floor on 2026-08-12. It
	 * compared the free-user cost at 8 streaming hours against the same user drawing
	 * their whole 15 GiB, and there is no longer a version of a free account that
	 * costs more by watching more.
	 *
	 * What replaces it is the stronger claim: **free access has no usage-dependent
	 * price at all.** Asserted here as a property of the published figure, because it
	 * is the sentence the wiki now leads with.
	 */
	test("free access has no usage-dependent price — a free user costs a flat Time Pool", () => {
		expect(Number(s.freeUserCost)).toBe(FREE_TIME_POOL);
	});

	test("the model is viable at a plausible paying share", () => {
		// The claim the figure is actually for. Not a tautology: at a high enough
		// FREE_TIME_POOL this fails, which is precisely the bind a generous opening number
		// would have put the charitable budget in.
		expect(Number(s.breakEvenPct.replace("%", ""))).toBeLessThan(25);
	});
});

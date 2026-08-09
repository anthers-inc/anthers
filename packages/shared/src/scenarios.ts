// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The canonical published scenarios — every money figure the site and the wiki
 * quote, derived from `fees.ts` in one place.
 *
 * **Why this exists.** Before 2026-08-08 these figures were typed by hand into
 * marketing pages and wiki tables. When Payments moved inside the price on
 * 2026-08-03 a sweep updated most of them, and quietly missed 50.01's per-Badge
 * table, its sample receipt, and a line on the Infrastructure page — which then
 * sat there overstating the remainder by exactly the card fee. A sweep cannot be
 * trusted to be complete; only derivation can.
 *
 * So: **nothing downstream may re-type a figure.** This module computes them,
 * `scripts/econ-figures.ts` renders them into `figures.generated.ts` (plain
 * numbers, so the SPA bundle never sees decimal.js) and into the wiki docs
 * between markers, and `--check` fails CI if either has drifted.
 *
 * Adding a published figure? Add it here, not to the page.
 */
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	BADGE_ORDER,
	BANDWIDTH_PER_GIB,
	DELIVERY_GIB_PER_HOUR,
	FREE_FLOOR_GIB,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	SALES_TAX_RATE,
	SEED_PRICE,
	STORAGE_PER_GIB_MONTH,
	thresholdForBadge,
} from "./constants.js";
import { anthersSeedBreakdown, calculateFees, paymentsSplit, supportBreakdown } from "./fees.js";

const GIB = 1024 ** 3;
const money = (d: Decimal) => d.toFixed(2);

/**
 * The illustrative streamer behind the per-Badge table: 18 / 28 / 38 / 48 watch-
 * hours a month. This is an ASSUMPTION, not a dial — it is the single reason the
 * bandwidth column moves, and quoting the table without it is what makes the
 * numbers look arbitrary. Keep it here so every rendering states the same one.
 */
export const REFERENCE_WATCH_HOURS: Record<number, number> = { 1: 18, 2: 28, 3: 38, 4: 48 };

export interface BadgeRow {
	badge: string;
	seeds: number;
	/** The all-in monthly charge for those Seeds. */
	charge: string;
	/** At-cost actual usage for the reference streamer. */
	bandwidth: string;
	timePool: string;
	/** This side's share of the at-cost card fee — INSIDE the charge since 2026-08-03. */
	payments: string;
	/** The residual, which is what funds free access and the charitable programs. */
	remainder: string;
	watchHours: number;
	allowanceGiB: number;
}

/** The per-Badge decomposition. Each row conserves: bw + pool + payments + rem = charge. */
export function badgeTable(): BadgeRow[] {
	return BADGE_ORDER.filter((b) => thresholdForBadge(b) > 0).map((badge) => {
		const n = thresholdForBadge(badge);
		const hours = REFERENCE_WATCH_HOURS[n] ?? 0;
		const gib = new Decimal(hours).mul(DELIVERY_GIB_PER_HOUR);
		// No directed Seeds in this scenario, so the whole card fee sits on this side.
		const payments = paymentsSplit(n, 0).anthers;
		const b = anthersSeedBreakdown(n, { bandwidthGiB: gib, payments });
		return {
			badge: badge.charAt(0).toUpperCase() + badge.slice(1),
			seeds: n,
			charge: money(b.seedValue),
			bandwidth: money(b.bandwidth),
			timePool: money(b.timePool),
			payments: money(b.payments),
			remainder: money(b.foundation),
			watchHours: hours,
			allowanceGiB: gib.toNumber(),
		};
	});
}

export interface ReceiptScenario {
	anthersSeeds: number;
	creatorSeeds: number;
	watchHours: number;
	/** Gross directed-Seed value — what the user chose to give. */
	directedGross: string;
	/** What actually reaches those creators, net of their share of the card fee. */
	directedNet: string;
	timePool: string;
	bandwidth: string;
	/** The WHOLE card fee on the batched charge. */
	payments: string;
	/** This side's share of it — what the Anthers block must show, or it double-counts. */
	paymentsAnthers: string;
	/** The creator side's share, already deducted from `directedNet`. */
	paymentsCreator: string;
	remainder: string;
	seedsSubtotal: string;
	salesTax: string;
	/** All-in: the subtotal plus sales tax, and nothing else. */
	totalBilled: string;
	toCreators: string;
}

/**
 * The sample monthly receipt in 50.01 — a Sprout who also directs two Seeds.
 *
 * Note the shape, because it is the whole point of all-in pricing: the subtotal
 * IS what the user pays, and sales tax is the only thing added. Payments appears
 * as a line inside the Seeds, never beneath the subtotal.
 */
export function sampleReceipt(anthersSeeds = 2, creatorSeeds = 2): ReceiptScenario {
	const hours = REFERENCE_WATCH_HOURS[anthersSeeds] ?? 0;
	const gib = new Decimal(hours).mul(DELIVERY_GIB_PER_HOUR);
	const s = supportBreakdown({ anthersSeeds, creatorSeeds, bandwidthGiB: gib });
	const split = paymentsSplit(anthersSeeds, creatorSeeds);
	const anthers = anthersSeedBreakdown(anthersSeeds, {
		bandwidthGiB: gib,
		payments: split.anthers,
	});
	const salesTax = new Decimal(s.seedsSubtotal).mul(SALES_TAX_RATE).toDecimalPlaces(2);
	return {
		anthersSeeds,
		creatorSeeds,
		watchHours: hours,
		directedGross: money(s.creatorDirect),
		directedNet: money(s.creatorNet),
		timePool: money(s.timePool),
		bandwidth: money(anthers.bandwidth),
		payments: money(split.total),
		paymentsAnthers: money(split.anthers),
		paymentsCreator: money(split.creator),
		remainder: money(anthers.foundation),
		seedsSubtotal: money(s.seedsSubtotal),
		salesTax: money(salesTax),
		totalBilled: money(s.seedsSubtotal.plus(salesTax)),
		toCreators: money(s.toCreators),
	};
}

export interface SaleScenario {
	label: string;
	price: string;
	sizeGiB: number;
	creatorReceives: string;
	cardFee: string;
	delivery: string;
}

/**
 * The sale take-homes quoted across the comparison pages.
 *
 * The download size is load-bearing and was the source of a live inconsistency —
 * two pages quoted $9.39 and $9.40 for "a $10 game" because each had assumed a
 * different size without saying so. Every scenario names its size here.
 */
export const SALE_SCENARIOS: { label: string; price: number; sizeGiB: number }[] = [
	{ label: "game-10-1gib", price: 10, sizeGiB: 1 },
	{ label: "game-10-2gib", price: 10, sizeGiB: 2 },
	{ label: "game-20-10gib", price: 20, sizeGiB: 10 },
	{ label: "album-10-1gib", price: 10, sizeGiB: 1 },
	{ label: "merch-25-physical", price: 25, sizeGiB: 0 },
];

export function saleTable(): SaleScenario[] {
	return SALE_SCENARIOS.map(({ label, price, sizeGiB }) => {
		const r = calculateFees(new Decimal(price), {
			deliveryBytes: sizeGiB * GIB,
			type: sizeGiB > 0 ? "digital" : "physical",
		});
		return {
			label,
			price: money(new Decimal(price)),
			sizeGiB,
			creatorReceives: money(r.creatorEarnings),
			cardFee: money(r.processingFee),
			delivery: money(r.deliveryFee),
		};
	});
}

export interface PurchaseExample extends SaleScenario {
	/** Human label for the row, as the creator-facing table names it. */
	item: string;
	sizeLabel: string;
	/** Share of list price the creator does not receive, e.g. "34.0%". */
	deductionPct: string;
}

/**
 * The creator-facing worked examples — the single-item worst case Studio quotes.
 *
 * Single-item on purpose: a multi-item cart amortises the fixed $0.30 and only ever
 * pays the creator more, so quoting the cart price would be quoting a best case. The
 * deduction percentage is here rather than in the doc because it is the number a
 * creator actually reacts to, and a percentage recomputed by hand beside a generated
 * take-home is precisely how the two drift apart.
 */
export const PURCHASE_EXAMPLES: {
	item: string;
	price: number;
	sizeGiB: number;
	sizeLabel: string;
}[] = [
	{ item: "A single track", price: 1, sizeGiB: 30 / 1024, sizeLabel: "30 MB" },
	{ item: "A small game", price: 5, sizeGiB: 800 / 1024, sizeLabel: "800 MB" },
	{ item: "An album", price: 10, sizeGiB: 500 / 1024, sizeLabel: "500 MB" },
	{ item: "A mid-size game", price: 20, sizeGiB: 10, sizeLabel: "10 GiB" },
	{ item: "A large game", price: 40, sizeGiB: 40, sizeLabel: "40 GiB" },
];

export function purchaseExamples(): PurchaseExample[] {
	return PURCHASE_EXAMPLES.map(({ item, price, sizeGiB, sizeLabel }) => {
		const list = new Decimal(price);
		const r = calculateFees(list, { deliveryBytes: sizeGiB * GIB, type: "digital" });
		const deduction = list.minus(r.creatorEarnings).dividedBy(list).times(100);
		return {
			label: item,
			item,
			sizeLabel,
			price: money(list),
			sizeGiB,
			creatorReceives: money(r.creatorEarnings),
			cardFee: money(r.processingFee),
			delivery: money(r.deliveryFee),
			// One decimal reads right for most rows; the sub-5% rows need two, or the
			// large-game case rounds to a suspiciously round 4.7%.
			deductionPct: `${deduction.toFixed(deduction.lessThan(5) ? 2 : 1)}%`,
		};
	});
}

/**
 * What the cart is worth, at the small end where the flat fee hurts most.
 *
 * Five $1 tracks bought one at a time pay the fixed $0.30 five times; bought together
 * they pay it once. The whole saving goes to the creators — it is the reason carts and
 * bundles are an economic instrument here rather than a convenience.
 */
export function cartSaving(unitPrice = 1, count = 5) {
	const one = calculateFees(new Decimal(unitPrice), { deliveryBytes: 0, type: "digital" });
	const together = calculateFees(new Decimal(unitPrice * count), {
		deliveryBytes: 0,
		type: "digital",
	});
	return {
		count,
		unitPrice: money(new Decimal(unitPrice)),
		separately: money(one.processingFee.times(count)),
		inOneCart: money(together.processingFee),
	};
}

/**
 * A mid-size creator's monthly earnings receipt.
 *
 * Gross earnings and library size are the two ASSUMPTIONS; everything below them is
 * derived. A creator's only platform-side cost is their own storage above the free
 * allowance, plus the storage charge on it — payouts carry no processing, because
 * Connect standard transfers are free.
 */
export function creatorReceipt(grossEarnings = 1575, libraryGiB = 69) {
	const gross = new Decimal(grossEarnings);
	const billableGiB = Math.max(0, libraryGiB - FREE_STORAGE_GIB);
	const storage = new Decimal(billableGiB).times(STORAGE_PER_GIB_MONTH);
	const storageCharge = storage.times(AFF_INFRA_RATE);
	return {
		libraryGiB,
		freeGiB: FREE_STORAGE_GIB,
		billableGiB,
		gross: money(gross),
		storage: money(storage),
		storageCharge: money(storageCharge),
		net: money(gross.minus(storage).minus(storageCharge)),
	};
}

/**
 * What a free user costs the subsidy each month: their bandwidth at cost, plus the
 * Time Pool Anthers funds on their behalf so a free viewer still pays the creators
 * they watch. Streaming hours are the assumption.
 */
export const FREE_USER_STREAM_HOURS = 8;

/**
 * The paying-user mix behind the self-sufficiency table — what share of paying users
 * sit at each Badge. An ASSUMPTION, and the one that moves every number below: the
 * remainder a paying user generates rises faster than linearly with their Seed count,
 * because the fixed $0.30 of the card fee does not scale with it.
 */
export const PAYING_BADGE_MIX: Record<number, number> = { 1: 0.5, 2: 0.3, 3: 0.15, 4: 0.05 };

/** Fixed monthly overhead the charitable budget must cover before it is self-funding. */
export const FIXED_MONTHLY_OVERHEAD = 12_600;

/** The paying shares the table reports. */
export const PAYING_SHARES = [0.1, 0.15, 0.2, 0.3];

export function selfSufficiency() {
	const freeUserCost = new Decimal(FREE_USER_STREAM_HOURS)
		.times(DELIVERY_GIB_PER_HOUR)
		.times(BANDWIDTH_PER_GIB)
		.plus(FREE_TIME_POOL);

	// The remainder one paying user generates, weighted across the Badge mix. Each rung
	// carries its own reference watch-hours, because bandwidth is what the remainder
	// absorbs — a heavier streamer shrinks it while their creators are paid the same.
	const revenuePerPayingUser = Object.entries(PAYING_BADGE_MIX).reduce((acc, [seeds, share]) => {
		const n = Number(seeds);
		const hours = REFERENCE_WATCH_HOURS[n] ?? 0;
		const bd = anthersSeedBreakdown(n, {
			bandwidthGiB: hours * DELIVERY_GIB_PER_HOUR,
			// Seed COUNTS, not dollars — and the `anthers` side, because this user holds
			// no directed Seeds and the remainder is what the Anthers side has left after
			// its own share of the card fee. Taking `.creator` here reads as zero and
			// silently hands the whole fee back to the remainder.
			payments: paymentsSplit(n, 0).anthers,
		});
		return acc.plus(bd.foundation.times(share));
	}, new Decimal(0));

	const rows = PAYING_SHARES.map((share) => {
		const freePerPaying = new Decimal(1 - share).dividedBy(share);
		const net = revenuePerPayingUser.minus(freePerPaying.times(freeUserCost));
		return {
			share,
			sharePct: `${(share * 100).toFixed(0)}%`,
			net: money(net),
			// Total users — paying and free together — at which the paying cohort's net
			// covers fixed overhead. Meaningless when each paying user loses money.
			usersToSolvency: net.lessThanOrEqualTo(0)
				? null
				: Math.round(
						new Decimal(FIXED_MONTHLY_OVERHEAD).dividedBy(net).dividedBy(share).toNumber() / 1000,
					) * 1000,
		};
	});

	// Below this share each new cohort costs more in free access than it brings in, so
	// growth makes the gap worse rather than better.
	const breakEven = (cost: Decimal) => cost.dividedBy(revenuePerPayingUser.plus(cost));

	// The same floor, if every free user drew their whole 15 GiB rather than the 8 hours
	// above. This is the sensitivity that matters politically: the generosity of the free
	// floor and the platform's self-sufficiency are the same dial, so the cost of raising
	// it should be a derived number rather than a remembered one.
	const fullFloorCost = new Decimal(FREE_FLOOR_GIB).times(BANDWIDTH_PER_GIB).plus(FREE_TIME_POOL);

	return {
		freeUserCost: money(freeUserCost),
		fullFloorCost: money(fullFloorCost),
		revenuePerPayingUser: money(revenuePerPayingUser),
		breakEvenPct: `${breakEven(freeUserCost).times(100).toFixed(1)}%`,
		breakEvenFullFloorPct: `${breakEven(fullFloorCost).times(100).toFixed(1)}%`,
		rows,
	};
}

/** A lone directed Seed — the worst case, and the figure creator-facing copy quotes. */
export function directedSeedWorstCase() {
	const s = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
	return {
		gross: money(new Decimal(SEED_PRICE)),
		net: money(s.creatorNet),
		cardFee: money(s.payments),
	};
}

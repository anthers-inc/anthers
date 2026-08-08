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
	BADGE_ORDER,
	DELIVERY_GIB_PER_HOUR,
	SALES_TAX_RATE,
	SEED_PRICE,
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

/** A lone directed Seed — the worst case, and the figure creator-facing copy quotes. */
export function directedSeedWorstCase() {
	const s = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
	return {
		gross: money(new Decimal(SEED_PRICE)),
		net: money(s.creatorNet),
		cardFee: money(s.payments),
	};
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	ANTHERS_BADGES,
	allowanceGiB,
	BANDWIDTH_PER_GIB,
	type Badge,
	type BadgeKey,
	badgeLabel,
	CARD_FLAT,
	CARD_RATE,
	FOUNDATION_SPLIT,
	FREE_STORAGE_GIB,
	SALES_TAX_RATE,
	SELF_HOST_FEE,
	STORAGE_PER_GIB_MONTH,
	seedCost,
	timePoolFor,
} from "./constants.js";

/** Bytes per GiB (binary). */
const GIB = new Decimal("1073741824");
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Maximum discretionary hosting subsidy per creator per month. */
export const MAX_MONTHLY_SUBSIDY = new Decimal("25.00");

// ── Payments (the at-cost card fee, added ON TOP of the charge) ───────────────
/**
 * The at-cost **Payments** line for a whole batched charge: card + processing,
 * 2.9% + $0.30. It sits **inside** the price (moved back inside 2026-08-03) and is
 * paid to the processor, never kept — mandatory-fee disclosure law requires an
 * advertised price to contain every mandatory fee, and only government-imposed
 * taxes get the on-top carve-out. Sales tax is the only thing added on top.
 * $0 when nothing is charged.
 */
export function cardFee(amount: Decimal | number): Decimal {
	const a = new Decimal(amount);
	return a.gt(0) ? CENTS(a.mul(CARD_RATE).plus(CARD_FLAT)) : new Decimal(0);
}

/**
 * Split the at-cost card fee on a whole batched monthly charge between the
 * Anthers-Seeds and the directed Seeds riding on it, pro-rata by dollar value.
 *
 * The fixed $0.30 is per *charge*, not per Seed, so a user who gives directed
 * Seeds alongside Anthers-Seeds amortises it across a bigger charge — which
 * leaves a fatter remainder AND pays their creators more. That effect
 * is the whole reason every Seed batches onto one monthly transaction.
 */
export function paymentsSplit(
	anthersSeeds: number,
	creatorSeeds: number,
): { total: Decimal; anthers: Decimal; creator: Decimal } {
	const a = Math.max(0, Math.floor(anthersSeeds));
	const c = Math.max(0, Math.floor(creatorSeeds));
	const anthersValue = new Decimal(seedCost(a));
	const creatorValue = new Decimal(seedCost(c));
	const charge = anthersValue.plus(creatorValue);
	const total = cardFee(charge);
	if (charge.lte(0))
		return { total: new Decimal(0), anthers: new Decimal(0), creator: new Decimal(0) };
	// Split by value, then give the rounding remainder to the Anthers side so the
	// two shares always reconstruct `total` exactly and creators are never short a cent.
	const creator = CENTS(total.mul(creatorValue).div(charge));
	return { total, anthers: total.minus(creator), creator };
}

// ── Anthers-Seed decomposition ────────────────────────────────────────────────
/**
 * Decompose a user's Anthers-Seeds into where each $3 goes:
 *
 *   Anthers-Seed value ($3 × n) = bandwidth + Time Pool + Payments + remainder
 *
 * Time Pool ($1.50/Seed) is a fixed target to creators and never moves; bandwidth
 * is the user's own at-cost usage; `payments` is this side's share of the at-cost
 * card fee (see `paymentsSplit`); the **the remainder is what's left** — the shock
 * absorber, so a heavy streamer or an expensive charge shrinks the mission share
 * while creator pay stays exactly the same. Free (n = 0) pays $0: its small Time
 * Pool and in-floor bandwidth are subsidised, and it funds no charitable remainder.
 *
 * `payments` defaults to 0 so a caller that only wants the Time-Pool/bandwidth
 * view is unaffected — but anything crediting the **charitable ledger** must pass
 * it, or the charitable ledger is over-credited by the card fee.
 */
export function anthersSeedBreakdown(
	anthersSeeds: number,
	opts: { bandwidthGiB?: Decimal | number; payments?: Decimal | number } = {},
): {
	anthersSeeds: number;
	seedValue: Decimal;
	timePool: Decimal;
	bandwidth: Decimal;
	payments: Decimal;
	foundation: Decimal;
	subsidised: boolean;
} {
	const n = Math.max(0, Math.floor(anthersSeeds));
	const seedValue = new Decimal(seedCost(n));
	const timePool = new Decimal(timePoolFor(n));
	const bandwidth = bandwidthCost(opts.bandwidthGiB ?? 0);
	const payments = new Decimal(opts.payments ?? 0);
	if (n === 0) {
		return {
			anthersSeeds: 0,
			seedValue: new Decimal(0),
			timePool,
			bandwidth,
			payments: new Decimal(0),
			foundation: new Decimal(0),
			subsidised: true,
		};
	}
	const foundation = seedValue.minus(timePool).minus(bandwidth).minus(payments);
	return {
		anthersSeeds: n,
		seedValue,
		timePool,
		bandwidth,
		payments,
		foundation,
		subsidised: false,
	};
}

/**
 * The full monthly support breakdown for a user holding `anthersSeeds` Anthers-
 * Seeds and `creatorSeeds` directed Seeds, given their actual `bandwidthGiB`.
 *
 * Anthers takes **no cut** — but the at-cost card fee comes out of the charge
 * rather than riding on top of it, so a directed Seed reaches its creator less
 * that Seed's pro-rata share. `total` is therefore the Seed subtotal itself: the
 * price is all-in, and sales tax is the only thing a caller adds on top.
 *
 * `creatorDirect` is the **gross** directed-Seed value; `creatorNet` is what
 * actually reaches creators. Use `creatorNet` for anything describing payout.
 */
export function supportBreakdown(params: {
	anthersSeeds: number;
	creatorSeeds: number;
	bandwidthGiB?: Decimal | number;
}): {
	creatorDirect: Decimal;
	creatorNet: Decimal;
	timePool: Decimal;
	bandwidth: Decimal;
	foundation: Decimal;
	toCreators: Decimal;
	seedsSubtotal: Decimal;
	payments: Decimal;
	total: Decimal;
} {
	const split = paymentsSplit(params.anthersSeeds, params.creatorSeeds);
	const anthers = anthersSeedBreakdown(params.anthersSeeds, {
		bandwidthGiB: params.bandwidthGiB,
		payments: split.anthers,
	});
	const creatorDirect = new Decimal(seedCost(Math.max(0, Math.floor(params.creatorSeeds))));
	const creatorNet = creatorDirect.minus(split.creator);
	const seedsSubtotal = creatorDirect.plus(anthers.seedValue);
	return {
		creatorDirect,
		creatorNet,
		timePool: anthers.timePool,
		bandwidth: anthers.bandwidth,
		foundation: anthers.foundation,
		toCreators: creatorNet.plus(anthers.timePool),
		seedsSubtotal,
		payments: split.total,
		total: seedsSubtotal,
	};
}

/** A rung of Anthers' Badge ladder as a display view model — money pre-rounded to 2dp. */
export interface BadgeView {
	/** Badge name, or "free" for the 0-Seed rung, which is the absence of a Badge. */
	id: BadgeKey;
	name: string;
	/** Anthers-Seeds required for this rung (0 = no Badge … 4 = blossom). */
	anthersSeeds: number;
	/** Monthly $ to hold this rank ($3 × anthersSeeds). */
	price: number;
	/** Time Pool $ at this rank (to creators, by watch-time). */
	timePool: string;
	/** "Supports Anthers" — your bandwidth (at cost) + the remainder. */
	supportsAnthers: string;
	/** Streaming allowance (GiB) at this rank. */
	allowanceGiB: number;
	subsidised: boolean;
}

/**
 * The rank ladder as view models, low → high (free … blossom). Pure and static —
 * derived from the Seed dials, no per-user data — so the Subscribe page, the
 * `/subscriptions/ranks` route, and inline-unlock all render the same numbers and
 * can't drift. "Supports Anthers" bundles bandwidth (at cost) + the
 * remainder into one line (as the Subscribe page shows it).
 */
export function badgeViews(): BadgeView[] {
	// The 0-Seed rung is the absence of a Badge, so it isn't in ANTHERS_BADGES — it's
	// prepended here for display only. Seed counts come from each Badge's THRESHOLD,
	// never from its position: this list is ordered by threshold, but nothing reads
	// the index, so a Badge set with gaps renders correctly too.
	const rungs: Array<{ id: BadgeKey; seeds: number }> = [
		{ id: "free", seeds: 0 },
		...ANTHERS_BADGES.map((b) => ({ id: b.name as Badge, seeds: b.threshold })),
	];
	return rungs.map(({ id, seeds }) => {
		const badge = id;
		const n = seeds;
		const price = seedCost(n);
		const timePool = new Decimal(timePoolFor(n));
		const supportsAnthers = n === 0 ? new Decimal(0) : new Decimal(price).minus(timePool);
		return {
			id: badge,
			name: badgeLabel(badge),
			anthersSeeds: n,
			price,
			timePool: timePool.toFixed(2),
			supportsAnthers: supportsAnthers.toFixed(2),
			allowanceGiB: allowanceGiB(n),
			subsidised: n === 0,
		};
	});
}

// ── Bandwidth: at-cost, folded into Anthers-Seeds (free floor + per-Seed allowance)
/** At-cost bandwidth cost for a number of GiB (a pass-through, no fee). */
export function bandwidthCost(gib: Decimal | number): Decimal {
	return CENTS(new Decimal(gib).mul(BANDWIDTH_PER_GIB));
}

/**
 * Apply a month's stream bandwidth against the free floor + per-Seed allowance.
 * The allowance is drawn down first and does not roll over; whatever is unused
 * returns to the subsidy pool at month-end. A positive `overage` is bandwidth
 * beyond the allowance (which, in the support model, is a nudge to hold another
 * Anthers-Seed — there is no wallet).
 */
export function drawBandwidth(params: {
	consumedGiB: Decimal | number;
	allowanceGiB: Decimal | number;
}): {
	fromAllowanceGiB: Decimal;
	overageGiB: Decimal;
	overageCost: Decimal;
	remainingAllowanceGiB: Decimal;
} {
	const consumed = new Decimal(params.consumedGiB);
	const allowance = new Decimal(params.allowanceGiB);
	const fromAllowanceGiB = Decimal.min(consumed, allowance);
	const overageGiB = Decimal.max(0, consumed.minus(allowance));
	return {
		fromAllowanceGiB,
		overageGiB,
		overageCost: bandwidthCost(overageGiB),
		remainingAllowanceGiB: allowance.minus(fromAllowanceGiB),
	};
}

/**
 * The at-cost value of allowance left unused at month-end, which returns to the
 * subsidy pool (it was budgeted as a potential cost the pool didn't incur).
 */
export function unusedAllowanceValue(remainingAllowanceGiB: Decimal | number): Decimal {
	return bandwidthCost(remainingAllowanceGiB);
}

// ── Charitable split (coarse accounting view; see FOUNDATION_SPLIT) ────────
/** Split a charitable-revenue amount into Admin / Programs / Subsidy. */
export function foundationSplit(feeAmount: Decimal | number): {
	admin: Decimal;
	programs: Decimal;
	subsidy: Decimal;
} {
	const fee = new Decimal(feeAmount);
	return {
		admin: CENTS(fee.mul(FOUNDATION_SPLIT.admin)),
		programs: CENTS(fee.mul(FOUNDATION_SPLIT.programs)),
		subsidy: CENTS(fee.mul(FOUNDATION_SPLIT.subsidy)),
	};
}

// ── Direct purchases (zero-cut, pass-through) ─────────────────────────────────
/** What a direct purchase delivers, which sets its fee basis. */
export type PurchaseType = "digital" | "physical" | "service";

/**
 * Fee breakdown for a direct purchase (zero-cut, all-in price).
 *
 * The listed price IS what the buyer pays, plus sales tax and nothing else. Card
 * processing and — on a digital sale — the buyer's first download come **out of**
 * that price, both paid to third parties. Anthers keeps $0.
 *
 * - `digital`: the first download is delivered at cost and deducted from the
 *   creator's earnings, so nobody buys something they cannot download. Redownloads
 *   draw the buyer's own streaming allowance instead.
 * - `physical` / `service`: no bytes are delivered, so there is no delivery cost.
 *
 * `crfFee` keeps its legacy key name and is **always zero** — the purchase fee it
 * used to carry was removed 2026-08-03. See the note at the return statement.
 */
export function calculateFees(
	amount: Decimal,
	opts: { deliveryBytes?: Decimal | number; type?: PurchaseType } = {},
) {
	const type = opts.type ?? "digital";
	const deliveryGiB = new Decimal(opts.deliveryBytes ?? 0).div(GIB);

	// Delivery = the FIRST download, included in the sale and paid out of the
	// creator's deduction — so nobody ever buys something they cannot download,
	// whatever their Badge. Redownloads draw the buyer's streaming allowance.
	// Physical goods and services deliver no bytes, so they carry none of this.
	let deliveryFee = new Decimal(0);
	if (type === "digital") {
		deliveryFee = CENTS(deliveryGiB.mul(BANDWIDTH_PER_GIB));
		// Any real download costs at least a cent to deliver — we can't bill sub-cent.
		if (deliveryGiB.gt(0) && deliveryFee.lte(0)) deliveryFee = new Decimal("0.01");
	}

	// The list price IS the advertised price: card processing comes out of it, not
	// on top of it. Sales tax is the only thing added, because a government-imposed
	// tax is the sole carve-out mandatory-fee disclosure law allows.
	const processingFee = CENTS(amount.mul(CARD_RATE).plus(CARD_FLAT));
	const salesTax = CENTS(amount.mul(SALES_TAX_RATE));
	const creatorEarnings = amount.minus(processingFee).minus(deliveryFee);
	const buyerTotal = amount.plus(salesTax);

	return {
		processingFee,
		deliveryFee,
		salesTax,
		// Anthers takes $0 from a creator transaction. The purchase fee
		// was removed 2026-08-03 — a commission on a creator's sale is the exact
		// feature Rev. Rul. 76-152 keyed on. The `crf_fee` column is NOT NULL, so it
		// stays and is always zero; dropping it is a separate migration.
		crfFee: new Decimal(0),
		creatorEarnings,
		buyerTotal,
	};
}

/**
 * A creator's monthly storage cost and the half-again on top of it.
 *
 * Storage beyond the free allowance is billed at DigitalOcean rates, plus half
 * again — the half is what funds free access and the charitable programs. Delivery is viewer-funded, so it is not billed here.
 * A self-hosting creator (Anthers stores/serves nothing) pays a flat fee instead.
 */
export function estimateStorageCost(params: { storageBytes: number; isSelfHosting?: boolean }): {
	storageGiB: Decimal;
	storageCost: Decimal;
	storageAff: Decimal;
	total: Decimal;
} {
	if (params.isSelfHosting) {
		const fee = new Decimal(SELF_HOST_FEE);
		return { storageGiB: new Decimal(0), storageCost: new Decimal(0), storageAff: fee, total: fee };
	}
	const billableGiB = Decimal.max(
		0,
		new Decimal(params.storageBytes).div(GIB).minus(FREE_STORAGE_GIB),
	);
	const storageCost = CENTS(billableGiB.mul(STORAGE_PER_GIB_MONTH));
	const storageAff = CENTS(storageCost.mul(AFF_INFRA_RATE));
	return { storageGiB: billableGiB, storageCost, storageAff, total: storageCost.plus(storageAff) };
}

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
	PHYSICAL_AFF_RATE,
	SALES_TAX_RATE,
	SELF_HOST_FEE,
	STORAGE_PER_GIB_MONTH,
	seedCost,
	timePoolFor,
} from "./constants.js";

/** Bytes per GiB (binary). */
const GIB = new Decimal("1073741824");
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Maximum discretionary Foundation subsidy per creator per month. */
export const MAX_MONTHLY_SUBSIDY = new Decimal("25.00");

// ── Payments (the at-cost card fee, added ON TOP of the charge) ───────────────
/**
 * The at-cost **Payments** line for a whole batched charge: card + processing,
 * 2.9% + $0.30. Added on top of the user's Seeds (like sales tax) — never carved
 * out of a Seed, so every $3 reaches its destination in full. $0 when nothing is
 * charged. ACH is cheaper to process, so its Payments line is smaller.
 */
export function cardFee(amount: Decimal | number): Decimal {
	const a = new Decimal(amount);
	return a.gt(0) ? CENTS(a.mul(CARD_RATE).plus(CARD_FLAT)) : new Decimal(0);
}

// ── Anthers-Seed decomposition ────────────────────────────────────────────────
/**
 * Decompose a user's Anthers-Seeds into where each $3 goes. The full $3 per Seed
 * reaches its destination — the at-cost Payments line rides on top of the whole
 * charge (see `cardFee`), never inside a Seed:
 *
 *   Anthers-Seed value ($3 × n) = bandwidth (at cost) + Time Pool + Foundation
 *
 * Time Pool ($1.50/Seed) is a fixed target to creators; bandwidth is the user's
 * own at-cost usage; the **Foundation is the remainder** (the shock absorber —
 * lighter streamers leave more for the mission). Free (n = 0) pays $0: its small
 * Time Pool and in-floor bandwidth are subsidised, and it funds no Foundation.
 */
export function anthersSeedBreakdown(
	anthersSeeds: number,
	opts: { bandwidthGiB?: Decimal | number } = {},
): {
	anthersSeeds: number;
	seedValue: Decimal;
	timePool: Decimal;
	bandwidth: Decimal;
	foundation: Decimal;
	subsidised: boolean;
} {
	const n = Math.max(0, Math.floor(anthersSeeds));
	const seedValue = new Decimal(seedCost(n));
	const timePool = new Decimal(timePoolFor(n));
	const bandwidth = bandwidthCost(opts.bandwidthGiB ?? 0);
	if (n === 0) {
		return {
			anthersSeeds: 0,
			seedValue: new Decimal(0),
			timePool,
			bandwidth,
			foundation: new Decimal(0),
			subsidised: true,
		};
	}
	const foundation = seedValue.minus(timePool).minus(bandwidth);
	return { anthersSeeds: n, seedValue, timePool, bandwidth, foundation, subsidised: false };
}

/**
 * The full monthly support breakdown for a user holding `anthersSeeds` Anthers-
 * Seeds and `creatorSeeds` directed Seeds, given their actual `bandwidthGiB`.
 *
 * Directed Seeds reach creators 100%; Anthers-Seeds decompose as above; the
 * at-cost Payments line is one card fee on the whole Seed subtotal, ON TOP.
 */
export function supportBreakdown(params: {
	anthersSeeds: number;
	creatorSeeds: number;
	bandwidthGiB?: Decimal | number;
}): {
	creatorDirect: Decimal;
	timePool: Decimal;
	bandwidth: Decimal;
	foundation: Decimal;
	toCreators: Decimal;
	seedsSubtotal: Decimal;
	payments: Decimal;
	total: Decimal;
} {
	const anthers = anthersSeedBreakdown(params.anthersSeeds, { bandwidthGiB: params.bandwidthGiB });
	const creatorDirect = new Decimal(seedCost(Math.max(0, Math.floor(params.creatorSeeds))));
	const seedsSubtotal = creatorDirect.plus(anthers.seedValue);
	const payments = cardFee(seedsSubtotal);
	return {
		creatorDirect,
		timePool: anthers.timePool,
		bandwidth: anthers.bandwidth,
		foundation: anthers.foundation,
		toCreators: creatorDirect.plus(anthers.timePool),
		seedsSubtotal,
		payments,
		total: seedsSubtotal.plus(payments),
	};
}

/** A rung of Anthers's Badge ladder as a display view model — money pre-rounded to 2dp. */
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
	/** "Supports Anthers" — your bandwidth (at cost) + the Foundation remainder. */
	supportsAnthers: string;
	/** Streaming allowance (GiB) at this rank. */
	allowanceGiB: number;
	subsidised: boolean;
}

/**
 * The rank ladder as view models, low → high (free … blossom). Pure and static —
 * derived from the Seed dials, no per-user data — so the Subscribe page, the
 * `/subscriptions/ranks` route, and inline-unlock all render the same numbers and
 * can't drift. "Supports Anthers" bundles bandwidth (at cost) + the Foundation
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

// ── Foundation fee split (coarse accounting view; see FOUNDATION_SPLIT) ────────
/** Split a Foundation-fee amount into Admin / Programs / Subsidy. */
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
/** What a direct purchase delivers, which sets its Foundation Fee basis. */
export type PurchaseType = "digital" | "physical" | "service";

/**
 * Fee breakdown for a direct purchase (zero-cut, pass-through model).
 *
 * The creator receives the full listed price; the Anthers Foundation Fee, delivery
 * bandwidth, and card + sales tax are added on top and paid by the buyer — never
 * subtracted from earnings. Anthers keeps $0.
 *
 * - `digital`: the AFF is the **Digital AFF** — 50% of the download's bandwidth —
 *   and the buyer also pays that bandwidth at cost (folded into the price, never
 *   drawn from the streaming allowance).
 * - `physical` / `service`: no bytes are delivered, so the AFF is a nominal
 *   **Physical & Service AFF** of 1% of the price, and there is no delivery fee.
 *
 * `crfFee` keeps its legacy key name but holds the Foundation Fee (AFF) amount.
 */
export function calculateFees(
	amount: Decimal,
	opts: { deliveryBytes?: Decimal | number; type?: PurchaseType } = {},
) {
	const type = opts.type ?? "digital";
	const deliveryGiB = new Decimal(opts.deliveryBytes ?? 0).div(GIB);

	let deliveryFee = new Decimal(0);
	let foundationFee: Decimal;
	if (type === "digital") {
		deliveryFee = CENTS(deliveryGiB.mul(BANDWIDTH_PER_GIB));
		foundationFee = CENTS(deliveryGiB.mul(BANDWIDTH_PER_GIB).mul(AFF_INFRA_RATE));
		// Any real download costs at least a cent to deliver — we can't bill sub-cent.
		if (deliveryGiB.gt(0) && deliveryFee.lte(0)) deliveryFee = new Decimal("0.01");
	} else {
		foundationFee = CENTS(amount.mul(PHYSICAL_AFF_RATE));
	}

	const creatorEarnings = amount;
	// Card + tax apply to the buyer-paid subtotal (price + AFF + delivery); both leave the system.
	const subtotal = amount.plus(foundationFee).plus(deliveryFee);
	const processingFee = CENTS(subtotal.mul(CARD_RATE).plus(CARD_FLAT));
	const salesTax = CENTS(subtotal.mul(SALES_TAX_RATE));
	const buyerTotal = subtotal.plus(processingFee).plus(salesTax);

	return {
		processingFee,
		deliveryFee,
		salesTax,
		crfFee: foundationFee,
		creatorEarnings,
		buyerTotal,
	};
}

/**
 * A creator's monthly storage cost and the storage-side Foundation Fee.
 *
 * Storage beyond the free allowance is billed at DigitalOcean rates; the AFF is
 * 50% of that storage cost. Delivery is viewer-funded, so it is not billed here.
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

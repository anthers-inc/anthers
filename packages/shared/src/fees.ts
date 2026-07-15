// SPDX-License-Identifier: AGPL-3.0-or-later
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	BADGE_ORDER,
	BADGE_PLANS,
	BANDWIDTH_PER_GIB,
	type Badge,
	badgeLabel,
	CARD_FLAT,
	CARD_RATE,
	FOUNDATION_SPLIT,
	FREE_STORAGE_GIB,
	PHYSICAL_AFF_RATE,
	SALES_TAX_RATE,
	SEED_PRICE,
	SELF_HOST_FEE,
	STORAGE_PER_GIB_MONTH,
} from "./constants.js";

/** Bytes per GiB (binary). */
const GIB = new Decimal("1073741824");
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Maximum discretionary Foundation subsidy per creator per month. */
export const MAX_MONTHLY_SUBSIDY = new Decimal("25.00");

// ── Badge plan price decomposition ───────────────────────────────────────────
/**
 * Decompose a Badge plan's whole-dollar price into its parts (full precision):
 *
 *   Price = Time Pool + Seeds + Community Share
 *
 * where Time Pool (by watch-time) and Seeds (× $1, direct) both go 100% to
 * creators, and Community Share is the derived remainder funding the Foundation.
 *
 * Free is special: it pays $0, so its Community Share is $0 and its small Time
 * Pool is subsidised from the pool (still `toCreators`, but not user-funded).
 */
export function badgePriceBreakdown(badge: Badge): {
	price: Decimal;
	timePool: Decimal;
	seeds: Decimal;
	communityShare: Decimal;
	toCreators: Decimal;
	subsidised: boolean;
} {
	const plan = BADGE_PLANS[badge];
	const price = new Decimal(plan.price);
	const timePool = new Decimal(plan.timePool);
	const seeds = new Decimal(plan.seeds).mul(SEED_PRICE);
	const toCreators = timePool.plus(seeds);
	// Free is fully subsidised — the user contributes nothing, so no Community Share.
	const communityShare = plan.price === 0 ? new Decimal(0) : price.minus(toCreators);
	return { price, timePool, seeds, communityShare, toCreators, subsidised: plan.price === 0 };
}

/** A Badge plan as a display view model — the price decomposition + what's included.
 *  Money fields are pre-rounded to 2dp strings, ready to render. */
export interface BadgePlanView {
	id: Badge;
	name: string;
	price: number;
	timePool: string;
	seeds: number;
	freeBwGiB: number;
	communityShare: string;
	toCreators: string;
	subsidised: boolean;
}

/**
 * The Badge plans as view models, low → high. Derived entirely from the frozen
 * `BADGE_PLANS` table — pure and static, no per-user data. Shared by the
 * `/subscriptions/badges` route and the Subscribe page so the two can't drift
 * (and so the page can render synchronously with no fetch / loading skeleton).
 */
export function badgePlanViews(): BadgePlanView[] {
	return BADGE_ORDER.map((badge) => {
		const bd = badgePriceBreakdown(badge);
		const plan = BADGE_PLANS[badge];
		return {
			id: badge,
			name: badgeLabel(badge),
			price: plan.price,
			timePool: bd.timePool.toFixed(2),
			seeds: plan.seeds,
			freeBwGiB: plan.freeBwGiB,
			communityShare: bd.communityShare.toFixed(2),
			toCreators: bd.toCreators.toFixed(2),
			subsidised: bd.subsidised,
		};
	});
}

// ── Bandwidth: at-cost wallet + free monthly allowance ────────────────────────
/** At-cost bandwidth cost for a number of GiB (a pass-through, no fee). */
export function bandwidthCost(gib: Decimal | number): Decimal {
	return CENTS(new Decimal(gib).mul(BANDWIDTH_PER_GIB));
}

/**
 * Apply a month's stream bandwidth against the free allowance first, then the
 * prepaid wallet. The allowance is drawn down before any wallet dollars, does not
 * roll over, and whatever is unused returns to the subsidy pool at month-end.
 *
 * `walletBalance` is in dollars. A positive `shortfall` is bandwidth the wallet
 * couldn't cover (drives low-balance warnings / the free-allowance floor).
 */
export function drawBandwidth(params: {
	consumedGiB: Decimal | number;
	freeAllowanceGiB: Decimal | number;
	walletBalance: Decimal | number;
}): {
	fromAllowanceGiB: Decimal;
	fromWalletGiB: Decimal;
	walletCost: Decimal;
	walletDebit: Decimal;
	shortfall: Decimal;
	remainingAllowanceGiB: Decimal;
	remainingWallet: Decimal;
} {
	const consumed = new Decimal(params.consumedGiB);
	const allowance = new Decimal(params.freeAllowanceGiB);
	const wallet = new Decimal(params.walletBalance);

	const fromAllowanceGiB = Decimal.min(consumed, allowance);
	const fromWalletGiB = consumed.minus(fromAllowanceGiB);
	const walletCost = bandwidthCost(fromWalletGiB);
	const walletDebit = Decimal.min(wallet, walletCost);
	const shortfall = walletCost.minus(walletDebit);

	return {
		fromAllowanceGiB,
		fromWalletGiB,
		walletCost,
		walletDebit,
		shortfall,
		remainingAllowanceGiB: allowance.minus(fromAllowanceGiB),
		remainingWallet: wallet.minus(walletDebit),
	};
}

/**
 * The at-cost value of a free allowance left unused at month-end, which returns
 * to the subsidy pool (it was budgeted as a potential cost the pool didn't incur).
 */
export function unusedAllowanceValue(remainingAllowanceGiB: Decimal | number): Decimal {
	return bandwidthCost(remainingAllowanceGiB);
}

// ── Foundation fee split ──────────────────────────────────────────────────────
/** Split a Foundation-fee amount into Admin / Programs / Subsidy (see FOUNDATION_SPLIT). */
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
 *   drawn from the streaming wallet).
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

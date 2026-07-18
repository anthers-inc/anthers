// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * V4 economics constants — the "Big Rethink" model (badge prices + Payments bucket
 * revised 2026-07-17; see PAYMENTS REVAMP/Anthers Payment Architecture).
 *
 * Anthers keeps $0: every dollar a user pays is bandwidth (at cost), money to
 * creators (Time Pool + Seeds), the user's Community Share to the Anthers
 * Foundation, or the at-cost **Payments** bucket — card, Stripe Tax, Connect
 * payouts, disputes, refunds, reserve: the cost of moving money, folded into the
 * price rather than surcharged. There is no platform margin.
 *
 * The user's streaming decision is a CHOSEN Badge plan, not a quantity of
 * bandwidth. Each plan's whole-dollar Price decomposes into Payments + Time Pool +
 * Seeds + Community Share, with Seeds and Community Share held at their prior
 * values and **Time Pool the derived remainder** after Payments. The Payments
 * bucket is a reconciled, conservative figure (surplus → subsidy); the model
 * behind it is PAYMENTS REVAMP/threshold_model.py. Bandwidth is decoupled into an
 * at-cost prepaid wallet with a per-tier free monthly allowance.
 *
 * Supersedes the V3 model (bandwidth-as-purchase-lever, rolling badges, "Boost").
 */

// ── Badge plans ──────────────────────────────────────────────────────────────
/** A Badge plan. "free" is the floor; the four paid plans ascend. */
export type Badge = "free" | "root" | "sprout" | "petal" | "blossom";

/** Ordered low → high. Index is the rank used for point-in-time gate comparison. */
export const BADGE_ORDER = ["free", "root", "sprout", "petal", "blossom"] as const;

/**
 * A Seed is a $1 unit of direct, per-creator support — 100% to the creator (no
 * Foundation fee, no payout processing). A plan's `seeds` is a quantity; it
 * contributes `seeds × SEED_PRICE` dollars to the money-to-creators total.
 */
export const SEED_PRICE = 1;

/** A single Badge plan's frozen dials. Time Pool is the derived remainder. */
export interface BadgePlan {
	badge: Badge;
	/** Whole-dollar monthly plan price (Free = 0). */
	price: number;
	/**
	 * Payments bucket ($): the at-cost overhead of moving money — card, Stripe Tax,
	 * Connect payouts, disputes, refunds, reserve — folded into the price, never
	 * surcharged. A reconciled, conservative launch figure (surplus → subsidy); see
	 * PAYMENTS REVAMP/threshold_model.py. Free is 0 (no charge fires).
	 */
	payments: number;
	/**
	 * Time Pool budget ($), distributed to watched creators by watch-time. For paid
	 * plans this is the derived remainder: price − payments − seeds − communityShare.
	 * Free's is subsidised by the Foundation (the user pays $0).
	 */
	timePool: number;
	/** Included Seeds (quantity × SEED_PRICE), direct to creators, user-directed. */
	seeds: number;
	/** Community Share ($) to the Anthers Foundation. Held at prior values; Free = 0. */
	communityShare: number;
	/** Free monthly bandwidth allowance (GiB), subsidised, drawn down first. */
	freeBwGiB: number;
}

/**
 * The frozen badge-plan table (badge prices + Payments revised 2026-07-17).
 *
 * Price = Payments + Time Pool + Seeds + Community Share, with Seeds and Community
 * Share held at their prior dollars (Root $1 · Sprout $2 · Petal $4 · Blossom $10)
 * and Time Pool absorbing the remainder. Every paid tier delivers more to creators
 * (Time Pool + Seeds) than the prior $4/$8/$16/$32 model. Payments assumes a
 * conservative $20 launch payout threshold and a pessimistic creator ratio (see
 * PAYMENTS REVAMP/threshold_model.py); it over-collects on purpose and the surplus
 * returns to the subsidy pool.
 *
 * Free pays $0 (no Payments); its small Time Pool is subsidised from the pool, not
 * paid by the user, so Free contributes no Community Share.
 */
export const BADGE_PLANS: Record<Badge, BadgePlan> = {
	free: {
		badge: "free",
		price: 0,
		payments: 0,
		timePool: 0.05,
		seeds: 0,
		communityShare: 0,
		freeBwGiB: 5,
	},
	root: {
		badge: "root",
		price: 5,
		payments: 0.93,
		timePool: 2.07,
		seeds: 1,
		communityShare: 1,
		freeBwGiB: 10,
	},
	sprout: {
		badge: "sprout",
		price: 10,
		payments: 1.19,
		timePool: 4.81,
		seeds: 2,
		communityShare: 2,
		freeBwGiB: 20,
	},
	petal: {
		badge: "petal",
		price: 20,
		payments: 1.7,
		timePool: 11.3,
		seeds: 3,
		communityShare: 4,
		freeBwGiB: 30,
	},
	blossom: {
		badge: "blossom",
		price: 40,
		payments: 2.73,
		timePool: 23.27,
		seeds: 4,
		communityShare: 10,
		freeBwGiB: 50,
	},
} as const;

/** Rank of a badge (0 = free … 4 = blossom), for point-in-time gate comparison. */
export function badgeRank(badge: Badge): number {
	return BADGE_ORDER.indexOf(badge);
}

/** True if a *currently held* badge meets a required gate level (point-in-time). */
export function badgeMeets(held: Badge, required: Badge): boolean {
	return badgeRank(held) >= badgeRank(required);
}

/** Human label for a Badge (Free / Root / Sprout / Petal / Blossom). */
export function badgeLabel(badge: Badge): string {
	return badge.charAt(0).toUpperCase() + badge.slice(1);
}

// ── Bandwidth (at cost, pass-through — the wallet buys this) ──────────────────
/** Delivery/egress bandwidth, at DigitalOcean cost. Neutral to creators. */
export const BANDWIDTH_PER_GIB = 0.01;

// ── Foundation Fee rates ─────────────────────────────────────────────────────
/**
 * AFF as a fraction of the infrastructure it rides on: 50%.
 * Storage AFF = 50% of a creator's storage cost. The Digital AFF on a direct
 * download = 50% of that download's bandwidth (= BANDWIDTH_PER_GIB × this).
 */
export const AFF_INFRA_RATE = 0.5;
/** Physical & Service AFF: 1% of price (no bytes delivered → nominal). */
export const PHYSICAL_AFF_RATE = 0.01;

/**
 * How every Foundation-fee dollar (users' Community Share + creators' storage AFF)
 * splits: Admin (operations) / Programs (charitable work) / Subsidy (free-access
 * pool covering all free bandwidth allowances, free-user Time Pool + Seeds, and
 * new-creator storage). Sums to 1.
 */
export const FOUNDATION_SPLIT = { admin: 0.1, programs: 0.4, subsidy: 0.5 } as const;

// ── Storage & self-hosting (creator side) ────────────────────────────────────
/** DigitalOcean Spaces storage, $/GiB/month. */
export const STORAGE_PER_GIB_MONTH = 0.02;
/** Free creator storage allowance (GiB), subsidised (reconciled to 50 in V4). */
export const FREE_STORAGE_GIB = 50;
/** Flat monthly fee for a self-hosting creator (Anthers stores/serves nothing). */
export const SELF_HOST_FEE = 1;

// ── Payments (added on top of the subtotal; both leave the system) ───────────
/** Card processing: 2.9% + $0.30. */
export const CARD_RATE = 0.029;
export const CARD_FLAT = 0.3;
/** US average combined state+local sales tax, illustrative. */
export const SALES_TAX_RATE = 0.065;

// ── Payouts ──────────────────────────────────────────────────────────────────
/**
 * Minimum accrued creator balance before a Connect payout fires ($). The dial
 * that sets Connect cost: higher → fewer payout events → cheaper, but the smallest
 * creators wait longer. Launch value; ratchet down as the creator ratio matures,
 * and → 0 once direct-ACH payouts land. See PAYMENTS REVAMP/threshold_model.py.
 */
export const PAYOUT_THRESHOLD = 20;

// ── Delivery assumption (AV1 1080p60) ────────────────────────────────────────
/** Delivered GiB per stream-hour — converts watch-hours to allowance/wallet draw. */
export const DELIVERY_GIB_PER_HOUR = 1.7;

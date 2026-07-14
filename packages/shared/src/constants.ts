// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * V4 economics constants — the "Big Rethink" model (frozen 2026-07-14, Phase 0).
 *
 * Anthers keeps $0: every dollar a user pays is bandwidth (at cost), money to
 * creators (Time Pool + Seeds), the user's Community Share to the Anthers
 * Foundation, or unavoidable card + sales tax. There is no platform margin.
 *
 * The user's streaming decision is a CHOSEN Badge plan, not a quantity of
 * bandwidth. Each plan's whole-dollar Price decomposes into Time Pool + Seeds +
 * Community Share (the derived remainder). Bandwidth is decoupled into an at-cost
 * prepaid wallet with a per-tier free monthly allowance.
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

/** A single Badge plan's frozen dials. Community Share is derived, not stored. */
export interface BadgePlan {
	badge: Badge;
	/** Whole-dollar monthly plan price (Free = 0). */
	price: number;
	/** Time Pool budget ($), distributed to watched creators by watch-time. */
	timePool: number;
	/** Included Seeds (quantity × SEED_PRICE), direct to creators, user-directed. */
	seeds: number;
	/** Free monthly bandwidth allowance (GiB), subsidised, drawn down first. */
	freeBwGiB: number;
}

/**
 * The frozen V4 badge-plan table (Phase 0, 2026-07-14).
 *
 * Community Share = Price − Time Pool − (seeds × SEED_PRICE):
 *   Root $1 · Sprout $2 · Petal $4 · Blossom $10.
 * Free pays $0; its small Time Pool is subsidised from the pool, not paid by the
 * user, so Free contributes no Community Share (see `communityShare` in fees.ts).
 */
export const BADGE_PLANS: Record<Badge, BadgePlan> = {
	free: { badge: "free", price: 0, timePool: 0.05, seeds: 0, freeBwGiB: 5 },
	root: { badge: "root", price: 4, timePool: 2, seeds: 1, freeBwGiB: 10 },
	sprout: { badge: "sprout", price: 8, timePool: 4, seeds: 2, freeBwGiB: 20 },
	petal: { badge: "petal", price: 16, timePool: 9, seeds: 3, freeBwGiB: 30 },
	blossom: { badge: "blossom", price: 32, timePool: 18, seeds: 4, freeBwGiB: 50 },
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

// ── Delivery assumption (AV1 1080p60) ────────────────────────────────────────
/** Delivered GiB per stream-hour — converts watch-hours to allowance/wallet draw. */
export const DELIVERY_GIB_PER_HOUR = 1.7;

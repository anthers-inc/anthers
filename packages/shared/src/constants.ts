// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * V3 economics constants. Anthers keeps $0: every dollar a user pays is bandwidth
 * (at cost), money to creators, the Anthers Foundation charity fee (AFF), or
 * card + sales tax. There is no platform margin. These are the frozen seeds from
 * the V3 spec — the AFF rate, Time Pool rate, and free-tier size remain tunable.
 */

// ── Usage (per GiB, USD) ─────────────────────────────────────────────────────
/** Delivery/egress bandwidth — a pass-through, at DigitalOcean cost. */
export const BANDWIDTH_PER_GIB = 0.01;
/** Anthers Foundation Fee on usage: 50% of bandwidth. */
export const USAGE_AFF_PER_GIB = 0.005;
/** Time Pool funding per GiB — to creators, distributed by watch-time. */
export const TIME_POOL_PER_GIB = 0.015;
/** All-in usage price per GiB = bandwidth + AFF + Time Pool = $0.03. */
export const USAGE_PER_GIB = BANDWIDTH_PER_GIB + USAGE_AFF_PER_GIB + TIME_POOL_PER_GIB;
/** Usage is sold in 100 GiB / $3.00 increments on top of the free allowance. */
export const USAGE_PACK_GIB = 100;

/** Free monthly usage allowance (GiB), subsidized by the Foundation. */
export const FREE_USAGE_GIB = 3;
/** Free creator storage allowance (GiB). */
export const FREE_STORAGE_GIB = 3;

// ── Foundation Fee rates ─────────────────────────────────────────────────────
/** AFF as a fraction of the infrastructure it rides on (bandwidth or storage): 50%. */
export const AFF_INFRA_RATE = 0.5;
/** Physical & Service AFF: 1% of price (no bytes delivered → nominal). */
export const PHYSICAL_AFF_RATE = 0.01;

// ── Storage & self-hosting ───────────────────────────────────────────────────
/** DigitalOcean Spaces storage, $/GiB/month. */
export const STORAGE_PER_GIB_MONTH = 0.02;
/** Flat monthly fee for a self-hosting creator (Anthers stores/serves nothing). */
export const SELF_HOST_FEE = 1;

// ── Payments (added on top of the subtotal; both leave the system) ───────────
/** Card processing: 2.9% + $0.30. */
export const CARD_RATE = 0.029;
export const CARD_FLAT = 0.3;
/** US average combined state+local sales tax, illustrative. */
export const SALES_TAX_RATE = 0.065;

// ── Anthers Badges (rolling; from combined Usage + Boost spend) ───────────────
/** Minimum combined-spend ($) each Badge requires. */
export const BADGE_THRESHOLDS = {
	root: 3,
	sprout: 7,
	petal: 15,
	blossom: 30,
} as const;

/** A user's Anthers Badge, or "none" below the Root floor. */
export type Badge = keyof typeof BADGE_THRESHOLDS | "none";

/** Ordered low → high, with "none" as the floor. */
export const BADGE_ORDER = ["none", "root", "sprout", "petal", "blossom"] as const;

/** The Badge a combined-spend amount clears (highest threshold met). */
export function badgeForSpend(spend: number): Badge {
	if (spend >= BADGE_THRESHOLDS.blossom) return "blossom";
	if (spend >= BADGE_THRESHOLDS.petal) return "petal";
	if (spend >= BADGE_THRESHOLDS.sprout) return "sprout";
	if (spend >= BADGE_THRESHOLDS.root) return "root";
	return "none";
}

/** Human label for a Badge (Root / Sprout / Petal / Blossom / Free). */
export function badgeLabel(badge: Badge): string {
	if (badge === "none") return "Free";
	return badge.charAt(0).toUpperCase() + badge.slice(1);
}

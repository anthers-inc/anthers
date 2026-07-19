// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * Support-model economics constants (supersedes the V4 "Badge plans" model).
 *
 * One primitive: a **Seed** — a flat **$3/month** — pointed one of two ways:
 *   - at a **creator** (a *directed Seed*): 100% to them, no fee, no payout
 *     processing; clears that creator's Seed Gates in $3 increments; or
 *   - at **Anthers** (an *Anthers-Seed*): covers the user's streaming (at cost),
 *     funds the **Time Pool** ($1.50/Seed, to creators by watch-time), sets the
 *     user's **rank**, and leaves a **remainder** for the Anthers Foundation.
 *
 * A user's rank IS their Anthers-Seed count: free = 0, root = 1 … blossom = 4,
 * with a "+" beyond four (Blossom+). Bandwidth is folded into Anthers-Seeds — no
 * wallet — as a 15 GiB free floor for everyone plus a 60 GiB allowance per Seed.
 *
 * The at-cost **Payments** line (card + processing) is added ON TOP of the whole
 * monthly charge, like sales tax (ACH-discountable) — never carved out of a Seed,
 * so every $3 reaches its destination in full and "100% to creators" holds for
 * every user. There is no platform margin and no fixed "Community Share": the
 * Foundation is the remainder of each Anthers-Seed, read obligations-first.
 *
 * Seed price is locked at $3; the allocation dials (Time-Pool-per-Seed, free
 * floor, GiB-per-Seed) are the current tuned values — see the Support Model
 * Playground (50.04) and Subscription Economics (50.01).
 */

// ── Rank (= Anthers-Seed count) ──────────────────────────────────────────────
/** A rank name. "free" = 0 Anthers-Seeds; root … blossom = 1 … 4 (blossom = 4+). */
export type Badge = "free" | "root" | "sprout" | "petal" | "blossom";

/** Ordered low → high. Index is the rank (Anthers-Seed count) for gate comparison. */
export const BADGE_ORDER = ["free", "root", "sprout", "petal", "blossom"] as const;

/** The highest *named* rank's Anthers-Seed count (blossom = 4); beyond it is "blossom+". */
export const MAX_NAMED_RANK = 4;

// ── Seed dials (Seed price locked; allocation dials tuned-but-tunable) ────────
/** A Seed — a flat $3/month unit of support (creator-directed or an Anthers-Seed). */
export const SEED_PRICE = 3;
/** Time Pool funded per Anthers-Seed ($), distributed to creators by watch-time. */
export const TIME_POOL_PER_SEED = 1.5;
/** The Free rank's small subsidised Time Pool ($) — the user pays $0. */
export const FREE_TIME_POOL = 0.05;
/** Free streaming floor (GiB/mo) on every account, subsidised by the Foundation. */
export const FREE_FLOOR_GIB = 15;
/** Streaming allowance (GiB/mo) added per Anthers-Seed, on top of the free floor. */
export const GIB_PER_SEED = 60;

// ── Rank helpers ─────────────────────────────────────────────────────────────
/** The rank name for an Anthers-Seed count (0 = free … 4+ = blossom). */
export function rankForSeeds(anthersSeeds: number): Badge {
	const n = Math.max(0, Math.min(MAX_NAMED_RANK, Math.floor(anthersSeeds)));
	return BADGE_ORDER[n];
}

/** Rank of a name (0 = free … 4 = blossom), for point-in-time gate comparison. */
export function badgeRank(badge: Badge): number {
	return BADGE_ORDER.indexOf(badge);
}

/** True if a *currently held* rank meets a required gate rank (point-in-time). */
export function badgeMeets(held: Badge, required: Badge): boolean {
	return badgeRank(held) >= badgeRank(required);
}

/** True if a held Anthers-Seed count meets a required rank (handles blossom+). */
export function seedsMeetRank(anthersSeeds: number, required: Badge): boolean {
	return Math.floor(anthersSeeds) >= badgeRank(required);
}

/** Human label for a rank (Free / Root / Sprout / Petal / Blossom). */
export function badgeLabel(badge: Badge): string {
	return badge.charAt(0).toUpperCase() + badge.slice(1);
}

/** Label for an Anthers-Seed count, with a "+" past blossom (e.g. "Blossom+"). */
export function rankLabel(anthersSeeds: number): string {
	const n = Math.max(0, Math.floor(anthersSeeds));
	const base = badgeLabel(rankForSeeds(n));
	return n > MAX_NAMED_RANK ? `${base}+` : base;
}

// ── Per-Seed derived amounts ─────────────────────────────────────────────────
/** Monthly $ for `n` Seeds (Anthers or creator-directed): n × $3. */
export function seedCost(n: number): number {
	return SEED_PRICE * Math.max(0, n);
}

/** Time Pool $ funded by holding `n` Anthers-Seeds (free rank = subsidised FREE_TIME_POOL). */
export function timePoolFor(anthersSeeds: number): number {
	return anthersSeeds <= 0 ? FREE_TIME_POOL : TIME_POOL_PER_SEED * anthersSeeds;
}

/** Streaming allowance (GiB) for `n` Anthers-Seeds: the free floor + 60/Seed. */
export function allowanceGiB(anthersSeeds: number): number {
	return FREE_FLOOR_GIB + GIB_PER_SEED * Math.max(0, anthersSeeds);
}

// ── Bandwidth (at cost, pass-through — folded into Anthers-Seeds) ─────────────
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
 * Coarse accounting split of Foundation-fee dollars into Admin / Programs /
 * Subsidy (free-access pool). The support model reads the Foundation budget
 * **obligations-first** (overhead + free access off the top, programs residual,
 * Admin held ≤ 30%); this fixed split is a reporting convenience, not a
 * per-transaction rule. Sums to 1.
 */
export const FOUNDATION_SPLIT = { admin: 0.1, programs: 0.4, subsidy: 0.5 } as const;

// ── Storage & self-hosting (creator side) ────────────────────────────────────
/** DigitalOcean Spaces storage, $/GiB/month. */
export const STORAGE_PER_GIB_MONTH = 0.02;
/** Free creator storage allowance (GiB), subsidised. */
export const FREE_STORAGE_GIB = 50;
/** Flat monthly fee for a self-hosting creator (Anthers stores/serves nothing). */
export const SELF_HOST_FEE = 1;

// ── Payments (added ON TOP of the Seed charge; both leave the system) ─────────
/** Card processing: 2.9% + $0.30, on the whole batched charge, added on top. */
export const CARD_RATE = 0.029;
export const CARD_FLAT = 0.3;
/** US average combined state+local sales tax, illustrative. */
export const SALES_TAX_RATE = 0.065;

// ── Payouts ──────────────────────────────────────────────────────────────────
/**
 * Minimum accrued creator balance before a Connect payout fires ($). Higher →
 * fewer payout events → cheaper, but the smallest creators wait longer. Launch
 * value; ratchet down as the creator ratio matures, and → 0 once direct-ACH lands.
 */
export const PAYOUT_THRESHOLD = 20;

// ── Delivery assumption (AV1 1080p60) ────────────────────────────────────────
/** Delivered GiB per stream-hour — converts watch-hours to allowance draw. */
export const DELIVERY_GIB_PER_HOUR = 1.7;

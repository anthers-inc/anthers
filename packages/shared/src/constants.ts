// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * Support-model economics constants (supersedes the V4 "Badge plans" model).
 *
 * One primitive: a **Seed** — a flat **$3/month** — pointed one of two ways:
 *   - at a **creator** (a *directed Seed*): 100% to them, no fee, no payout
 *     processing; clears that creator's Seed Gates in $3 increments; or
 *   - at **Anthers** (an *Anthers-Seed*): covers the user's streaming (at cost),
 *     funds the **Time Pool** ($1.50/Seed, to creators by watch-time), earns
 *     **Anthers's Badges**, and leaves a **remainder** for the Anthers Foundation.
 *
 * A **Seed** is what the user gives; a **Badge** is what the recipient returns.
 * Anthers is a recipient like any creator — it simply defines its own Badge set
 * (root/sprout/petal/blossom at 1/2/3/4 Anthers-Seeds). Bandwidth is folded into
 * Anthers-Seeds — no wallet — as a 15 GiB free floor plus 60 GiB per Seed.
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

// ── Badges (what a recipient returns for Seeds) ───────────────────────────────
/**
 * A Badge: a name at a whole-Seed threshold. This shape is the whole point — a
 * Badge is identified by the Seeds it takes to hold, never by its position in a
 * list, because an issuer may place Badges at ANY Seed levels. A creator's set of
 * 1/3/5/7 is exactly as valid as Anthers's 1/2/3/4; the only rule is that the
 * granularity floor is one Seed.
 *
 * This replaced an enum whose *index* was compared against a Seed count. That
 * worked only because Anthers's Badges happen to sit at consecutive integers, so
 * index and threshold coincided — an accident, not a design. Under any
 * non-consecutive set it mis-resolved access silently: no error, just wrong
 * answers. Compare thresholds, never positions.
 */
export interface BadgeDef {
	name: string;
	/** Whole Seeds given to the issuer required to hold this Badge. */
	threshold: number;
}

/** Anthers's own Badge set — ordinary Badges; Anthers just defines its own. */
export const ANTHERS_BADGES: readonly BadgeDef[] = [
	{ name: "root", threshold: 1 },
	{ name: "sprout", threshold: 2 },
	{ name: "petal", threshold: 3 },
	{ name: "blossom", threshold: 4 },
] as const;

/** The names in Anthers's set, for the places that still need a closed union. */
export type Badge = "root" | "sprout" | "petal" | "blossom";

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

// ── Badge helpers ────────────────────────────────────────────────────────────
/**
 * The Badge a holder of `seeds` currently holds in `badges`, and whether it renders
 * with a "+".
 *
 * The rule, uniformly: your Badge is the **highest-threshold Badge whose threshold
 * you meet**; holding *strictly more* Seeds than that threshold adds a "+". The "+"
 * applies BETWEEN Badges, not only past the top of the set — with Badges at 2 and 4,
 * a holder of 3 Seeds has the 2-Seed Badge with a "+". It honours someone who chose
 * to give a little extra; whether it *carries* anything is the issuer's choice.
 *
 * Returns `badge: null` below the lowest threshold (no Badge held).
 */
export function badgeFor(
	seeds: number,
	badges: readonly BadgeDef[] = ANTHERS_BADGES,
): { badge: BadgeDef | null; plus: boolean } {
	const held = Math.max(0, Math.floor(seeds));
	let best: BadgeDef | null = null;
	for (const b of badges) {
		if (b.threshold <= held && (best === null || b.threshold > best.threshold)) best = b;
	}
	return { badge: best, plus: best !== null && held > best.threshold };
}

/**
 * A display key covering "no Badge held" alongside the real ones.
 *
 * 0 Seeds is the *absence* of a Badge, not a Badge named "free" — but the UI still
 * needs something to key its art and labels on for that state, and `Record<Badge, …>`
 * maps predate the distinction. This is the seam: the model says four Badges, the
 * display says five states.
 */
export type BadgeKey = Badge | "free";

/**
 * Compatibility layer over the threshold model, keeping the names the call sites
 * already use while fixing what they MEAN.
 *
 * `badgeRank` used to be `BADGE_ORDER.indexOf(name)` — a position. It now returns the
 * Badge's THRESHOLD. For Anthers's own set those coincide (Badges sit at 1/2/3/4, so
 * index == threshold), which is exactly why the old code worked and exactly why it was
 * only ever accidentally correct. Any Badge set with gaps broke it silently. Routing
 * these through thresholds fixes the semantics ahead of the call-site migration, so the
 * branch builds and the bug is closed in one step rather than gated behind the other.
 *
 * These are a migration aid, not the destination — prefer `badgeFor` / `seedsMeet`.
 */
export const BADGE_ORDER: readonly BadgeKey[] = [
	"free",
	...ANTHERS_BADGES.map((b) => b.name as Badge),
] as const;

/** The Badge name held at `anthersSeeds`, or "free" below the lowest threshold. */
export function rankForSeeds(anthersSeeds: number): BadgeKey {
	return (badgeFor(anthersSeeds).badge?.name as Badge) ?? "free";
}

/** Whole Seeds required for a Badge — its threshold, NOT its position. */
export function badgeRank(badge: BadgeKey): number {
	return badge === "free" ? 0 : (thresholdOf(badge) ?? 0);
}

/** Does a currently-held Badge meet a required one? Compares thresholds. */
export function badgeMeets(held: BadgeKey, required: BadgeKey): boolean {
	return badgeRank(held) >= badgeRank(required);
}

/** Does a held Seed count clear the threshold of a named Badge? */
export function seedsMeetRank(anthersSeeds: number, required: BadgeKey): boolean {
	return seedsMeet(anthersSeeds, badgeRank(required));
}

/** Display label for the Badge held at `anthersSeeds`, with the "+" rule applied. */
export function rankLabel(anthersSeeds: number): string {
	return heldBadgeLabel(anthersSeeds);
}

/** Title-case a Badge name for display ("root" → "Root"). */
export function badgeLabel(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Display label for what a holder of `seeds` holds — e.g. "Petal", "Blossom+",
 * "Blorp+". `emptyLabel` is what to show below the lowest Badge (default "Free").
 */
export function heldBadgeLabel(
	seeds: number,
	badges: readonly BadgeDef[] = ANTHERS_BADGES,
	emptyLabel = "Free",
): string {
	const { badge, plus } = badgeFor(seeds, badges);
	if (!badge) return emptyLabel;
	return `${badgeLabel(badge.name)}${plus ? "+" : ""}`;
}

/** Whole Seeds required for a named Badge in a set, or null if the set has no such Badge. */
export function thresholdOf(name: string, badges: readonly BadgeDef[] = ANTHERS_BADGES) {
	return badges.find((b) => b.name === name)?.threshold ?? null;
}

/**
 * Does a held Seed count clear a gate at `threshold` whole Seeds?
 *
 * This is the ONLY comparison access resolution needs, for both directions — an
 * Anthers Gate and a Seed Gate differ solely in which Seed count is passed in. A
 * gate needn't sit on a Badge: with Badges at 2 and 4, a gate at 3 is legal and a
 * 3-Seed holder clears it.
 */
export function seedsMeet(heldSeeds: number, threshold: number): boolean {
	return Math.floor(heldSeeds) >= threshold;
}

/**
 * Whole Seeds represented by a dollar amount of support ($3 = 1 Seed).
 *
 * The one place money becomes Seeds. `seed_allocations.amount` is a payment ledger and
 * stays money; gates count Seeds. Converting here — rather than at each comparison —
 * keeps a dollar figure from ever being compared against a threshold.
 *
 * Floors, because a partial Seed does not clear a gate; since Seeds were made indivisible
 * a partial should not exist outside legacy rows anyway.
 */
export function seedsFromDollars(amount: string | number | null | undefined): number {
	return Math.max(0, Math.floor(Number(amount ?? 0) / SEED_PRICE));
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

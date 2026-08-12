// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * Support-model economics constants (supersedes the V4 "Badge plans" model).
 *
 * One primitive: a **Seed** — a flat **$3/month** — pointed one of two ways:
 *   - at a **creator** (a *directed Seed*): **no platform cut** and no payout
 *     processing — the only deduction is the Seed's pro-rata share of the at-cost
 *     card fee, paid to Stripe (see `paymentsSplit`), so a lone $3 Seed reaches its
 *     creator as $2.61 and batching pays them more; clears that creator's Seed
 *     Gates in $3 increments; or
 *   - at **Anthers** (an *Anthers-Seed*): funds the **Time Pool** ($1.50/Seed, to
 *     creators by watch-time), earns **Anthers' Badges**, and leaves a
 *     **remainder** for Anthers.
 *
 * A **Seed** is what the user gives; a **Badge** is what the recipient returns.
 * Anthers is a recipient like any creator — it simply defines its own Badge set
 * (root/sprout/petal/blossom at 1/2/3/4 Anthers-Seeds).
 *
 * **There is no bandwidth term.** Delivery was metered at cost ($0.01/GiB) against
 * a 15 GiB free floor plus 60 GiB per Seed until 2026-08-12. That whole apparatus
 * was cost-recovery for one vendor's price list — `BANDWIDTH_PER_GIB` was *exactly*
 * DigitalOcean Spaces' egress rate — and Cloudflare R2 charges $0 egress at any
 * volume, so it metered a cost nobody pays. Downloads are unlimited and free,
 * permanently, across unlimited devices. The freed term fell to the **remainder**,
 * which is the residual, so removing it *raised* charitable funding rather than
 * deleting a fee. Don't reintroduce a per-byte charge without a vendor change
 * behind it.
 *
 * The at-cost **Payments** line (card + processing) sits INSIDE the price — it is
 * charged on the whole batched monthly charge and split pro-rata, then paid to the
 * processor and never kept. **Sales tax is the only thing added on top**, because a
 * government-imposed tax is the sole carve-out mandatory-fee disclosure law allows;
 * a card cost gets none, which is why the old "like sales tax" framing was hollow.
 * The claim that survives is **"Anthers takes no cut"** — unconditionally true —
 * not "100% to the creator", which is retired. There is no platform margin and no
 * fixed "Community Share": the remainder is what's left of each Anthers-Seed, read
 * obligations-first, and it absorbs the *Anthers side's* share of the Payments line.
 * It does NOT absorb the creator side's — `supportBreakdown` charges each side its
 * pro-rata share, which is the only coherent answer for a pure-direct user, who has
 * no remainder to absorb anything. (This comment used to claim creator pay was never
 * touched; that contradicted `paymentsSplit` and `economics.test.ts`.)
 *
 * Seed price is locked at $3; Time-Pool-per-Seed is the current tuned value — see
 * Subscription Economics (50.01).
 */

// ── Badges (what a recipient returns for Seeds) ───────────────────────────────
/**
 * A Badge: a name at a whole-Seed threshold. This shape is the whole point — a
 * Badge is identified by the Seeds it takes to hold, never by its position in a
 * list, because an issuer may place Badges at ANY Seed levels. A creator's set of
 * 1/3/5/7 is exactly as valid as Anthers' 1/2/3/4; the only rule is that the
 * granularity floor is one Seed.
 *
 * This replaced an enum whose *index* was compared against a Seed count. That
 * worked only because Anthers' Badges happen to sit at consecutive integers, so
 * index and threshold coincided — an accident, not a design. Under any
 * non-consecutive set it mis-resolved access silently: no error, just wrong
 * answers. Compare thresholds, never positions.
 */
export interface BadgeDef {
	name: string;
	/** Whole Seeds given to the issuer required to hold this Badge. */
	threshold: number;
}

/** Anthers' own Badge set — ordinary Badges; Anthers just defines its own. */
export const ANTHERS_BADGES: readonly BadgeDef[] = [
	{ name: "root", threshold: 1 },
	{ name: "sprout", threshold: 2 },
	{ name: "petal", threshold: 3 },
	{ name: "blossom", threshold: 4 },
] as const;

/** The names in Anthers' set, for the places that still need a closed union. */
export type Badge = "root" | "sprout" | "petal" | "blossom";

// ── Seed dials (Seed price locked; allocation dials tuned-but-tunable) ────────
/** A Seed — a flat $3/month unit of support (creator-directed or an Anthers-Seed). */
export const SEED_PRICE = 3;
/** Time Pool funded per Anthers-Seed ($), distributed to creators by watch-time. */
export const TIME_POOL_PER_SEED = 1.5;
/** The Free rank's small subsidised Time Pool ($) — the user pays $0. */
export const FREE_TIME_POOL = 0.05;

/**
 * How long raw, per-person attention rows are kept before being rolled up into
 * identity-free daily totals and deleted (`jobs/prune-attention.ts`).
 *
 * 51.05 states the *rule* — kept "only until the billing cycle they belong to has
 * settled and the card-dispute window for that cycle has closed" — and this is the
 * number that rule works out to, derived rather than picked:
 *
 * - up to **31 days** for the cycle the event falls in to end;
 * - **120 days** for the Visa dispute window, which is the longest of the card
 *   networks' ordinary windows and runs from the transaction;
 * - **~29 days** of margin, so a dispute filed on the last permitted day still has
 *   its evidence while the response deadline runs.
 *
 * ⚠️ **This figure has not been reviewed by counsel.** It is a defensible derivation,
 * not advice, and it is a single named constant precisely so that a lawyer's number
 * replaces it in one place. Shortening it below the dispute window would destroy the
 * evidence a chargeback defence rests on; lengthening it weakens the promise in 51.05
 * without any stated reason, which is the failure the policy calls hoarding.
 */
export const ATTENTION_RAW_RETENTION_DAYS = 180;

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
 * The display states a `Record<BadgeKey, …>` has to cover: Free, then each Anthers
 * Badge in ascending threshold order.
 *
 * This is a **display** list, not a ladder to index into. A Badge is identified by its
 * threshold, never by its position here — the two coincide for Anthers' own set (1/2/3/4)
 * and that coincidence is what made the retired `badgeRank = BADGE_ORDER.indexOf(name)`
 * look correct while silently mis-resolving any set with gaps. Never reintroduce an
 * `indexOf` against this; use `thresholdForBadge` or `seedsMeet`.
 */
export const BADGE_ORDER: readonly BadgeKey[] = [
	"free",
	...ANTHERS_BADGES.map((b) => b.name as Badge),
] as const;

/**
 * Whole Seeds required for a named Badge — its **threshold**, and 0 for "free", which
 * is the absence of a Badge rather than a Badge sitting at zero.
 */
export function thresholdForBadge(badge: BadgeKey): number {
	return badge === "free" ? 0 : (thresholdOf(badge) ?? 0);
}

/**
 * The Badge name held at `anthersSeeds`, or "free" below the lowest threshold.
 *
 * Note this **collapses** a Seed count onto a Badge and so throws away the remainder —
 * a 3-Seed holder in a set with Badges at 2 and 4 answers "the 2-Seed Badge". That is
 * right for *labelling* what someone holds and wrong for *resolving access*, which must
 * compare the Seed count against the gate's own threshold via `seedsMeet`. Rounding down
 * to a Badge first is how a viewer gets denied a gate they actually clear.
 */
export function heldBadgeName(anthersSeeds: number): BadgeKey {
	return (badgeFor(anthersSeeds).badge?.name as Badge) ?? "free";
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

// ── Storage charge rate (creator storage only) ───────────────────────────────
/**
 * Half again on a creator's storage cost above the free allowance. This is a
 * creator's own opt-in infrastructure cost, **not a share of anyone's sale**.
 * The branded name ("Anthers Foundation Fee" / "AF Fee" / "AFF") was retired
 * 2026-08-08 — copy names who pays for what, not a fee. The identifier stays.
 *
 * The purchase fees this constant also used to drive — 50% of a download's
 * delivery on a digital sale, and 1% of price on a physical one — were
 * **removed 2026-08-03**. They raised a fraction of a cent per sale, and a
 * commission on a creator's sale is the exact feature the IRS keyed on in Rev.
 * Rul. 76-152 and Final Adverse Determination 202521022. Anthers now takes $0
 * from every creator transaction. Do not reinstate them as a funding fix.
 */
export const AFF_INFRA_RATE = 0.5;

/**
 * Coarse accounting split of charitable dollars into Admin / Programs /
 * Subsidy (free-access pool). The support model reads the charitable budget
 * **obligations-first** (overhead + free access off the top, programs residual,
 * Admin held ≤ 30%); this fixed split is a reporting convenience, not a
 * per-transaction rule. Sums to 1.
 */
export const FOUNDATION_SPLIT = { admin: 0.1, programs: 0.4, subsidy: 0.5 } as const;

// ── Storage & self-hosting (creator side) ────────────────────────────────────
/**
 * Object storage, $/GiB/month — a pass-through of the vendor's rate, so it moves
 * when the vendor does. **Cloudflare R2 since 2026-08-12**: $0.015/GB-month, which
 * is $0.0161/GiB-month. It was $0.02, DigitalOcean Spaces' rate.
 *
 * This is the second dial R2 moved, and the one nothing else was watching. It cuts
 * the creator-facing storage charge by ~20% — and that charge is one of the two
 * charitable revenue streams, so it reduces the mission's income at the same moment
 * retiring the bandwidth term raises it. The two must be modelled together or the
 * net effect reads wrong in both directions.
 *
 * Note R2's Infrequent Access tier charges $0.01/GB to retrieve, so a cold-storage
 * class is not a free saving and shouldn't be assumed into this number.
 */
export const STORAGE_PER_GIB_MONTH = 0.0161;
/** Free creator storage allowance (GiB), subsidised. */
export const FREE_STORAGE_GIB = 50;
/**
 * What a self-hosting creator pays Anthers for infrastructure: **nothing**.
 *
 * It was a flat $1/month standing in for the storage charge, and it was upside-down
 * — a hosted creator's first 50 GiB is free, so break-even sat at a catalogue of
 * ~91 GiB at R2 rates and every creator below that line paid *more* for storing
 * their own files than for Anthers storing them. The discount was a penalty for
 * exactly the hobbyist most likely to try self-hosting, and R2 widened the gap.
 *
 * $0 is the only value consistent with the standing principle that **Anthers
 * charging less because it provides less is the model working**: a self-hosting
 * creator stores and serves nothing here, so there is nothing to pass through.
 *
 * ⚠️ `POST /api/subscriptions/self-hosting` still sets the flag on the creator's
 * own assertion and verifies no origin, so this is now a bigger unearned discount
 * than it was. The fix is origin registration, not a price — see 42.07 § *The one
 * thing that is currently untrue*.
 */
export const SELF_HOST_FEE = 0;

// ── Payments (INSIDE the charge since 2026-08-03; it leaves the system) ───────
/** Card processing: 2.9% + $0.30, charged once on the whole batched charge. */
export const CARD_RATE = 0.029;
export const CARD_FLAT = 0.3;
/** US average combined state+local sales tax, illustrative. */
export const SALES_TAX_RATE = 0.065;

/**
 * The card fee, in floats, for **display only** — marketing pages and calculators.
 *
 * `cardFee()` in `fees.ts` is the money version and the source of truth, but it is
 * built on decimal.js and **nothing in the browser bundle may import `fees.ts`** —
 * that is the one import that would pull decimal.js into the SPA. So the display
 * side needs its own arithmetic, and the hazard is obvious: a second formula that
 * can quietly disagree with the first.
 *
 * This exists so there is exactly **one** such formula rather than the five
 * hand-rolled `price * CARD_RATE + CARD_FLAT` copies that had accumulated across the
 * pages by 2026-08. `cardFeeDisplay` is pinned equal to `cardFee` to the cent across
 * the whole plausible range by `economics.test.ts`; if that test ever fails, the two
 * have drifted and the money one wins.
 *
 * Never use this to compute what anyone is actually paid.
 */
export function cardFeeDisplay(amount: number): number {
	if (!(amount > 0)) return 0;
	return Math.round((amount * CARD_RATE + CARD_FLAT) * 100) / 100;
}

// ── Refunds ──────────────────────────────────────────────────────────────────
/**
 * How many refunds **after download** are issued automatically, per buyer, in a
 * rolling window. Beyond it a human looks; nothing is refused outright.
 *
 * The cap exists because the bytes cannot be un-sent and Stripe does not return
 * its processing fee on a refund — so a buy → download → refund cycle costs real
 * money every time. Whose money matters, and it is the reason the Terms give
 * openly rather than hiding behind "to prevent abuse": Anthers keeps nothing from
 * a sale, so a refund comes out of the **remainder** — the same pool that funds
 * the free bandwidth floor and free access. Refund abuse is paid for by free
 * access. Don't soften that wording (51.06 § Refunds).
 *
 * A refund **before** any download is uncapped and unconditional: nothing was
 * delivered, so the only loss is the sunk card fee.
 *
 * Three-per-twelve-months is shape rather than data — generous enough that no
 * honest buyer meets it. Note a per-account cap is defeated by a new account; the
 * durable identifier would be the payment instrument, which is deliberately not
 * built yet (51.06 notes).
 */
export const REFUND_AUTO_CAP = 3;
/** The rolling window the cap is counted over, in months. */
export const REFUND_CAP_WINDOW_MONTHS = 12;
/**
 * How long a **withdrawn** Work stays downloadable for the people who bought it,
 * counted in days from the withdrawal — uniform for every buyer, not from each
 * buyer's last download (which would make the storage obligation unbounded, and is
 * backwards protectively: the inactive buyer who most needs time would get the
 * shortest window).
 *
 * Three surfaces state this number and must state the same one: 51.06, 51.07, and
 * the Library card. Import it; never retype the 90.
 */
export const WITHDRAWN_RESCUE_DAYS = 90;

// ── Payouts ──────────────────────────────────────────────────────────────────
/**
 * Minimum accrued creator balance before a Connect payout fires ($). Higher →
 * fewer payout events → cheaper, but the smallest creators wait longer. Launch
 * value; ratchet down as the creator ratio matures, and → 0 once direct-ACH lands.
 */
export const PAYOUT_THRESHOLD = 20;

// ── Delivery assumption (AV1 1080p60) ────────────────────────────────────────
/**
 * Delivered GiB per stream-hour — a *size* assumption, used to describe how much
 * data a watch-hour moves. It stopped converting to money on 2026-08-12 when the
 * per-GiB charge was retired; egress is $0 at any volume on R2. Keep it for
 * capacity talk, never for billing.
 */
export const DELIVERY_GIB_PER_HOUR = 1.7;

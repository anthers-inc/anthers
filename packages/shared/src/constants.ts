// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";

/**
 * Support-model economics constants.
 *
 * A user gives a **monthly amount**, in dollars, pointed one of two ways:
 *   - at a **creator**: **no platform cut** and no payout processing — the only
 *     deduction is that amount's pro-rata share of the at-cost card fee, paid to
 *     Stripe (see `paymentsSplit`), so a lone $3 reaches its creator as $2.61 and
 *     batching pays them more; it clears that creator's **Badge** levels; or
 *   - at **Anthers**: buys unlimited **Public Access** at $3, funds the **Time Pool**
 *     (half of what you give, to creators by time), earns **Anthers' Badges**, and
 *     leaves a **remainder** for Anthers.
 *
 * A **Badge** is what the recipient returns for a level of monthly support. Anthers is a
 * recipient like any creator — it simply defines its own set (root/sprout/petal/blossom
 * at $3/$6/$9/$12).
 *
 * 🚨 **There is no unit and no granularity floor.** Amounts are dollars, creators set
 * their own Badge levels to anything, and $3 is the price of unlimited Public Access
 * rather than a denomination anything else is a multiple of. **Do not reintroduce a
 * granularity floor**: if the fixed $0.30 ever argues for a floor it argues for a minimum
 * *invoice total*, never a minimum per-creator amount, and that is a different mechanism
 * in a different place.
 *
 * ⚠️ **`STRIPE_MIN_CHARGE` is not that floor and does not contradict this**, which is worth
 * reading before the two look like a reversal. The rule above kills a floor justified by
 * **card-fee proportionality**, and that justification is dead. Stripe's $0.50 is a
 * different constraint: not *this charge is uneconomic* but *this charge cannot exist*.
 * Both are true at once, and a creator-set amount is therefore free at every level except
 * the unpayable gap between zero and Stripe's own minimum.
 *
 * 🚨 **There is no delivery term, and don't reintroduce a per-byte charge without a
 * vendor change behind it.** Cloudflare R2 charges $0 egress at any volume, so metering
 * delivery would be charging for a cost nobody pays — the apparatus that did was
 * cost-recovery for a price list Anthers no longer buys from. Downloads are unlimited and
 * free, permanently, across unlimited devices, and that value sits in the **remainder**,
 * which is the residual.
 *
 * The at-cost **Payments** line (card + processing) sits INSIDE the price — it is
 * charged on the whole batched monthly charge and split pro-rata, then paid to the
 * processor and never kept. **Sales tax is the only thing added on top**, because a
 * government-imposed tax is the sole carve-out mandatory-fee disclosure law allows;
 * a card cost gets none, which is why the old "like sales tax" framing was hollow.
 * The claim that survives is **"Anthers takes no cut"** — unconditionally true —
 * not "100% to the creator", which is retired. There is no platform margin and no
 * fixed "Community Share": the remainder is what's left of what a user gives Anthers,
 * read obligations-first, and it absorbs the *Anthers side's* share of the Payments line.
 * It does NOT absorb the creator side's — `supportBreakdown` charges each side its
 * pro-rata share, which is the only coherent answer for a pure-direct user, who has
 * no remainder to absorb anything.
 *
 * Unlimited Public Access is $3/month; the Time Pool rate is the current tuned
 * value — see Subscription Economics (50.01).
 */
// ── Badges (what a recipient returns for monthly support) ─────────────────────
/**
 * A Badge: a name at a **dollar** threshold. This shape is the whole point — a Badge is
 * identified by what it takes to hold, never by its position in a list, because an issuer
 * may place Badges at ANY level. A creator's set of $2/$7/$15 is exactly as valid as
 * Anthers' $3/$6/$9/$12, and there is **no granularity floor at all**.
 *
 * 🚨 **Dollars at any level, and the absence of a shared denomination is the point.**
 * Creators set their own Badge levels exactly as they set a direct-purchase list price,
 * and Anthers' $3 is the price of unlimited Public Access rather than a unit. The
 * card-economics argument for a shared step died when one subscription came to carry
 * everything a user gives: the fixed $0.30 is paid **once a month regardless of
 * denomination**, which argues for a minimum *invoice total* and never a minimum
 * per-creator amount. Against that, a $3 step was the coarsest tier granularity in
 * the market at exactly the point where tiers live — a 100% jump from the first rung to the
 * second, and no way to say $5, $10 or $25.
 *
 * This shape also replaced an enum whose *index* was compared against a held count. That
 * worked only because Anthers' Badges happened to sit at consecutive integers, so index and
 * threshold coincided — an accident, not a design. Under any non-consecutive set it
 * mis-resolved access silently: no error, just wrong answers. **Compare thresholds, never
 * positions** — and note the unit change makes non-consecutive sets the ordinary case
 * rather than the exotic one.
 */
export interface BadgeDef {
	name: string;
	/** Monthly dollars given to the issuer required to hold this Badge. */
	threshold: number;
}

/**
 * Anthers' own Badge set — ordinary Badges; Anthers just defines its own.
 *
 * $3 buys unlimited Public Access and nothing above it buys more access. What the higher
 * rungs cost and what they carry are each due their own discussion; these amounts are
 * inherited rather than argued for.
 */
export const ANTHERS_BADGES: readonly BadgeDef[] = [
	{ name: "root", threshold: 3 },
	{ name: "sprout", threshold: 6 },
	{ name: "petal", threshold: 9 },
	{ name: "blossom", threshold: 12 },
] as const;

/** The names in Anthers' set, for the places that still need a closed union. */
export type Badge = "root" | "sprout" | "petal" | "blossom";

// ── Support dials (the Public Access price is locked; the rest are tuned) ─────
/**
 * What unlimited Public Access costs, per month.
 *
 * It is **just $3** — not "a Seed", not a unit anything else is denominated in. Whether $3
 * is the right number is its own later conversation; what retired on 2026-08-16 is the
 * claim that it was a *unit*, which is what forced every creator's Badge levels onto
 * multiples of it.
 */
export const PUBLIC_ACCESS_PRICE = 3;

/**
 * The smallest amount Stripe will process, in USD.
 *
 * 🚨 **Not a granularity floor, and the distinction is the whole reason this is a separate
 * constant.** The floor this file's header forbids is one justified by **card-fee
 * proportionality** — "a $1 charge loses a third to processing" — and that argument died
 * when one subscription came to carry everything a user gives, because the fixed $0.30 is
 * then paid once a month whatever the denomination. It argues for a minimum *invoice total*
 * and never for a minimum per-creator amount, and that rule still stands.
 *
 * This is a different constraint with a different justification. It does not say *this
 * charge is uneconomic*; it says **this charge cannot exist**. Stripe refuses it, so a price
 * below it is not a cheap price but an unbuyable one — and a creator finds that out through
 * a buyer failing at checkout rather than through their own editor.
 *
 * ⚠️ **Named for the vendor because that is whose rule it is.** It is not ours to choose, it
 * is USD-specific, and if Anthers ever charges in another currency this constant is the
 * thing that has to grow a dimension rather than the call sites.
 */
export const STRIPE_MIN_CHARGE = 0.5;

/**
 * Can a creator-set amount actually be charged?
 *
 * 🚨 **The rule is "$0 or at least $0.50, and nothing in between" — never a flat minimum.**
 * $0 with Allow checked is exactly what Public Access is, so `Math.max(0.5, price)` would
 * put a price on every free Work on the platform. That is the way to get this wrong that
 * looks most correct, which is why the rule lives in one predicate rather than at each of
 * the five validators that need it.
 *
 * Compared in **cents**, because the inputs arrive as money strings and as numbers parsed
 * from them, and `0.5` is not exactly representable — a floor that rejected `0.5` itself on
 * some paths and not others would be worse than no floor at all.
 */
export function isChargeableAmount(dollars: number): boolean {
	if (!Number.isFinite(dollars) || dollars < 0) return false;
	const cents = Math.round(dollars * 100);
	return cents === 0 || cents >= Math.round(STRIPE_MIN_CHARGE * 100);
}

/** What to tell somebody who set an amount between zero and the floor. */
export const CHARGEABLE_AMOUNT_MESSAGE = `An amount has to be $0 or at least $${STRIPE_MIN_CHARGE.toFixed(2)} — Stripe will not process a charge below that, so anything in between is a price nobody can pay.`;
/**
 * Share of what a user gives Anthers that funds the Time Pool, paid to creators by time.
 *
 * 🚨 **A RATE, since 2026-08-16 — it was `TIME_POOL_PER_SEED = 1.5`, a per-unit
 * coefficient, and a per-unit coefficient cannot survive the unit going away.** The rate
 * reproduces the old model exactly at every Anthers Badge level ($3 → $1.50, $6 → $3.00,
 * $9 → $4.50, $12 → $6.00) because $1.50 was always exactly half of $3 — so nothing about
 * creator pay moved in this change, which is the point. What it gains is an answer for the
 * amounts between and beyond those rungs, which the coefficient had no way to express.
 */
export const TIME_POOL_RATE = 0.5;
/**
 * The Time Pool Anthers funds on a **free account's** behalf each month, so that a free
 * viewer's watching still pays the creators they watch. The user pays $0.
 *
 * **$0.25 is the number, and the review it was waiting for is closed** (Parker, 2026-08-31).
 * It was flagged PROVISIONAL from 2026-08-12 pending "real modeling and real conversion
 * data" — the modeling arrived and moved nothing, and the data cannot arrive before there
 * are accounts. So it stands on its own reasoning rather than on a pending analysis: move it
 * if it feels wrong once people are using the platform, not because a spreadsheet asked.
 *
 * ⚠️ **The stakes fell with the bandwidth bill.** While delivery was metered, free access
 * cost bandwidth *plus* this pot; it is now this pot alone, on a per-account cost far below
 * what the dial used to govern. Sensitivity — what each setting costs, as the floor paying
 * share below which growth never closes the gap — is generated into the growth ladder's
 * `free-pot` block; read it there before moving this.
 *
 * **Why it is deliberately low rather than deliberately right.** The Public Access revamp
 * proposed **$0.50**, and the docs were written against that figure before the code moved.
 * Parker's call was to split the difference and start at $0.25, on an asymmetry rather than
 * a forecast: **raising this later is easy and climbing down from it is not.** It is a
 * standing obligation to every free account, so an over-generous opening number becomes a
 * public commitment the charitable budget has to keep funding while the paying share
 * catches up — and the growth ladder is violently non-linear near its floor. Under-shooting
 * costs creators some free-viewer earnings and can be corrected upward at any time.
 *
 * It is also the single dial that sets **free-access cost per account**, since delivery
 * became free: cost is now `free accounts × this number`, headcount times a policy figure,
 * with no behavioral guess underneath it. That is what decoupled the free tier's
 * *generosity* from the platform's *solvency* — the watch-hour limit can move without
 * moving this, and vice versa.
 */
export const FREE_TIME_POOL = 0.25;

/**
 * How long raw, per-person attention rows are kept before being rolled up into
 * identity-free daily totals and deleted (`jobs/prune-attention.ts`).
 *
 * Privacy Policy states the *rule* — kept "only until the billing cycle they belong to has
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
 * evidence a chargeback defense rests on; lengthening it weakens the promise in the Privacy Policy
 * without any stated reason, which is the failure the policy calls hoarding.
 */
export const ATTENTION_RAW_RETENTION_DAYS = 180;

// ── Badge helpers ────────────────────────────────────────────────────────────
/**
 * The Badge a holder of `amount` currently holds in `badges`, and whether it renders
 * with a "+".
 *
 * The rule, uniformly: your Badge is the **highest-threshold Badge whose threshold
 * you meet**; giving *strictly more* than that threshold adds a "+". The "+"
 * applies BETWEEN Badges, not only past the top of the set — with Badges at 2 and 4,
 * someone giving $3 holds the $2 Badge with a "+". It honors someone who chose
 * to give a little extra; whether it *carries* anything is the issuer's choice.
 *
 * Returns `badge: null` below the lowest threshold (no Badge held).
 */
export function badgeFor(
	amount: number,
	badges: readonly BadgeDef[] = ANTHERS_BADGES,
): { badge: BadgeDef | null; plus: boolean } {
	// In cents, for the reason `cents` gives: a supporter giving exactly a Badge's amount
	// must hold it, and a float `>=` on two parsed `numeric` columns is one representation
	// away from saying otherwise.
	const held = cents(amount);
	let best: BadgeDef | null = null;
	for (const b of badges) {
		if (cents(b.threshold) <= held && (best === null || b.threshold > best.threshold)) best = b;
	}
	return { badge: best, plus: best !== null && held > cents(best.threshold) };
}

/**
 * A display key covering "no Badge held" alongside the real ones.
 *
 * Giving nothing is the *absence* of a Badge, not a Badge named "free" — but the UI still
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
 * `indexOf` against this; use `thresholdForBadge` or `amountMeets`.
 */
export const BADGE_ORDER: readonly BadgeKey[] = [
	"free",
	...ANTHERS_BADGES.map((b) => b.name as Badge),
] as const;

/**
 * Monthly dollars required for a named Badge — its **threshold**, and 0 for "free", which
 * is the absence of a Badge rather than a Badge sitting at zero.
 */
export function thresholdForBadge(badge: BadgeKey): number {
	return badge === "free" ? 0 : (thresholdOf(badge) ?? 0);
}

/**
 * The Badge name held at `anthersDollars`, or "free" below the lowest threshold.
 *
 * Note this **collapses** an amount onto a Badge and so throws away the remainder —
 * someone giving $3 to a set with Badges at $2 and $4 answers "the $2 Badge". That is
 * right for *labeling* what someone holds and wrong for *resolving access*, which must
 * compare the amount against the gate's own threshold via `amountMeets`. Rounding down
 * to a Badge first is how a viewer gets denied a gate they actually clear.
 */
export function heldBadgeName(anthersDollars: number): BadgeKey {
	return (badgeFor(anthersDollars).badge?.name as Badge) ?? "free";
}

/** Title-case a Badge name for display ("root" → "Root"). */
export function badgeLabel(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Display label for what a holder of `amount` holds — e.g. "Petal", "Blossom+",
 * "Blorp+". `emptyLabel` is what to show below the lowest Badge (default "Free").
 */
export function heldBadgeLabel(
	amount: number,
	badges: readonly BadgeDef[] = ANTHERS_BADGES,
	emptyLabel = "Free",
): string {
	const { badge, plus } = badgeFor(amount, badges);
	if (!badge) return emptyLabel;
	return `${badgeLabel(badge.name)}${plus ? "+" : ""}`;
}

/** Monthly dollars required for a named Badge in a set, or null if the set has no such Badge. */
export function thresholdOf(name: string, badges: readonly BadgeDef[] = ANTHERS_BADGES) {
	return badges.find((b) => b.name === name)?.threshold ?? null;
}

/**
 * Does a monthly amount clear a gate at `threshold` dollars?
 *
 * This is the ONLY comparison access resolution needs, for both directions — an
 * Anthers' Badges and a creator's differ solely in which amount is passed in. A gate
 * needn't sit on a Badge: with Badges at $2 and $4, a gate at $3 is legal and someone
 * giving $3 clears it.
 *
 * 🚨 **It compares in whole cents and ROUNDS rather than floors, and flooring here is a
 * real defect that looks like caution.** Thresholds were integers once and could not go
 * wrong; dollars are floats read off `numeric` columns. Flooring breaks precisely where
 * the two sides are reached differently — an amount arrived at by *adding* allocations,
 * against a threshold stored as a literal. `$1.00 + $1.14` is `2.1399999999999997`, which
 * floors to 213c against $2.14's 214c and refuses a supporter who paid exactly the asking
 * amount. Do not "tighten" this to a floor.
 */
export function amountMeets(held: number, threshold: number): boolean {
	return cents(held) >= cents(threshold);
}

/**
 * A dollar amount as whole cents — the unit every support comparison is made in.
 *
 * 🚨 **Load-bearing, and the reason it exists at all.** Thresholds are dollars, so they
 * are floats, and `0.1 + 0.2 !== 0.3` is the oldest bug there is: a supporter who gives
 * exactly what a Badge asks must clear it, and a naive `>=` on the parsed doubles is one
 * representation away from denying them with no error anywhere.
 *
 * ⚠️ **ROUND, never floor — and the reason is subtler than it first looks.** Flooring is
 * the obvious way to stop a sub-cent amount opening a gate, and against a *symmetric*
 * comparison it is harmless: both sides floor identically, so equality survives. It breaks
 * where the two sides are reached **differently** — a held amount arrived at by ADDING two
 * allocations against a threshold stored as one literal. `$1.00 + $1.14` is
 * `2.1399999999999997`, which floors to 213 cents against a `$2.14` threshold's 214, and
 * the supporter is denied a Badge they paid for exactly. There are **2,180 such pairs
 * under $2 alone**; rounding has none.
 *
 * Cents is the grain because it is what Stripe charges in — finer cannot be paid.
 *
 * Deliberately NOT decimal.js: this is a comparison, not arithmetic on money that moves,
 * and `constants.ts` is imported by the browser — pulling decimal.js in here is the one
 * import that would put it in the SPA bundle.
 */
export function cents(amount: string | number | null | undefined): number {
	return Math.round(Math.max(0, Number(amount ?? 0)) * 100);
}

/** A dollar amount of monthly support, normalized — negatives floor at 0, extra precision drops. */
export function supportAmount(amount: string | number | null | undefined): number {
	return cents(amount) / 100;
}

/**
 * An amount for display: `$3`, `$9.50`, `$12.99`. Whole dollars lose the `.00`.
 *
 * 🚨 **The cents half is the whole reason this exists.** Interpolating the number
 * directly renders a `9.5` rung as **"$9.5"**, which reads as a typo and, beside a
 * correctly formatted copy of itself, as a bug. It shipped in two places at once the first
 * time a rung carried cents, because every call site had quietly assumed integers.
 *
 * Five copies of this expression existed by then, none shared. This is the one.
 */
export function amountLabel(amount: string | number | null | undefined): string {
	const n = supportAmount(amount);
	return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

// ── Derived amounts ──────────────────────────────────────────────────────────
/**
 * Time Pool $ funded by giving Anthers `dollars` a month (giving nothing = the
 * subsidized `FREE_TIME_POOL`, which the user does not pay for).
 */
export function timePoolFor(anthersDollars: number): number {
	return anthersDollars <= 0 ? FREE_TIME_POOL : supportAmount(anthersDollars) * TIME_POOL_RATE;
}

/**
 * Share of a Badge's Time Pool held back to be given as Stickers.
 *
 * 🚨 **A dial, not a fact.** A third was chosen because it makes the Root budget reach two
 * $0.25 Stickers rather than one — the difference between a feature a person uses and one
 * they spend. Nothing depends on the specific value. The design lives with the work now —
 * see the Stickers task on the vault board.
 */
export const STICKER_SHARE_OF_POOL = 1 / 3;

/**
 * A Badge's monthly Sticker budget, in dollars.
 *
 * ⚠️ **Carved OUT of the Time Pool rather than added beside it**, which is what makes
 * Stickers cost Anthers nothing and take nothing from creators in aggregate: the money was
 * already on its way to creators, and unspent budget rolls back into the pool at the end of
 * the cycle. So a rung's Time Pool figure and its Sticker figure overlap by design — the
 * second is part of the first — and any surface showing both has to say so.
 *
 * A free account has none: a third of the subsidized pot buys no Sticker at any
 * denomination, so the arithmetic settles this before policy has to.
 *
 * 🚨 **Stickers are DESIGNED, NOT BUILT.** There is no like primitive to attach one to.
 * This exists so the figure a marketing page quotes is derived rather than typed; it is not
 * evidence the feature ships. The public wiki's *Using Anthers → Supporting Creators →
 * Badges* marks it unbuilt in the table itself; do not write copy that implies otherwise.
 */
export function stickerBudgetFor(anthersDollars: number): number {
	return anthersDollars <= 0 ? 0 : timePoolFor(anthersDollars) * STICKER_SHARE_OF_POOL;
}

/**
 * A Badge's cloud storage floor, in GiB.
 *
 * Free gets `FREE_STORAGE_GIB` and it holds a **creator's catalog only**, so an account
 * that has never published has no storage at all. From the first rung the same floor
 * becomes spendable on the account's own kept files too, and each further rung adds
 * another `FREE_STORAGE_GIB`.
 *
 * 🚨 **Counted by rungs CLEARED, never by position in a list.** `BADGE_ORDER`'s own note
 * records why: a Badge is identified by its threshold, and the retired
 * `indexOf(BADGE_ORDER)` looked correct for as long as Anthers' set happened to be evenly
 * spaced. `amountMeets` is the only comparison that survives a ladder with gaps.
 *
 * 🚨 **The per-rung scaling is DESIGNED, NOT BUILT** — `estimateStorageCost` bills every
 * creator against `FREE_STORAGE_GIB` flat, and there is no user-side storage at all. 50 GiB
 * a rung is what the rung budget affords rather than a settled increment; the storage-ladder
 * task on the vault board carries that question.
 */
export function storageGibFor(anthersDollars: number): number {
	const rungs = ANTHERS_BADGES.filter((b) => amountMeets(anthersDollars, b.threshold)).length;
	return rungs === 0 ? FREE_STORAGE_GIB : FREE_STORAGE_GIB * rungs;
}

/**
 * How much more a creator earns from an hour of your attention once you give Anthers
 * `dollars` a month, against giving nothing.
 *
 * 🚨 **This is the free-limit prompt's headline number and it must never be typed into
 * copy.** the public wiki's *Badges* reads *"every creator you spend time with is also paid six times
 * more for your attention"* — and that six is not a fact about the world, it is
 * `1.50 / 0.25`, a ratio between two dials. **`FREE_TIME_POOL` is explicitly provisional
 * and expected to move** (see its own note), so a typed "six" becomes a lie on the day
 * someone tunes it, silently, in the one piece of copy the platform's entire conversion
 * argument rests on. Same reasoning as the generated econ figures: a published number
 * with a formula behind it is generated, never transcribed.
 *
 * ⚠️ **A FUNCTION rather than a constant, and the reason matters for copy.** The multiple
 * depends on what *this* user gives, so a page that says "six times" is asserting something
 * about a specific amount and has to say which. At the $3 Public Access price it is 6.
 *
 * Not in `figures.generated.ts` because that file is money *tables* built by a script;
 * this is a one-line derivation and belongs beside the dials it divides.
 */
export function timePoolMultipleFor(anthersDollars: number = PUBLIC_ACCESS_PRICE): number {
	return timePoolFor(anthersDollars) / FREE_TIME_POOL;
}

/**
 * Render a multiple for copy — `6×`, or `3.8×` when the dials stop dividing evenly.
 *
 * The current dials give a whole 6, which makes it tempting to assume one. They are not
 * required to: moving `FREE_TIME_POOL` to $0.40 gives 3.75. Rounding that to "4×" would
 * overstate what supporting buys, and printing `3.75×` reads like a spreadsheet, so it goes
 * to one decimal and keeps the trailing digit only when there is one.
 */
export function formatMultiple(n: number): string {
	return `${Number.isInteger(n) ? n : n.toFixed(1)}×`;
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
 * retiring the bandwidth term raises it. The two must be modeled together or the
 * net effect reads wrong in both directions.
 *
 * Note R2's Infrequent Access tier charges $0.01/GB to retrieve, so a cold-storage
 * class is not a free saving and shouldn't be assumed into this number.
 */
export const STORAGE_PER_GIB_MONTH = 0.0161;
/** Free creator storage allowance (GiB), subsidized. */
export const FREE_STORAGE_GIB = 50;
/**
 * What a self-hosting creator pays Anthers for infrastructure: **nothing**.
 *
 * It was a flat $1/month standing in for the storage charge, and it was upside-down
 * — a hosted creator's first 50 GiB is free, so break-even sat at a catalog of
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
 * access. Don't soften that wording (Terms of Service § Refunds).
 *
 * A refund **before** any download is uncapped and unconditional: nothing was
 * delivered, so the only loss is the sunk card fee.
 *
 * Three-per-twelve-months is shape rather than data — generous enough that no
 * honest buyer meets it. Note a per-account cap is defeated by a new account; the
 * durable identifier would be the payment instrument, which is deliberately not
 * built yet (Terms of Service notes).
 */
export const REFUND_AUTO_CAP = 3;

/**
 * How many Works one basket may hold.
 *
 * A bound rather than a product limit: a basket is resolved item-by-item through the
 * same access path a single purchase takes, so an unbounded list is an unbounded number
 * of queries on an unauthenticated-cost path. Twenty is far above any real basket — an
 * album's worth of tracks is a dozen — and far below anything that hurts.
 *
 * 🚨 **One creator per basket**, which is not a number and so is not here: Stripe's
 * `transfer_data.destination` names a single connected account, so a basket spanning two
 * creators cannot be one destination charge. See `resolveBasket` in `routes/payments.ts`.
 */
export const MAX_BASKET_ITEMS = 20;
/** The rolling window the cap is counted over, in months. */
export const REFUND_CAP_WINDOW_MONTHS = 12;
/**
 * How long a **withdrawn** Work stays downloadable for the people who bought it,
 * counted in days from the withdrawal — uniform for every buyer, not from each
 * buyer's last download (which would make the storage obligation unbounded, and is
 * backwards protectively: the inactive buyer who most needs time would get the
 * shortest window).
 *
 * Three surfaces state this number and must state the same one: Terms of Service, Creator Terms, and
 * the Library card. Import it; never retype the 90.
 */
export const WITHDRAWN_RESCUE_DAYS = 90;

/**
 * The square every badge interior is normalized to, in pixels.
 *
 * ⭐ **Normalizing is what makes one shared frame possible.** Every badge — Anthers' own
 * and every creator's — sits in the same round botanical frame, and a frame cannot fit art
 * whose aspect ratio is whatever somebody's phone produced. It also drops EXIF and any
 * trailing payload, and makes the bytes that are scanned exactly the bytes that are served.
 *
 * 512 because a badge is rendered small everywhere it appears and is worth having at twice
 * that on a dense display; larger buys nothing a viewer can see and costs a creator's
 * storage allowance on every rung.
 */
export const BADGE_ART_PX = 512;

/** The largest file a creator may upload for one rung, before normalization. */
export const BADGE_ART_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long a safety or copyright record keeps its **personal detail**, in years,
 * counted from the last thing that happened to it. Settled 2026-08-16.
 *
 * The record itself is never deleted — the row, its reason and its outcome are
 * permanent, and only the contact details and a reporter's own words age out. See
 * `apps/api/src/services/retention.ts` for why redaction rather than deletion is
 * the only shape that satisfies § 512(i) and the right of appeal at once.
 *
 * **Three, because of 17 U.S.C. § 507(b)** — the copyright limitation period,
 * which also bounds a § 512(f) misrepresentation claim in either direction. The
 * detail survives exactly as long as somebody could still sue over it. It is one
 * number rather than one per table on purpose: a retention section with a
 * different figure everywhere is one nobody can follow and nobody notices
 * breaking.
 *
 * Stated in the Privacy Policy and in the app's own copy of it. Import it; never retype the 3.
 */
export const RECORD_REDACTION_YEARS = 3;

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

// ── Child safety ─────────────────────────────────────────────────────────────
/**
 * Where a floor-level report escalates to, and where a notice from NCMEC, another
 * provider or a member of the public arrives.
 *
 * 🚨 **This is a constant rather than an env var on purpose, and the purpose is that
 * it cannot be changed casually.** The address is on Anthers' NCMEC ESP registration,
 * which 18 U.S.C. § 2258A(a) makes a statutory element of the reporting duty — so
 * moving it is a re-notification to NCMEC, not a mail rule, exactly as the DMCA
 * agent's address cannot move without re-filing with the Copyright Office. An env
 * var would invite a deploy to change it silently and leave the federal registration
 * pointing somewhere nobody reads.
 *
 * 🚨 **It is a single-recipient alias and must stay one.** § 2258B conditions the
 * provider's immunity on minimizing the number of employees with access to reported
 * depictions, so who receives this is a compliance decision. Never widen it to a team
 * inbox. See Child Safety Reporting Policy § 5, and Contact Points and Published Addresses for the rest of the NCMEC contact set.
 */
export const ABUSE_EMAIL = "abuse@anthers.org";

/**
 * How long a filed CyberTipline report preserves what it names, in years.
 *
 * **One, because of 18 U.S.C. § 2258A(h) as amended by the REPORT Act (2024)**, which
 * struck "90 days" and inserted "1 year". A completed report *is* the preservation
 * request — there is no separate step, and no way to report without incurring the
 * hold — so this clock starts at filing rather than at any decision of ours.
 *
 * Sits beside `RECORD_REDACTION_YEARS` deliberately: they are the two statutory
 * clocks over the same records, they run in opposite directions, and a reader
 * comparing them should not have to find them in two files.
 */
export const PRESERVATION_HOLD_YEARS = 1;

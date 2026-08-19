// SPDX-License-Identifier: AGPL-3.0-or-later
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	ANTHERS_BADGES,
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
	supportAmount,
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
 * Split the at-cost card fee on a whole batched monthly charge between what a user
 * gives Anthers and what they give creators, pro-rata by dollar value.
 *
 * The fixed $0.30 is per *charge*, not per recipient, so a user supporting creators
 * alongside Anthers amortises it across a bigger charge — which leaves a fatter
 * remainder AND pays their creators more. That effect is the whole reason everything a
 * user gives batches onto one monthly transaction, and since 2026-08-16 it is also the
 * whole of the argument the retired $3 unit used to carry: the fee is paid once a month
 * whatever the denomination, so it can only ever justify a minimum *invoice total*.
 *
 * ⚠️ Both arguments are **dollars** now, not counts. They were whole Seed counts until
 * 2026-08-16, and the old body floored them — which is exactly the coercion that has to
 * go, or a $7.50 gift silently becomes $7.
 */
export function paymentsSplit(
	anthersDollars: number,
	creatorDollars: number,
): { total: Decimal; anthers: Decimal; creator: Decimal } {
	const anthersValue = new Decimal(supportAmount(anthersDollars));
	const creatorValue = new Decimal(supportAmount(creatorDollars));
	const charge = anthersValue.plus(creatorValue);
	const total = cardFee(charge);
	if (charge.lte(0))
		return { total: new Decimal(0), anthers: new Decimal(0), creator: new Decimal(0) };
	// Split by value, then give the rounding remainder to the Anthers side so the
	// two shares always reconstruct `total` exactly and creators are never short a cent.
	const creator = CENTS(total.mul(creatorValue).div(charge));
	return { total, anthers: total.minus(creator), creator };
}

// ── Support decomposition ─────────────────────────────────────────────────────
/**
 * Decompose what a user gives Anthers into where it goes:
 *
 *   what they give = Time Pool + Payments + remainder
 *
 * Time Pool (half of what they give) is a fixed target to creators and never moves; `payments`
 * is this side's share of the at-cost card fee (see `paymentsSplit`); the
 * **remainder is what's left** — the shock absorber, so an expensive charge shrinks
 * the mission share while creator pay stays exactly the same. Free (n = 0) pays $0:
 * its small Time Pool is subsidised, and it funds no charitable remainder.
 *
 * A fourth term, the user's own at-cost bandwidth, sat first in this identity until
 * 2026-08-12. It is gone with the allowance: R2 charges $0 egress, so there was no
 * cost to pass through. Note the freed value went to the **remainder** rather than
 * anywhere else, because the remainder is the residual by construction — which made
 * that retirement an increase in charitable funding, not a deleted fee.
 *
 * ⚠️ It took a whole **Seed count** until 2026-08-16 and takes **dollars** now. The old
 * body floored its argument, which is the coercion that had to go with the unit: an
 * issuer may sit at any amount, so flooring $7.50 to $7 would quietly under-credit both
 * the Time Pool and the remainder.
 *
 * `payments` defaults to 0 so a caller that only wants the Time-Pool view is
 * unaffected — but anything crediting the **charitable ledger** must pass it, or
 * the charitable ledger is over-credited by the card fee.
 */
export function anthersSupportBreakdown(
	anthersDollars: number,
	opts: { payments?: Decimal | number } = {},
): {
	anthersDollars: number;
	given: Decimal;
	timePool: Decimal;
	payments: Decimal;
	foundation: Decimal;
	subsidised: boolean;
} {
	const n = supportAmount(anthersDollars);
	const given = new Decimal(n);
	const timePool = new Decimal(timePoolFor(n));
	const payments = new Decimal(opts.payments ?? 0);
	if (n === 0) {
		return {
			anthersDollars: 0,
			given: new Decimal(0),
			timePool,
			payments: new Decimal(0),
			foundation: new Decimal(0),
			subsidised: true,
		};
	}
	const foundation = given.minus(timePool).minus(payments);
	return {
		anthersDollars: n,
		given,
		timePool,
		payments,
		foundation,
		subsidised: false,
	};
}

/**
 * The full monthly support breakdown for a user giving Anthers `anthersDollars` and
 * creators `creatorDollars` a month.
 *
 * Anthers takes **no cut** — but the at-cost card fee comes out of the charge
 * rather than riding on top of it, so directed support reaches its creator less
 * its pro-rata share. `total` is therefore the support subtotal itself: the
 * price is all-in, and sales tax is the only thing a caller adds on top.
 *
 * `creatorDirect` is the **gross** directed value; `creatorNet` is what
 * actually reaches creators. Use `creatorNet` for anything describing payout.
 */
export function supportBreakdown(params: { anthersDollars: number; creatorDollars: number }): {
	creatorDirect: Decimal;
	creatorNet: Decimal;
	timePool: Decimal;
	foundation: Decimal;
	toCreators: Decimal;
	supportSubtotal: Decimal;
	payments: Decimal;
	total: Decimal;
} {
	const split = paymentsSplit(params.anthersDollars, params.creatorDollars);
	const anthers = anthersSupportBreakdown(params.anthersDollars, { payments: split.anthers });
	const creatorDirect = new Decimal(supportAmount(params.creatorDollars));
	const creatorNet = creatorDirect.minus(split.creator);
	const supportSubtotal = creatorDirect.plus(anthers.given);
	return {
		creatorDirect,
		creatorNet,
		timePool: anthers.timePool,
		foundation: anthers.foundation,
		toCreators: creatorNet.plus(anthers.timePool),
		supportSubtotal,
		payments: split.total,
		total: supportSubtotal,
	};
}

/** A rung of Anthers' Badge ladder as a display view model — money pre-rounded to 2dp. */
export interface BadgeView {
	/** Badge name, or "free" for the $0 rung, which is the absence of a Badge. */
	id: BadgeKey;
	name: string;
	/** Monthly $ to hold this rung (0 = no Badge … 12 = blossom). */
	price: number;
	/** Time Pool $ at this rung (to creators, by time). */
	timePool: string;
	/** "Supports Anthers" — the remainder, funding free access and the programs. */
	supportsAnthers: string;
	subsidised: boolean;
}

/**
 * The rung ladder as view models, low → high (free … blossom). Pure and static —
 * derived from the dials, no per-user data — so the Subscribe page, the
 * `/subscriptions/ranks` route, and inline-unlock all render the same numbers and
 * can't drift. "Supports Anthers" is the remainder — what is left of the charge
 * after the Time Pool, funding free access and the charitable programs.
 */
export function badgeViews(): BadgeView[] {
	// The $0 rung is the absence of a Badge, so it isn't in ANTHERS_BADGES — it's
	// prepended here for display only. Amounts come from each Badge's THRESHOLD,
	// never from its position: this list is ordered by threshold, but nothing reads
	// the index, so a Badge set with gaps renders correctly too.
	const rungs: Array<{ id: BadgeKey; amount: number }> = [
		{ id: "free", amount: 0 },
		...ANTHERS_BADGES.map((b) => ({ id: b.name as Badge, amount: b.threshold })),
	];
	return rungs.map(({ id, amount }) => {
		const price = supportAmount(amount);
		// Delegated to `anthersSupportBreakdown` rather than re-derived. It used to compute
		// `price - timePool` inline, which silently OMITTED the Payments term and so
		// overstated the remainder by exactly the card fee — $1.50 at Root against a true
		// $1.11. Same shape as the five hand-rolled card-fee copies and as `creatorReceipt`
		// re-deriving the storage formula: a duplicated formula agrees with its original
		// right up until a term moves, and here the term had already moved.
		const bd = anthersSupportBreakdown(price, { payments: price === 0 ? 0 : cardFee(price) });
		return {
			id,
			name: badgeLabel(id),
			price,
			timePool: bd.timePool.toFixed(2),
			supportsAnthers: bd.foundation.toFixed(2),
			subsidised: price === 0,
		};
	});
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
 * processing comes **out of** that price and is paid to Stripe. Anthers keeps $0,
 * and now so does delivery: **every download is included, forever, on every
 * device.** There is no first-download-versus-redownload distinction any more.
 *
 * `deliveryFee` and `crfFee` keep their legacy key names and are **always zero** —
 * the purchase fee went 2026-08-03, the delivery charge 2026-08-12. Both columns
 * are `NOT NULL`, so they stay; dropping them is a separate migration.
 */
export function calculateFees(amount: Decimal, opts: { type?: PurchaseType } = {}) {
	// `type` no longer changes the arithmetic — it did while digital sales carried
	// the first download's bandwidth. Kept because callers pass it and `purchases.type`
	// is a real discriminator elsewhere (a Seed buy is not owned content).
	void opts.type;

	// The list price IS the advertised price: card processing comes out of it, not
	// on top of it. Sales tax is the only thing added, because a government-imposed
	// tax is the sole carve-out mandatory-fee disclosure law allows.
	const processingFee = CENTS(amount.mul(CARD_RATE).plus(CARD_FLAT));
	const salesTax = CENTS(amount.mul(SALES_TAX_RATE));
	const creatorEarnings = amount.minus(processingFee);
	const buyerTotal = amount.plus(salesTax);

	return {
		processingFee,
		deliveryFee: new Decimal(0),
		salesTax,
		crfFee: new Decimal(0),
		creatorEarnings,
		buyerTotal,
	};
}

/**
 * A creator's monthly storage cost and the half-again on top of it.
 *
 * Storage beyond the free allowance is billed at the object-store rate, plus half
 * again — the half is what funds free access and the charitable programs. Storage
 * is the **only** creator-side infrastructure charge: delivery costs nothing to
 * anyone. A self-hosting creator stores nothing here and so pays nothing.
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

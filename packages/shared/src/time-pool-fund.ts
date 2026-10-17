// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund's arithmetic: one pool, one slice, computed.
 *
 * The free account's Time Pool stopped being a per-head constant (`FREE_TIME_POOL`,
 * retired into this mechanism with the pool-mechanism task, 2026-10-10) and became
 * **the Fund**: a stated share of the charitable remainder after the admin budget,
 * published monthly, divided across the cycle's active free accounts, each slice
 * flowing through `computeMonth` unchanged.
 *
 * The math lives HERE, in shared, beside `financial-plan.ts`'s ledger — the same
 * reason that file carries the plan's closed form: the runtime service, the growth
 * model and the plan tool must never carry two copies of the pool formula, because a
 * duplicated formula is the two-floors defect class (the card fee's five copies; the
 * self-sufficiency model that disagreed with the ladder).
 *
 * ## The closed form
 *
 * The Fund takes its share of the **remainder after the admin budget**
 * (`planLedger`'s shape — the obligations dial stays remainder-based), and the
 * pool is the pot of that share:
 *
 *   uncapped = freeAccessShare × (1 − adminBudgetShare) × charitableRevenue
 *   pool     = min(uncapped, rootPool × activeFreeAccounts)
 *
 * The second term is the **parity ceiling** — the subsidized slice never funds any
 * account above what the smallest paid pool (a Root supporter's) funds — with the
 * excess routing to the other programs by construction (the uncapped difference is
 * simply never withdrawn from the remainder). The ceiling never binds at any modeled
 * scale today.
 *
 * The **slice** divides the pot across the cycle's active free accounts, floored to
 * the whole cent (ROUND_DOWN, not HALF_UP): the dust — the pot less slice × accounts —
 * stays in the remainder. Credits are per-slice and nothing distributes the dust, so
 * flooring is what keeps the books exact; rounding up would promise money the pot
 * does not hold.
 */
import Decimal from "decimal.js";

export const FUND_STATUS = ["actual", "committed", "estimate"] as const;

export type FundStatus = (typeof FUND_STATUS)[number];

/** Round to cents, DOWN — the slice's own rounding direction. */
const CENTS_DOWN = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_DOWN);

/**
 * The Fund's pot and per-account slice for one cycle.
 *
 * Pure; the API service, the growth model and the plan ledger all call this, so a
 * dial that moves republishes everything that derives from it and nothing ever
 * carries a second opinion of the formula.
 */
export function timePoolFundPool(input: {
	/** The cycle's booked charitable revenue (the settled holdings basis). */
	charitableRevenue: Decimal.Value;
	/** The admin budget's share of charitable revenue — the plan settings' dial. */
	adminBudgetShare: Decimal.Value;
	/** Free Access's share of the programs — the Fund's own dial. */
	freeAccessShare: Decimal.Value;
	/** Accounts with at least one credited Public Access second in the cycle and no Anthers holding. Zero when the cycle is a projection without a known count. */
	activeFreeAccounts: number;
	/** The smallest paid pool — a Root supporter's — the parity ceiling multiplies by the account count. */
	rootPool: Decimal.Value;
}): { pool: Decimal; slice: Decimal; uncapped: Decimal } {
	const base = new Decimal(input.charitableRevenue)
		.times(input.freeAccessShare)
		.times(Decimal.max(0, new Decimal(1).minus(input.adminBudgetShare)));
	const ceiling = input.activeFreeAccounts > 0
		? new Decimal(input.rootPool).times(input.activeFreeAccounts)
		: new Decimal(0);
	// ⚠️ With no active free account the pot has nobody to divide across — the ceiling
	// reads zero and the pot is unspent, which is the doctrine working (a cycle in which
	// nobody streamed the commons funds no slice), never a division by zero.
	const pool = Decimal.min(base, ceiling);
	const slice = input.activeFreeAccounts > 0
		? CENTS_DOWN(pool.div(input.activeFreeAccounts))
		: new Decimal(0);
	return { pool, slice, uncapped: base };
}
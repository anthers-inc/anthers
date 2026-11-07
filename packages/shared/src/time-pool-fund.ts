// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund's arithmetic: one service level, one cap, computed.
 *
 * The free account's Time Pool stopped being a per-head constant (`FREE_TIME_POOL`,
 * retired into this mechanism with the pool-mechanism task, 2026-10-10) and became
 * **the Fund**: a budget line the organization chooses each cycle, divided across the
 * cycle's eligible free accounts, each slice flowing through `computeMonth` unchanged.
 *
 * ⭐ **The Fund is a choice, not a percentage of revenue** (Parker, 2026-11-07). The
 * only fixed commitment in the budget is that admin spending stays at or below 30% of
 * all spending. Time Pool Fund, preservation, bounties and the rest are discretionary,
 * funded from undirected revenue — support remainders, contributions, and whatever is
 * not already spoken for by a commitment to a specific user. The **rate** is the chosen
 * dollars per eligible free account; the **cap** is the smallest paid Time Pool (a Root
 * supporter's, $1.00 at the seeded ladder), and no free account may be funded above it.
 *
 * Two functions, two questions, one cap:
 *
 * - {@link timePoolFundActual} — what a cycle's chosen rate funds. The runtime service,
 *   the ledger and the distribution all read this.
 * - {@link timePoolFundProjection} — what a revenue share would fund at a modeled
 *   scale, capped by the same rate. Only the financial plan calls it. It exists so the
 *   plan can ask whether the self-sufficient share covers the chosen service level;
 *   it never determines an actual cycle's pool, because contributions and other
 *   undirected revenue are not modeled there by design.
 *
 * The rate is capped by the parity ceiling — the subsidized slice never funds any
 * account above what the smallest paid Time Pool funds — and the slice is floored to
 * the whole cent (ROUND_DOWN, not HALF_UP): the dust stays in the remainder. Credits
 * are per-slice and nothing distributes the dust, so flooring is what keeps the books
 * exact; rounding up would promise money the pot does not hold.
 */
import Decimal from "decimal.js";

export const FUND_STATUS = ["actual", "committed", "estimate"] as const;

export type FundStatus = (typeof FUND_STATUS)[number];

/** Round to cents, DOWN — the slice's own rounding direction. */
const CENTS_DOWN = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_DOWN);

/**
 * What a cycle's chosen rate funds: the rate per eligible free account, never above
 * the cap, times the accounts.
 *
 * ⭐ **This is the actual, and the rate is the decision.** An unappropriated cycle's
 * rate is the cap (the general disposition is as much as the discretionary budget
 * allows), so the service pays the maximum rather than silently nothing; a budget that
 * cannot afford the cap sets a lower rate for that cycle. The pool is capped at
 * `rate × accounts` because the Fund is a service level, not a windfall: extra
 * contributions do not raise a free account's Time Pool above the cheapest Badge.
 */
export function timePoolFundActual(input: {
	/** The chosen dollars per eligible free account. */
	ratePerAccount: Decimal.Value;
	/** Accounts eligible for a Fund-funded Time Pool this cycle. */
	activeFreeAccounts: number;
	/** The smallest paid Time Pool — a Root supporter's — the ceiling on the rate. */
	capPerAccount: Decimal.Value;
}): { pool: Decimal; slice: Decimal; rate: Decimal } {
	const cap = new Decimal(input.capPerAccount);
	const rate = Decimal.max(0, Decimal.min(new Decimal(input.ratePerAccount), cap));
	// ⚠️ With no eligible account the pool has nobody to divide across and is unspent,
	// which is the doctrine working (a cycle in which nobody eligible streamed the
	// commons funds no slice), never a division by zero.
	const pool = input.activeFreeAccounts > 0 ? rate.times(input.activeFreeAccounts) : new Decimal(0);
	const slice =
		input.activeFreeAccounts > 0 ? CENTS_DOWN(pool.div(input.activeFreeAccounts)) : new Decimal(0);
	return { pool, slice, rate };
}

/**
 * What a revenue share would fund at a modeled scale — the financial plan's question.
 *
 *   uncapped = share × (1 − adminBudgetShare) × charitableRevenue
 *   pool     = min(uncapped, cap × freeAccounts)
 *
 * ⚠️ **Not the runtime's pool.** The plan models a self-sufficient platform funded by
 * user revenue alone, so it can answer "does the paying share cover the service
 * level?" An actual cycle spends from all undirected revenue — contributions included —
 * and its amount is {@link timePoolFundActual}, where the organization makes that
 * choice instead of deriving it. The two share the cap and the floor-to-cent slice, so
 * they can never disagree about the most a free account may receive.
 */
export function timePoolFundProjection(input: {
	/** The cycle's booked charitable revenue (the settled holdings basis). */
	charitableRevenue: Decimal.Value;
	/** The admin budget's share of charitable revenue — the plan settings' dial. */
	adminBudgetShare: Decimal.Value;
	/** Free Access's share of the programs — the plan's allocation dial. */
	freeAccessShare: Decimal.Value;
	/** Accounts with at least one credited Public Access second in the cycle and no Anthers holding. Zero when the cycle is a projection without a known count. */
	activeFreeAccounts: number;
	/** The chosen service level the projection may never exceed — a Root supporter's Time Pool. */
	ratePerAccount: Decimal.Value;
}): { pool: Decimal; slice: Decimal; uncapped: Decimal } {
	const base = new Decimal(input.charitableRevenue)
		.times(input.freeAccessShare)
		.times(Decimal.max(0, new Decimal(1).minus(input.adminBudgetShare)));
	const ceiling =
		input.activeFreeAccounts > 0
			? new Decimal(input.ratePerAccount).times(input.activeFreeAccounts)
			: new Decimal(0);
	const pool = Decimal.min(base, ceiling);
	const slice =
		input.activeFreeAccounts > 0 ? CENTS_DOWN(pool.div(input.activeFreeAccounts)) : new Decimal(0);
	return { pool, slice, uncapped: base };
}

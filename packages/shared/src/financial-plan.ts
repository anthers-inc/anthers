// SPDX-License-Identifier: Apache-2.0
/**
 * The financial plan's ledger math: one phase of the plan, computed.
 *
 * The admin console's Financial Plan screen is the **raw data host** (Parker,
 * 2026-10-07): a table of editable phases, from which public-facing financial
 * resources are generated and into which the financial projections in internal
 * docs (Organizational Structure) eventually dissolve. The math lives HERE, in
 * shared, so the tool's numbers and anything generated from the tool's data can
 * never disagree — a duplicated plan formula is the same defect class as the
 * five hand-rolled card-fee copies and the two-model floor incident.
 *
 * ## The plan's settled shape (2026-10-07)
 *
 * - **Admin is budgeted at the full 30% ceiling** (`ADMIN_CEILING`), on purpose:
 *   the ceiling is the growth budget that covers out-of-pocket infrastructure and
 *   — through the staffing the budget affords — compensation for work currently
 *   done unpaid. Budgeting at the ceiling means reality can only be more
 *   charitable than the plan, never less. Spending tracks under the budget until
 *   scale justifies drawing it down.
 * - **The Time Pool Fund takes a stated share of the remainder after admin**
 *   (10% at the default): free accounts' pools as a budgeted program line, per
 *   the pool task's ruling.
 * - **Programs are the residual** — revenue minus the admin budget, the Fund,
 *   and free storage.
 *
 * ## The closed form
 *
 * `charitableRevenue` is **independent of the free slice**: paying users'
 * remainders are the whole of revenue under the 2026-10-07 rulings (at-cost
 * storage earns nothing), and the free pool is an *obligation*, not an input to
 * revenue. So the Fund's per-account slice needs no iteration:
 *
 *   slice = fundShare × (1 − adminBudgetShare) × charitableRevenue ÷ freeAccounts
 *
 * (`modelAt` runs twice — once for revenue, once with the resolved slice for the
 * obligation lines — which is exact, not an approximation. The iterative
 * convergence this replaces converged in one step for the same reason.)
 */
import { ADMIN_CEILING, modelAt, NO_STAFFING, type Staffing } from "./growth.js";

/** One editable phase of the financial plan — the tool's input row. */
export interface PlanPhaseInput {
	accounts: number;
	/** Share of accounts giving Anthers anything, 0..1. */
	payingShare: number;
	/** The phase's planned operating spend, per month. */
	staffing: Staffing;
	/**
	 * The admin budget as a share of charitable revenue. Defaults to the locked
	 * 30% ceiling — the plan's standing assumption.
	 */
	adminBudgetShare?: number;
	/** The Time Pool Fund's share of the remainder after admin. Default 0.10. */
	fundShare?: number;
}

/** One computed phase — everything the tool's table and phase view draw. */
export interface PlanLedger {
	accounts: number;
	creators: number;
	payingAccounts: number;
	freeAccounts: number;
	/** Charitable revenue, $/mo — paying users' remainders. */
	charitableRevenue: number;
	/** The admin BUDGET: `adminBudgetShare × revenue`. The plan books this. */
	adminBudget: number;
	/** What ops actually spends at this scale: staffing + infrastructure + reserves. */
	adminActual: number;
	/** Whether actual spend fits inside the budget. */
	adminWithinCeiling: boolean;
	/** The Time Pool Fund's pot, $/mo — free accounts' pools together. */
	fund: number;
	/** The Fund's slice per active free account, $/mo. */
	freeSlice: number;
	/** Free storage: free creators' catalogs and every paying rung's bundled allowance. */
	freeStorage: number;
	/** The residual, $/mo — revenue minus admin budget minus Fund minus free storage. */
	programs: number;
	/** False when the residual goes negative — the plan row that cannot be afforded. */
	solvent: boolean;
	/** Paid to creators by time, $/mo — paying users' pools plus the Fund. */
	timePoolToCreators: number;
	/** The admin ceiling the budget honors (`ADMIN_CEILING`), for drawing. */
	adminCeiling: number;
	/** The granular spending view: the overhead lines open, and free storage's two parts. */
	spending: PlanSpending;
}

/**
 * Where the plan's money actually goes, line by line — the granular spending
 * view the plan tool's diagram draws. Everything here is read from the model
 * (`modelAt`'s open overhead lines and the storage subsidy's two parts); the
 * only computed member is `headroom`, the budget's unspent remainder.
 *
 * Conservation is exact and is what the diagram's three columns rely on:
 * infrastructure + the three staffing lines + reserves = `adminActual`
 * (overhead), and with `headroom` the five sum to `adminBudget`; the two
 * storage parts sum to `freeStorage`; free pools are the Fund itself.
 */
export interface PlanSpending {
	infrastructure: number;
	staff: number;
	tooling: number;
	services: number;
	reserves: number;
	/** `adminBudget − adminActual` — negative when ops exceeds the budget. */
	headroom: number;
	/** Free creators' catalogs, carried on the charitable budget. */
	freeCatalog: number;
	/** Paying rungs' bundled storage allowances, paid to the vendor at cost. */
	payingAllowances: number;
}

/** Compute one phase of the plan. Pure; the tool and every generator call this. */
export function planLedger(input: PlanPhaseInput): PlanLedger {
	const adminBudgetShare = input.adminBudgetShare ?? ADMIN_CEILING;
	const fundShare = input.fundShare ?? 0.1;

	const base = modelAt({
		accounts: input.accounts,
		payingShare: input.payingShare,
		staffing: input.staffing ?? NO_STAFFING,
	});
	const charitableRevenue = base.charitableRevenue;
	const adminBudget = adminBudgetShare * charitableRevenue;
	const fund = fundShare * (charitableRevenue - adminBudget);
	const freeAccounts = Math.max(1, base.freeAccounts);
	const freeSlice = fund / freeAccounts;

	const m = modelAt({
		accounts: input.accounts,
		payingShare: input.payingShare,
		staffing: input.staffing ?? NO_STAFFING,
		freeTimePool: freeSlice,
	});
	// `freeAccess` = the slice × free accounts (the Fund) + free storage, so the
	// storage obligation is the difference — read from the model, never re-derived.
	const freeStorage = m.freeAccess - fund;
	const programs = charitableRevenue - adminBudget - fund - freeStorage;

	return {
		accounts: base.accounts,
		creators: base.creators,
		payingAccounts: base.payingAccounts,
		freeAccounts: base.freeAccounts,
		charitableRevenue,
		adminBudget,
		adminActual: m.overhead,
		adminWithinCeiling: m.overhead <= adminBudget + 1e-9,
		fund,
		freeSlice,
		freeStorage,
		programs,
		solvent: programs >= -1e-9,
		timePoolToCreators: m.timePoolToCreators,
		adminCeiling: adminBudgetShare,
		spending: {
			infrastructure: m.infrastructure,
			staff: input.staffing?.staff ?? 0,
			tooling: input.staffing?.tooling ?? 0,
			services: input.staffing?.services ?? 0,
			reserves: m.reserves,
			headroom: adminBudget - m.overhead,
			freeCatalog: m.freeCatalogSubsidy,
			payingAllowances: m.payingAllowanceSubsidy,
		},
	};
}

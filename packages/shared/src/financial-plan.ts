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
 * ## The plan's settled shape (2026-10-10)
 *
 * The charitable budget is a two-level shape, and the levels are load-bearing
 * (Parker, 2026-10-10): **Programs is the parent line, and Free Access and Free
 * Storage are programs WITHIN it**, never siblings of it. Offering free public
 * access that still pays creators, and offering free storage to smaller
 * creators, are charitable programs — the public service that everyone should
 * be able to share and experience creative and educational content for free
 * forever, with no ads or data harvesting.
 *
 * - **Admin is budgeted at the full 30% ceiling** (`ADMIN_CEILING`), on purpose:
 *   the ceiling is the growth budget that covers out-of-pocket infrastructure and
 *   — through the staffing the budget affords — compensation for work currently
 *   done unpaid. Budgeting at the ceiling means reality can only be more
 *   charitable than the plan, never less. Spending tracks under the budget until
 *   scale justifies drawing it down. This caps Programs at no less than 70% of
 *   charitable revenue by construction.
 * - **Programs are everything after admin** — `charitableRevenue − adminBudget`
 *   — subdivided into:
 *   - **Free Access**, at a stated share of Programs (default 0.10), spent
 *     through the Time Pool Fund: the mechanism that offers free public access
 *     in a way that still pays creators. Vocabulary (Parker, 2026-10-10): at the
 *     high level of financial planning or reporting the line is **Free Access**
 *     — the public service, the complement to Free Storage — while **Time Pool
 *     Fund** names the component of how it is offered, that creators are paid
 *     for it.
 *   - **Free Storage** — the storage subsidy read from the model, never
 *     re-derived here: free creators' catalogs and every paying rung's bundled
 *     allowance, both paid to the vendor at cost.
 *   - **Other Programs** — the residual within Programs, budgeted but not yet
 *     allocated: the dial to watch as the path scales.
 *
 * ## The closed form
 *
 * `charitableRevenue` is **independent of the free slice**: paying users'
 * remainders are the whole of revenue under the 2026-10-07 rulings (at-cost
 * storage earns nothing), and the free pool is an *obligation*, not an input to
 * revenue. So the per-account slice needs no iteration:
 *
 *   slice = freeAccessShare × (1 − adminBudgetShare) × charitableRevenue ÷ freeAccounts
 *
 * (`modelAt` runs twice — once for revenue, once with the resolved slice for the
 * obligation lines — which is exact, not an approximation. The iterative
 * convergence this replaces converged in one step for the same reason.)
 */
import { ADMIN_CEILING, modelAt, NO_STAFFING, type Staffing } from "./growth.js";

/** One editable phase of the plan — the tool's input row. */
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
	/**
	 * Free Access's share of Programs — the remainder after admin. Default 0.10.
	 * The share is spent through the Time Pool Fund: free accounts' Time Pools.
	 */
	freeAccessShare?: number;
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
	/** Programs — everything after admin: `charitableRevenue − adminBudget`. */
	programs: number;
	/** Free Access: the Fund's pot, $/mo — free accounts' pools together. */
	freeAccess: number;
	/** Free Access's slice per active free account, $/mo — the Fund's slice. */
	freeSlice: number;
	/** Free storage: free creators' catalogs and every paying rung's bundled allowance. */
	freeStorage: number;
	/** The residual WITHIN programs, $/mo — programs minus Free Access minus free storage. */
	otherPrograms: number;
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
 * Conservation is exact and is what the diagram's columns rely on:
 * infrastructure + the three staffing lines + reserves = `adminActual`
 * (overhead), and with `headroom` the five sum to `adminBudget`; the two
 * storage parts sum to `freeStorage`; and `freeAccess + freeStorage +
 * otherPrograms` = `programs` — the hierarchy is a conservation statement, not
 * a drawing choice.
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
	const freeAccessShare = input.freeAccessShare ?? 0.1;

	const base = modelAt({
		accounts: input.accounts,
		payingShare: input.payingShare,
		staffing: input.staffing ?? NO_STAFFING,
	});
	const charitableRevenue = base.charitableRevenue;
	const adminBudget = adminBudgetShare * charitableRevenue;
	// Programs is the parent: everything after admin. Free Access's share is
	// taken OF programs, so the two shares never collide — admin 30% leaves
	// programs ≥ 70% by construction, whatever the per-phase overrides say.
	const programs = charitableRevenue - adminBudget;
	const freeAccess = freeAccessShare * programs;
	const freeAccounts = Math.max(1, base.freeAccounts);
	const freeSlice = freeAccess / freeAccounts;

	const m = modelAt({
		accounts: input.accounts,
		payingShare: input.payingShare,
		staffing: input.staffing ?? NO_STAFFING,
		freeTimePool: freeSlice,
	});
	// The storage obligation is the storage subsidy minus the Fund — read from
	// the model, never re-derived. (The model's `freeAccess` is the whole free
	// slice × free accounts plus storage; the plan splits those two lines.)
	const freeStorage = m.freeAccess - freeAccess;
	const otherPrograms = programs - freeAccess - freeStorage;

	return {
		accounts: base.accounts,
		creators: base.creators,
		payingAccounts: base.payingAccounts,
		freeAccounts: base.freeAccounts,
		charitableRevenue,
		adminBudget,
		adminActual: m.overhead,
		adminWithinCeiling: m.overhead <= adminBudget + 1e-9,
		programs,
		freeAccess,
		freeSlice,
		freeStorage,
		otherPrograms,
		solvent: otherPrograms >= -1e-9,
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
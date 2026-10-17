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
import { ADMIN_CEILING, FREE_ACCESS_SHARE_DEFAULT, modelAt, NO_STAFFING, type Staffing } from "./growth.js";

export { FREE_ACCESS_SHARE_DEFAULT };

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
	/**
	 * The paying accounts apportioned across the modeled Badge rungs — the
	 * inflow side of any public drawing of the full support dollar. Each
	 * rung's money split composes from the published primitives against
	 * `accounts × amount`, and the sum of the splits equals
	 * `charitableRevenue + (timePoolToCreators − the Fund's free pools)` plus
	 * card cost, by the model's own conservation.
	 */
	payersByRung: Array<{ amount: number; accounts: number }>;
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
	const freeAccessShare = input.freeAccessShare ?? FREE_ACCESS_SHARE_DEFAULT;

	// ONE pass: the free pool derives inside `modelAt` from the same shares, through
	// the same `timePoolFundPool` arithmetic the runtime service uses — the two-pass
	// convergence this replaced needed a free slice fed back in because the model
	// carried no notion of the shares; it does now.
	const m = modelAt({
		accounts: input.accounts,
		payingShare: input.payingShare,
		staffing: input.staffing ?? NO_STAFFING,
		adminBudgetShare,
		freeAccessShare,
	});
	const charitableRevenue = m.charitableRevenue;
	const adminBudget = adminBudgetShare * charitableRevenue;
	// Programs is the parent: everything after admin. Free Access's share is
	// taken OF programs, so the two shares never collide — admin 30% leaves
	// programs ≥ 70% by construction, whatever the per-phase overrides say.
	const programs = charitableRevenue - adminBudget;
	// Free Access is the Fund's pot — the model's own pool figure (capped by the
	// parity ceiling it may never need), so this ledger and the runtime's published
	// rows are the same arithmetic at different scales.
	const freeAccess = m.freePool;
	const freeSlice = m.freeSlice;

	// The storage obligation is the free program's remainder — read from the model,
	// never re-derived. (The model's `freeAccess` is the whole free pot plus storage;
	// the plan splits those two lines.)
	const freeStorage = m.freeAccess - freeAccess;
	const otherPrograms = programs - freeAccess - freeStorage;

	return {
		accounts: m.accounts,
		creators: m.creators,
		payingAccounts: m.payingAccounts,
		freeAccounts: m.freeAccounts,
		payersByRung: m.bySupportRung,
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

// ── The authored plan ────────────────────────────────────────────────────────
/**
 * The plan's rows, **authored**, so the admin tool's seed and any generator
 * read one source rather than two copies of nine rows — the same
 * two-descriptions-of-one-fact defect the mix's history carries.
 *
 * ⚠️ **These rows are the plan as published.** The admin tool seeds them once
 * and the operator edits the table afterwards; a materially changed plan means
 * editing these rows in the same breath, so the next generated public surface
 * draws the plan the operator means (the prompt-at-the-moment-the-information-
 * exists rule from the machine rules — accepted cost of public-source
 * generation). The phase labels are public copy.
 */
export const PLAN_DEFAULTS = { adminBudgetShare: ADMIN_CEILING, freeAccessShare: FREE_ACCESS_SHARE_DEFAULT } as const;

/** One authored row of the plan's path, matching the plan tables' columns. */
export interface AuthoredPlanPhase {
	phase: number;
	label: string;
	accounts: number;
	/** Share of accounts giving Anthers anything. */
	payingShare: number;
	staff: number;
	tooling: number;
	services: number;
	adminBudgetShare: number | null;
	freeAccessShare: number | null;
}

/** The path from launch through inflection 1 and one phase past it (2026-10-07 working sessions). */
export const DEFAULT_PLAN_PHASES: readonly AuthoredPlanPhase[] = [
	{
		phase: 1,
		label: "Launch — Covering Out-of-Pocket",
		accounts: 1_000,
		payingShare: 0.3,
		staff: 0,
		tooling: 50,
		services: 0,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 2,
		label: "First Tooling",
		accounts: 2_000,
		payingShare: 0.3,
		staff: 0,
		tooling: 100,
		services: 50,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 3,
		label: "Gathering",
		accounts: 5_000,
		payingShare: 0.3,
		staff: 0,
		tooling: 100,
		services: 50,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 4,
		label: "Token Stipend",
		accounts: 10_000,
		payingShare: 0.3,
		staff: 800,
		tooling: 100,
		services: 100,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 5,
		label: "Part-time",
		accounts: 15_000,
		payingShare: 0.3,
		staff: 1_800,
		tooling: 150,
		services: 150,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 6,
		label: "Most-of-the-time",
		accounts: 20_000,
		payingShare: 0.3,
		staff: 3_600,
		tooling: 200,
		services: 200,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 7,
		label: "Near Full-Time",
		accounts: 30_000,
		payingShare: 0.3,
		staff: 3_600,
		tooling: 200,
		services: 200,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 8,
		label: "INFLECTION 1 — Full-Time",
		accounts: 40_000,
		payingShare: 0.3,
		staff: 6_700,
		tooling: 250,
		services: 200,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
	{
		phase: 9,
		label: "Full-Time, Room to Spare",
		accounts: 60_000,
		payingShare: 0.3,
		staff: 6_700,
		tooling: 250,
		services: 200,
		adminBudgetShare: null,
		freeAccessShare: null,
	},
];

/** A phase row's effective shares against the plan's settings row. */
function withShares(
	row: Pick<AuthoredPlanPhase, "adminBudgetShare" | "freeAccessShare">,
	settings: { adminBudgetShare: number; freeAccessShare: number },
) {
	return {
		adminBudgetShare: row.adminBudgetShare ?? settings.adminBudgetShare,
		freeAccessShare: row.freeAccessShare ?? settings.freeAccessShare,
	};
}

/** One plan row at a settings row's defaults, computed — the tool's and generators' shared mapping. */
export function planLedgerFor(
	row: Omit<AuthoredPlanPhase, "phase" | "label">,
	settings: { adminBudgetShare: number; freeAccessShare: number },
): PlanLedger {
	return planLedger({
		accounts: row.accounts,
		payingShare: row.payingShare,
		staffing: { staff: row.staff, tooling: row.tooling, services: row.services },
		...withShares(row, settings),
	});
}

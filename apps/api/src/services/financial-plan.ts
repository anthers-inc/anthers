// SPDX-License-Identifier: Apache-2.0
/**
 * The financial plan's service — the one writer and reader of its records.
 *
 * The Admin Console's Financial Plan screen edits the plan; public resources are
 * generated from what this service serves. Every computed dollar figure comes
 * from `planLedger` in `@anthers/shared/financial-plan` at read time — inputs
 * live in the tables, outputs never do.
 *
 * **Seeding is idempotent and never overwrites an edit.** The default plan (the
 * path from launch through inflection 1, recorded from the 2026-10-07 working
 * sessions) inserts once, when the tables are empty. After that the plan is the
 * operator's data; re-seeding is a row the operator deletes, never a script's
 * authority.
 */
import { db } from "@anthers/db/client";
import { financialPlanPhases, financialPlanSettings } from "@anthers/db/schema";
import { type PlanLedger, planLedger } from "@anthers/shared/financial-plan";
import { ADMIN_CEILING } from "@anthers/shared/growth";
import { asc, eq } from "drizzle-orm";

/** The plan's global defaults when nothing has been edited: locked 30%, Fund 10%. */
export const PLAN_DEFAULTS = { adminBudgetShare: ADMIN_CEILING, fundShare: 0.1 } as const;

interface PhaseRow {
	id: number;
	phase: number;
	label: string;
	accounts: number;
	payingShare: number;
	staff: number;
	tooling: number;
	services: number;
	adminBudgetShare: number | null;
	fundShare: number | null;
}

/** The default plan's phases — the path from here through inflection 1. */
const DEFAULT_PHASES: Array<Omit<PhaseRow, "id">> = [
	{
		phase: 1,
		label: "Launch — covering out-of-pocket",
		accounts: 1_000,
		payingShare: 0.3,
		staff: 0,
		tooling: 50,
		services: 0,
		adminBudgetShare: null,
		fundShare: null,
	},
	{
		phase: 2,
		label: "First tooling",
		accounts: 2_000,
		payingShare: 0.3,
		staff: 0,
		tooling: 100,
		services: 50,
		adminBudgetShare: null,
		fundShare: null,
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
		fundShare: null,
	},
	{
		phase: 4,
		label: "Token stipend",
		accounts: 10_000,
		payingShare: 0.3,
		staff: 800,
		tooling: 100,
		services: 100,
		adminBudgetShare: null,
		fundShare: null,
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
		fundShare: null,
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
		fundShare: null,
	},
	{
		phase: 7,
		label: "Near full-time",
		accounts: 30_000,
		payingShare: 0.3,
		staff: 3_600,
		tooling: 200,
		services: 200,
		adminBudgetShare: null,
		fundShare: null,
	},
	{
		phase: 8,
		label: "INFLECTION 1 — full-time",
		accounts: 40_000,
		payingShare: 0.3,
		staff: 6_700,
		tooling: 250,
		services: 200,
		adminBudgetShare: null,
		fundShare: null,
	},
	{
		phase: 9,
		label: "Full-time, room to spare",
		accounts: 60_000,
		payingShare: 0.3,
		staff: 6_700,
		tooling: 250,
		services: 200,
		adminBudgetShare: null,
		fundShare: null,
	},
];

/** Resolve a row's effective shares against the settings row's defaults. */
function effectiveShares(
	row: Pick<PhaseRow, "adminBudgetShare" | "fundShare">,
	settings: { adminBudgetShare: number; fundShare: number },
) {
	return {
		adminBudgetShare: row.adminBudgetShare ?? settings.adminBudgetShare,
		fundShare: row.fundShare ?? settings.fundShare,
	};
}

/** Load the settings row, creating it from `PLAN_DEFAULTS` on first read. */
export async function loadPlanSettings(): Promise<{
	id: number;
	adminBudgetShare: number;
	fundShare: number;
}> {
	const existing = await db.select().from(financialPlanSettings).limit(1);
	const row = existing[0];
	if (row) return { id: row.id, adminBudgetShare: row.adminBudgetShare, fundShare: row.fundShare };
	const inserted = await db.insert(financialPlanSettings).values(PLAN_DEFAULTS).returning({
		id: financialPlanSettings.id,
		adminBudgetShare: financialPlanSettings.adminBudgetShare,
		fundShare: financialPlanSettings.fundShare,
	});
	return inserted[0];
}

/** Update the settings row (the tool's global shares). Singleton — there is exactly one. */
export async function updatePlanSettings(values: {
	adminBudgetShare?: number;
	fundShare?: number;
}) {
	const row = await loadPlanSettings();
	await db
		.update(financialPlanSettings)
		.set({ ...values, updatedAt: new Date() })
		// The singleton's id — captured from the load rather than assumed to be 1: a test
		// wipe deletes rows without resetting serials, and a hand delete could too. The
		// update writing row 1 only would silently no-op on id 2, which is exactly the
		// silent-write shape this repo's tests exist to catch.
		.where(eq(financialPlanSettings.id, row.id));
	return loadPlanSettings();
}

/**
 * The plan as the tool sees it: every phase, its computed ledger beside its inputs.
 * Seeds the default phases when the table is empty.
 */
export async function loadPlan(): Promise<{
	settings: { adminBudgetShare: number; fundShare: number };
	phases: Array<PhaseRow & { ledger: PlanLedger }>;
}> {
	const settings = await loadPlanSettings();

	let rows = await db.select().from(financialPlanPhases).orderBy(asc(financialPlanPhases.phase));
	if (rows.length === 0) {
		await db.insert(financialPlanPhases).values(DEFAULT_PHASES);
		rows = await db.select().from(financialPlanPhases).orderBy(asc(financialPlanPhases.phase));
	}

	return {
		settings,
		phases: rows.map((row) => ({
			...row,
			ledger: planLedger({
				accounts: row.accounts,
				payingShare: row.payingShare,
				staffing: { staff: row.staff, tooling: row.tooling, services: row.services },
				...effectiveShares(row, settings),
			}),
		})),
	};
}

const PHASE_UPDATE_FIELDS = [
	"label",
	"accounts",
	"payingShare",
	"staff",
	"tooling",
	"services",
	"adminBudgetShare",
	"fundShare",
] as const;

/** Update one phase's inputs (the tool's edit). Computed values are never written. */
export async function updatePhase(
	id: number,
	values: Partial<Record<(typeof PHASE_UPDATE_FIELDS)[number], number | string | null | undefined>>,
) {
	const sets: Record<string, unknown> = { updatedAt: new Date() };
	for (const field of PHASE_UPDATE_FIELDS) {
		if (values[field] !== undefined) sets[field] = values[field];
	}
	// 🚨 A body that parsed to NO fields would update only the timestamp and answer 200 —
	// the silent-no-op write that a missing Content-Type produces upstream of zod (found in
	// the browser pass). Refuse it: an edit that edits nothing is a client bug, and 400 is
	// how the tool's table learns instead of quietly redrawing the same numbers.
	if (Object.keys(sets).length === 1) return null;
	const updated = await db
		.update(financialPlanPhases)
		.set(sets)
		.where(eq(financialPlanPhases.id, id))
		.returning({ id: financialPlanPhases.id });
	return updated[0] ?? null;
}

/** The highest existing phase number, for appending — 0 on an empty table. */
export async function nextPhaseNumber(): Promise<number> {
	const rows = await db
		.select({ phase: financialPlanPhases.phase })
		.from(financialPlanPhases)
		.orderBy(asc(financialPlanPhases.phase));
	const numbers = rows.map((r) => r.phase);
	return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

/** Add a phase at the end of the path. */
export async function addPhase(values: Omit<PhaseRow, "id">) {
	const inserted = await db
		.insert(financialPlanPhases)
		.values(values)
		.returning({ id: financialPlanPhases.id });
	return inserted[0];
}

/** Delete a phase (the operator's own row — the defaults are theirs to edit, too). */
export async function deletePhase(id: number): Promise<boolean> {
	const deleted = await db
		.delete(financialPlanPhases)
		.where(eq(financialPlanPhases.id, id))
		.returning({ id: financialPlanPhases.id });
	return deleted.length > 0;
}

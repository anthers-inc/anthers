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
import {
	type AuthoredPlanPhase,
	DEFAULT_PLAN_PHASES,
	PLAN_DEFAULTS,
	type PlanLedger,
	planLedgerFor,
} from "@anthers/shared/financial-plan";
import { asc, eq } from "drizzle-orm";

export type { AuthoredPlanPhase };
/** The plan's global defaults when nothing has been edited: locked 30% admin, Free Access 10% of Programs. Authored in shared — the published-figures generator reads the same rows. */
export { PLAN_DEFAULTS };

/**
 * A plan row as the tables carry it — `AuthoredPlanPhase` plus its id.
 */
interface PhaseRow extends AuthoredPlanPhase {
	id: number;
}

/** The default plan's phases — authored in shared, seeded once into the operator's tables. */
const DEFAULT_PHASES = DEFAULT_PLAN_PHASES;

/** Load the settings row, creating it from `PLAN_DEFAULTS` on first read. */
export async function loadPlanSettings(): Promise<{
	id: number;
	adminBudgetShare: number;
	freeAccessShare: number;
}> {
	const existing = await db.select().from(financialPlanSettings).limit(1);
	const row = existing[0];
	if (row)
		return {
			id: row.id,
			adminBudgetShare: row.adminBudgetShare,
			freeAccessShare: row.freeAccessShare,
		};
	const inserted = await db.insert(financialPlanSettings).values(PLAN_DEFAULTS).returning({
		id: financialPlanSettings.id,
		adminBudgetShare: financialPlanSettings.adminBudgetShare,
		freeAccessShare: financialPlanSettings.freeAccessShare,
	});
	return inserted[0];
}

/** Update the settings row (the tool's global shares). Singleton — there is exactly one. */
export async function updatePlanSettings(values: {
	adminBudgetShare?: number;
	freeAccessShare?: number;
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
	settings: { adminBudgetShare: number; freeAccessShare: number };
	phases: Array<PhaseRow & { ledger: PlanLedger }>;
}> {
	const settings = await loadPlanSettings();

	let rows = await db.select().from(financialPlanPhases).orderBy(asc(financialPlanPhases.phase));
	if (rows.length === 0) {
		await db.insert(financialPlanPhases).values([...DEFAULT_PHASES]);
		rows = await db.select().from(financialPlanPhases).orderBy(asc(financialPlanPhases.phase));
	}

	return {
		settings,
		phases: rows.map((row) => ({
			...row,
			ledger: planLedgerFor(row, settings),
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
	"freeAccessShare",
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

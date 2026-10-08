// SPDX-License-Identifier: Apache-2.0
/**
 * The financial plan service — the admin tool's backed behavior, proved against a real
 * session database (the suite pattern every admin route test follows).
 *
 * What deserves the standing test (81.05): the seed never overwrites an operator's
 * edit (a reload that re-inserted defaults would silently discard the plan), the
 * ledger math's shape conservation (revenue = budget + fund + storage + programs,
 * exactly), and the closed form's independence (charitableRevenue does not move
 * when the free slice does — the property the tool's no-iteration read rests on).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { financialPlanPhases, financialPlanSettings } from "@anthers/db/schema";
import {
	addPhase,
	deletePhase,
	loadPlan,
	nextPhaseNumber,
	updatePhase,
	updatePlanSettings,
} from "./financial-plan.js";

async function wipe() {
	await db.delete(financialPlanPhases);
	await db.delete(financialPlanSettings);
}

afterAll(async () => {
	await wipe();
});

beforeEach(async () => {
	await wipe();
});

describe("the financial plan service", () => {
	it("seeds the default plan exactly once, and never overwrites an edit", async () => {
		const first = await loadPlan();
		expect(first.phases.length).toBeGreaterThanOrEqual(9);
		const saved = first.phases[0];

		// The operator's edit...
		await updatePhase(saved.id, { accounts: 99_999, label: "operator's row" });
		// ...a full wipe of one table must not resurrect defaults beside real data.
		const second = await loadPlan();
		expect(second.phases.length).toBe(first.phases.length);
		expect(second.phases[0].accounts).toBe(99_999);
		expect(second.phases[0].label).toBe("operator's row");
		// And seed-after-empty is the only path that inserts defaults.
		await wipe();
		const third = await loadPlan();
		expect(third.phases.length).toBe(first.phases.length);
	});

	it("conserves the ledger: revenue = budget + fund + storage + programs", async () => {
		const { phases } = await loadPlan();
		for (const p of phases) {
			const L = p.ledger;
			const sum = L.adminBudget + L.fund + L.freeStorage + L.programs;
			expect(sum).toBeCloseTo(L.charitableRevenue, 6);
			expect(L.solvent).toBe(true);
			// The Fund's slice is the pot divided across free accounts.
			expect(L.fund).toBeCloseTo(L.freeSlice * L.freeAccounts, 6);
		}
	});

	it("the closed form: revenue does not move when the Fund's share does", async () => {
		const before = await loadPlan();
		const rev0 = before.phases[0].ledger.charitableRevenue;
		await updatePlanSettings({ fundShare: 0.2 });
		const after = await loadPlan();
		const rev1 = after.phases[0].ledger.charitableRevenue;
		expect(rev1).toBeCloseTo(rev0, 6);
		// But the Fund doubles, within the slice's own rounding (the slice divides the
		// pot across free accounts at 3dp in the UI, but the ledger is unrounded here —
		// so the assertion is the ratio, to five places).
		const ratio = after.phases[0].ledger.fund / before.phases[0].ledger.fund;
		expect(ratio).toBeCloseTo(2, 5);
	});

	it("admin budgeted at the ceiling: the fund share reads off the remainder after it", async () => {
		const { settings, phases } = await loadPlan();
		expect(settings.adminBudgetShare).toBeCloseTo(0.3, 6);
		const L = phases[0].ledger;
		// Fund = 10% of (revenue − 30%), which is 7% of revenue.
		expect(L.fund / L.charitableRevenue).toBeCloseTo(0.07, 2);
	});

	it("phase CRUD: append and delete, in phase order", async () => {
		const before = await loadPlan();
		const next = await nextPhaseNumber();
		expect(next).toBe(before.phases.length + 1);
		const created = await addPhase({
			phase: next,
			label: "Added by the test",
			accounts: 70_000,
			payingShare: 0.3,
			staff: 0,
			tooling: 0,
			services: 0,
			adminBudgetShare: null,
			fundShare: null,
		});
		expect(created).not.toBeNull();
		const afterAdd = await loadPlan();
		expect(afterAdd.phases.length).toBe(before.phases.length + 1);
		expect(afterAdd.phases.at(-1)?.label).toBe("Added by the test");
		expect(await deletePhase(created!.id)).toBe(true);
		expect(await deletePhase(created!.id)).toBe(false);
	});
});

// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `@anthers/shared/financial-plan` — the standing form of the plan's
 * hierarchy. The shape these tests lock is Parker's 2026-10-10 ruling: Programs
 * is the PARENT line, and Free Access and Free Storage are programs within it,
 * never siblings of it. Every conservation identity here is also what the
 * admin tool's Sankey draws, so a regression in the math cannot hide behind a
 * correct-looking chart.
 */
import { describe, expect, test } from "bun:test";
import { planLedger } from "./financial-plan.js";
import { ADMIN_CEILING } from "./growth.js";

/** A phase at a realistic launch scale, over a grid of the two dials. */
function ledgerAt(payingShare: number, adminBudgetShare?: number, freeAccessShare?: number) {
	return planLedger({
		accounts: 10_000,
		payingShare,
		staffing: { staff: 0, tooling: 100, services: 50 },
		adminBudgetShare,
		freeAccessShare,
	});
}

describe("the plan's hierarchy", () => {
	test("programs is the parent: revenue minus admin, and at the ceiling that is at least 70%", () => {
		for (const payingShare of [0, 0.1, 0.3, 0.6, 1]) {
			const L = ledgerAt(payingShare, ADMIN_CEILING);
			expect(L.programs).toBeCloseTo(L.charitableRevenue - L.adminBudget);
			if (L.charitableRevenue > 0) {
				expect(L.programs / L.charitableRevenue).toBeCloseTo(1 - ADMIN_CEILING);
			}
		}
	});

	test("free access is a stated share OF programs, not of revenue", () => {
		for (const [admin, access] of [
			[undefined, undefined],
			[0.2, 0.15],
			[0.4, 0.05],
			[ADMIN_CEILING, 0.5],
		] as const) {
			const L = ledgerAt(0.3, admin, access);
			const share = access ?? 0.1;
			expect(L.freeAccess).toBeCloseTo(share * L.programs);
		}
	});

	test("free storage and free access are within programs, alongside other programs — conservation is exact", () => {
		for (const payingShare of [0.05, 0.3, 0.75]) {
			for (const access of [0, 0.1, 0.4]) {
				const L = ledgerAt(payingShare, undefined, access);
				expect(L.freeAccess + L.freeStorage + L.otherPrograms).toBeCloseTo(L.programs);
				expect(L.spending.freeCatalog + L.spending.payingAllowances).toBeCloseTo(L.freeStorage);
			}
		}
	});

	// A hierarchy that only held at the default dials would be a drawing choice
	// rather than the model. These grid the whole plausible space.
	test("the hierarchy holds across the dial space, not only at the defaults", () => {
		for (const admin of [0.05, 0.3, 0.55]) {
			for (const access of [0, 0.1, 0.6]) {
				const L = ledgerAt(0.35, admin, access);
				expect(L.programs + L.adminBudget).toBeCloseTo(L.charitableRevenue);
				expect(L.freeAccess).toBeCloseTo(access * L.programs);
				expect(L.freeAccess + L.freeStorage + L.otherPrograms).toBeCloseTo(L.programs);
			}
		}
	});

	test("the Fund's slice divides Free Access — floored to the cent, the dust stays in the remainder", () => {
		const L = ledgerAt(0.3);
		const paid = L.freeSlice * Math.max(1, L.freeAccounts);
		expect(paid).toBeLessThanOrEqual(L.freeAccess + 1e-9);
		// Flooring a per-account slice can strand only the sub-cent dust × accounts.
		expect(L.freeAccess - paid).toBeLessThan(Math.max(1, L.freeAccounts) * 0.01);
	});

	test("solvency is other programs' residual, and flips when the obligations overrun programs", () => {
		const solvent = ledgerAt(0.3, undefined, 0.1);
		expect(solvent.otherPrograms).toBeGreaterThanOrEqual(0);
		expect(solvent.solvent).toBe(true);
		// Free Access at 100% of programs plus the storage obligation overruns
		// the parent: the residual goes negative and the row cannot be afforded.
		const insolvent = ledgerAt(0.3, undefined, 1);
		expect(insolvent.otherPrograms).toBeLessThan(0);
		expect(insolvent.solvent).toBe(false);
	});
});

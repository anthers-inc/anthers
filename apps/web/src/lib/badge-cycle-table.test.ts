// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { cycleTableTotals } from "./badge-cycle-table";

describe("the Where Your Month Went totals", () => {
	it("totals every money column and puts the grand total at their intersection", () => {
		const totals = cycleTableTotals([
			{ timeSeconds: 1800, poolAmount: 1, badgeAmount: 2.61 },
			{ timeSeconds: 900, poolAmount: 2, badgeAmount: 3 },
		]);
		expect(totals).toEqual({
			timeSeconds: 2700,
			poolAmount: 3,
			badgeAmount: 5.61,
			grandTotal: 8.61,
		});
	});

	it("keeps time out of the grand total, because it is not money", () => {
		const totals = cycleTableTotals([{ timeSeconds: 3600, poolAmount: 0, badgeAmount: 0 }]);
		expect(totals.grandTotal).toBe(0);
		expect(totals.timeSeconds).toBe(3600);
	});

	it("answers zeros for an empty month rather than an undefined figure", () => {
		expect(cycleTableTotals([])).toEqual({
			timeSeconds: 0,
			poolAmount: 0,
			badgeAmount: 0,
			grandTotal: 0,
		});
	});
});

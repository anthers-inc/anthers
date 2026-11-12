// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { timePoolTotals } from "./time-pool-table";

describe("the Time Pool totals", () => {
	it("adds the by-time and directed halves of the same pot", () => {
		const totals = timePoolTotals([
			{ poolAmount: 1, stickerAmount: 2.61 },
			{ poolAmount: 2, stickerAmount: 0 },
		]);
		expect(totals).toEqual({ poolAmount: 3, stickerAmount: 2.61, total: 5.61 });
	});

	it("answers zero for a month with nothing directed rather than an undefined figure", () => {
		expect(timePoolTotals([])).toEqual({ poolAmount: 0, stickerAmount: 0, total: 0 });
	});
});

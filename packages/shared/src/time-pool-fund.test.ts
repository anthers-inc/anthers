// SPDX-License-Identifier: Apache-2.0
/**
 * The Fund's arithmetic, separated from the service that reads it.
 *
 * Two questions, one cap: the actual is the chosen rate times the eligible accounts
 * (capped at a Root supporter's Time Pool), and the projection is what a revenue share
 * would fund at a modeled scale, capped by the same rate. The tests pin the cap, the
 * floor, and the zero-account case — the three places a pool can silently overpay.
 */
import { describe, expect, test } from "bun:test";
import { timePoolFundActual, timePoolFundProjection } from "./time-pool-fund.js";

describe("the actual the runtime funds", () => {
	test("pays the chosen rate for every eligible account", () => {
		const fund = timePoolFundActual({
			ratePerAccount: 1,
			activeFreeAccounts: 3,
			capPerAccount: 1,
		});
		expect(fund.pool.toFixed(2)).toBe("3.00");
		expect(fund.slice.toFixed(2)).toBe("1.00");
	});

	test("never funds an account above the smallest paid Time Pool", () => {
		// A budget that tries to be more generous than the cheapest Badge: the cap holds.
		const fund = timePoolFundActual({
			ratePerAccount: 5,
			activeFreeAccounts: 2,
			capPerAccount: 1,
		});
		expect(fund.rate.toFixed(2)).toBe("1.00");
		expect(fund.pool.toFixed(2)).toBe("2.00");
		expect(fund.slice.toFixed(2)).toBe("1.00");
	});

	test("floors the slice and leaves the dust in the remainder", () => {
		// $1.00 across three accounts is 33.333…¢; the books hold 33¢ each, not a
		// promise of a cent the pot does not have.
		const fund = timePoolFundActual({
			ratePerAccount: 1,
			activeFreeAccounts: 3,
			capPerAccount: 1,
		});
		expect(fund.slice.toFixed(2)).toBe("1.00");
		const odd = timePoolFundActual({
			ratePerAccount: "0.10",
			activeFreeAccounts: 3,
			capPerAccount: 1,
		});
		expect(odd.pool.toFixed(2)).toBe("0.30");
		expect(odd.slice.toFixed(2)).toBe("0.10");
		const pennies = timePoolFundActual({
			ratePerAccount: "0.01",
			activeFreeAccounts: 3,
			capPerAccount: 1,
		});
		expect(pennies.pool.toFixed(2)).toBe("0.03");
		expect(pennies.slice.toFixed(2)).toBe("0.01");
	});

	test("spends nothing when no account is eligible", () => {
		const fund = timePoolFundActual({
			ratePerAccount: 1,
			activeFreeAccounts: 0,
			capPerAccount: 1,
		});
		expect(fund.pool.toFixed(2)).toBe("0.00");
		expect(fund.slice.toFixed(2)).toBe("0.00");
	});
});

describe("the plan's projection", () => {
	test("takes the revenue share up to the same cap", () => {
		const fund = timePoolFundProjection({
			charitableRevenue: 20,
			adminBudgetShare: 0.3,
			freeAccessShare: 0.1,
			activeFreeAccounts: 2,
			ratePerAccount: 1,
		});
		// 0.1 × 0.7 × $20 = $1.40, under the $2.00 cap.
		expect(fund.pool.toFixed(2)).toBe("1.40");
		expect(fund.slice.toFixed(2)).toBe("0.70");
	});

	test("the cap binds when the share would fund more", () => {
		const fund = timePoolFundProjection({
			charitableRevenue: 100,
			adminBudgetShare: 0.3,
			freeAccessShare: 0.1,
			activeFreeAccounts: 1,
			ratePerAccount: 1,
		});
		expect(fund.pool.toFixed(2)).toBe("1.00");
		expect(fund.slice.toFixed(2)).toBe("1.00");
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The last check before money moves: what the user was quoted must be what gets billed.
//
// 🚨 **This guard exists because the two numbers were derived by different routes and
// diverged.** On 2026-08-16 `/subscribe` asked `preview/:amount` about the whole charge
// and then POSTed a destination COUNT as the amount, so the modal displayed $9 and the
// subscribe body said $1. Nothing sat between that discrepancy and the card.
//
// ⚠️ What this is NOT: server verification. `recurring.amount` echoes the amount the
// client asked the preview about, so this compares two client-derived numbers. That is
// still the defect class — one caller computing the shown figure and the billed figure by
// two routes — and real authority would mean the preview issuing a token the charge has
// to present, which is a larger change than this.
import { describe, expect, test } from "bun:test";
import { quoteDisagrees } from "./SubscriptionPaymentModal";

describe("the quote-vs-charge guard", () => {
	test("passes when the quote is the sum of what will be billed", () => {
		expect(quoteDisagrees("9.00", 3, [{ amount: 3 }, { amount: 3 }])).toBe(false);
		expect(quoteDisagrees("3.00", 3, [])).toBe(false);
		expect(quoteDisagrees("3.00", 3, undefined)).toBe(false);
	});

	/**
	 * The exact shipped shape: Anthers plus two creators, quoted at the $9 total and billed
	 * as the count `1`. Both are `number`, so nothing upstream could have typechecked it.
	 */
	test("catches the ceremony bug — quoted the total, billing a count", () => {
		expect(quoteDisagrees("9.00", 1, [])).toBe(true);
		expect(quoteDisagrees("3.00", 1, [])).toBe(true);
	});

	test("catches a directed line silently dropped from the charge", () => {
		// Quoted for three destinations, billing two: the creator who was promised support
		// would never receive it, and the invoice would look fine.
		expect(quoteDisagrees("9.00", 3, [{ amount: 3 }])).toBe(true);
	});

	// Amounts carry cents since the retirement, and both sides are floats. A cent is the
	// finest grain anything can be charged at, so that is the grain of the comparison.
	test("compares in cents rather than by float equality", () => {
		expect(quoteDisagrees("10.50", 3, [{ amount: 7.5 }])).toBe(false);
		expect(quoteDisagrees("4.15", 1.15, [{ amount: 3 }])).toBe(false);
		// A cent apart is a real disagreement and must not be rounded away.
		expect(quoteDisagrees("10.51", 3, [{ amount: 7.5 }])).toBe(true);
	});

	test("an unreadable quote is a disagreement, not a pass", () => {
		// Failing open here would charge on a quote nobody could read.
		expect(quoteDisagrees("", 3, [])).toBe(true);
		expect(quoteDisagrees("not-a-number", 3, [])).toBe(true);
	});

	test("zero on both sides agrees — there is simply nothing to charge", () => {
		expect(quoteDisagrees("0.00", 0, [])).toBe(false);
	});
});

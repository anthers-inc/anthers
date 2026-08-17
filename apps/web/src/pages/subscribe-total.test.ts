// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The amount the signup ceremony quotes, and then charges.
//
// 🚨 **This exists because the page got it wrong for real, in the direction that matters
// most.** `supportTotal` was `1 + directed.length` — a COUNT — and both of its consumers
// take dollars: `GET /subscriptions/preview/:amount` and the `anthersSupport` field on the
// subscribe body. That was correct while a Seed was an indivisible $3 and the server
// multiplied by it, and became wrong the moment the retirement made the server take
// dollars, without anything failing:
//
//   • Anthers + two creators previewed **$3** against a **$9** charge, in the confirmation
//     modal built specifically so a user sees what they are agreeing to.
//   • The same value was sent as `anthersSupport`, subscribing them at **$1 a month** —
//     below the $3 that lifts the Public Access limit they had just paid for. `amountMeets`
//     would then deny them Root, correctly, on an amount the page chose for them.
//
// Neither typechecks as an error: both fields are `number`, and a count is a number.

import { describe, expect, test } from "bun:test";
import { PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { supportTotal } from "./SubscribePage";

const creator = (amount: number) => ({ amount });

describe("what the ceremony quotes", () => {
	test("is dollars, not a count of destinations", () => {
		// The exact case that was wrong: three destinations, $9, previously quoted as 3.
		const total = supportTotal(true, [creator(PUBLIC_ACCESS_PRICE), creator(PUBLIC_ACCESS_PRICE)]);
		expect(total).toBe(PUBLIC_ACCESS_PRICE * 3);
		expect(total).not.toBe(3);
	});

	test("Anthers alone is the Public Access price, and clears its own threshold", () => {
		const total = supportTotal(true, []);
		expect(total).toBe(PUBLIC_ACCESS_PRICE);
		// The point of the ceremony's Anthers step. At the old value of 1 this was false.
		expect(total).toBeGreaterThanOrEqual(PUBLIC_ACCESS_PRICE);
	});

	test("creators alone sum their own amounts, with nothing to Anthers", () => {
		expect(supportTotal(false, [creator(3), creator(7.5)])).toBe(10.5);
		expect(supportTotal(null, [creator(3)])).toBe(3);
	});

	test("nothing chosen is zero, which is what skips the charge entirely", () => {
		// `null` is unanswered and `false` is a decline; neither may quietly bill.
		expect(supportTotal(null, [])).toBe(0);
		expect(supportTotal(false, [])).toBe(0);
	});

	/**
	 * The ceremony fixes creator picks at the Public Access price today, but the field it
	 * feeds accepts any amount, and the Badge ladder that shares this rail carries cents.
	 * Summing rather than counting is what makes an arbitrary amount expressible at all —
	 * a count could only ever have meant multiples of one unit.
	 */
	test("an amount carrying cents survives, because it is summed rather than counted", () => {
		expect(supportTotal(true, [creator(1.5), creator(0.75)])).toBeCloseTo(
			PUBLIC_ACCESS_PRICE + 2.25,
			10,
		);
	});

	test("the Anthers price is read, never assumed, so a change to it moves the quote", () => {
		expect(supportTotal(true, [], 5)).toBe(5);
		expect(supportTotal(true, [creator(2)], 5)).toBe(7);
	});
});

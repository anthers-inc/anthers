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
//
// ⚠️ **The Anthers side became an amount on 2026-08-24**, when that section grew a Badge
// ladder. It was `boolean | null`, which could only ever express the Public Access price —
// so the function substituted `PUBLIC_ACCESS_PRICE` for `true`, and a page offering Sprout
// would have quoted Root while the ladder said otherwise. The substitution is gone: every
// dollar in the total was chosen somewhere in the UI, and the tests below are about the
// arithmetic staying a sum of exactly those choices.

import { describe, expect, test } from "bun:test";
import { ANTHERS_BADGES, PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { supportTotal } from "./SubscribePage";

const creator = (amount: number) => ({ amount });

describe("what the ceremony quotes", () => {
	test("is dollars, not a count of destinations", () => {
		// The exact case that was wrong: three destinations, $9, previously quoted as 3.
		const total = supportTotal(PUBLIC_ACCESS_PRICE, [
			creator(PUBLIC_ACCESS_PRICE),
			creator(PUBLIC_ACCESS_PRICE),
		]);
		expect(total).toBe(PUBLIC_ACCESS_PRICE * 3);
		expect(total).not.toBe(3);
	});

	test("Anthers alone is the amount chosen, and clears its own threshold", () => {
		const total = supportTotal(PUBLIC_ACCESS_PRICE, []);
		expect(total).toBe(PUBLIC_ACCESS_PRICE);
		// The point of the ceremony's Anthers step. At the old value of 1 this was false.
		expect(total).toBeGreaterThanOrEqual(PUBLIC_ACCESS_PRICE);
	});

	/**
	 * 🚨 **The defect the ladder could have shipped.** Every rung above the first was
	 * unreachable while this took a boolean, and the failure mode of adding them without
	 * changing the signature is silent: the page renders Blossom, the charge says Root, and
	 * both are numbers. Driven off `ANTHERS_BADGES` rather than a literal list, so a rung
	 * added to the model is covered here the day it appears.
	 */
	test("every rung on Anthers' ladder reaches the quote at its own amount", () => {
		for (const badge of ANTHERS_BADGES) {
			expect(supportTotal(badge.threshold, [])).toBe(badge.threshold);
		}
		// And the ladder is not one rung wearing four names.
		const quoted = ANTHERS_BADGES.map((b) => supportTotal(b.threshold, []));
		expect(new Set(quoted).size).toBe(ANTHERS_BADGES.length);
	});

	test("a rung rides on the same charge as the creators picked beside it", () => {
		const blossom = ANTHERS_BADGES.at(-1)?.threshold ?? 12;
		expect(supportTotal(blossom, [creator(3), creator(7.5)])).toBe(blossom + 10.5);
	});

	test("creators alone sum their own amounts, with nothing to Anthers", () => {
		expect(supportTotal(0, [creator(3), creator(7.5)])).toBe(10.5);
		expect(supportTotal(null, [creator(3)])).toBe(3);
	});

	test("nothing chosen is zero, which is what skips the charge entirely", () => {
		// `null` is unanswered and `0` is a deliberate Free; neither may quietly bill.
		expect(supportTotal(null, [])).toBe(0);
		expect(supportTotal(0, [])).toBe(0);
	});

	/**
	 * The ceremony fixes creator picks at the Public Access price today, but the field it
	 * feeds accepts any amount, and the Badge ladder that shares this rail carries cents.
	 * Summing rather than counting is what makes an arbitrary amount expressible at all —
	 * a count could only ever have meant multiples of one unit.
	 */
	test("an amount carrying cents survives, because it is summed rather than counted", () => {
		expect(supportTotal(PUBLIC_ACCESS_PRICE, [creator(1.5), creator(0.75)])).toBeCloseTo(
			PUBLIC_ACCESS_PRICE + 2.25,
			10,
		);
		// A creator-set rung need not land on a dollar either; nothing rounds it away.
		expect(supportTotal(7.5, [])).toBe(7.5);
	});
});

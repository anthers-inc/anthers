// SPDX-License-Identifier: Apache-2.0
//
// What the session's own totals say once the address is on it.
//
// 🚨 **The tax-inclusive total is the buyer's to see BEFORE they confirm, and it comes
// from the session rather than from Anthers' arithmetic.** Before this, the button said
// "$X + tax" and only completion knew the number — the buyer confirmed a total they had
// never seen. `updateBillingAddress` resolves the rate onto the session as its own step,
// and `useCheckoutElements()` re-renders with the updated session, so the total and the
// tax figure are read off the session object itself. Nothing is estimated: a null before
// the address resolves is the honest state, not a gap to fill with a guess.
import { describe, expect, test } from "bun:test";
import type { StripeCheckoutSession, StripeCheckoutTaxAmount } from "@stripe/stripe-js";
import { mayConfirm, sessionTotals } from "./useSessionBillingAddress";

// `amount` is a formatted currency string in real Stripe payloads — "$0.80", symbol and
// all — so minorUnitsAmount is derived by stripping the format, exactly as the incident
// test below needs it to be.
const centsFrom = (amount: string) => {
	const digits = amount.replace(/[^0-9.]/g, "");
	return Math.round(Number(digits) * 100);
};

const tax = (amount: string, inclusive: boolean): StripeCheckoutTaxAmount => ({
	minorUnitsAmount: centsFrom(amount),
	amount,
	inclusive,
	displayName: "CO State Tax",
	percentage: 2.9,
});

const session = (
	total: string,
	taxAmounts: StripeCheckoutTaxAmount[] | null,
): StripeCheckoutSession =>
	({
		total: {
			total: { minorUnitsAmount: centsFrom(total), amount: total },
			subtotal: { minorUnitsAmount: 0, amount: "0" },
			taxExclusive: { minorUnitsAmount: 0, amount: "0" },
			taxInclusive: { minorUnitsAmount: 0, amount: "0" },
			discount: { minorUnitsAmount: 0, amount: "0" },
			shippingRate: { minorUnitsAmount: 0, amount: "0" },
			surcharge: { minorUnitsAmount: 0, amount: "0" },
			appliedBalance: { minorUnitsAmount: 0, amount: "0" },
			balanceAppliedToNextInvoice: false,
		},
		taxAmounts,
	}) as unknown as StripeCheckoutSession;

describe("sessionTotals", () => {
	test("reads the tax-inclusive total and the exclusive tax the buyer adds", () => {
		const totals = sessionTotals(session("10.29", [tax("0.29", false)]));
		expect(totals.buyerTotal).toBeCloseTo(10.29);
		expect(totals.tax).toBeCloseTo(0.29);
	});

	test("a session with no address yet has no total — nothing is estimated", () => {
		const totals = sessionTotals(session("10.00", null));
		// The pre-tax total exists, but the tax does not — and the buyer's real total is
		// the tax-inclusive one, so it stays null until the address resolves.
		expect(totals.buyerTotal).toBeCloseTo(10.0);
		expect(totals.tax).toBeNull();
	});

	test("prefers the exclusive tax — US prices are tax-exclusive, so that is what is added", () => {
		const totals = sessionTotals(session("10.29", [tax("0.29", false), tax("0.00", true)]));
		expect(totals.tax).toBeCloseTo(0.29);
	});

	test("a null session is a null total — the button says + tax rather than inventing one", () => {
		const totals = sessionTotals(null);
		expect(totals.buyerTotal).toBeNull();
		expect(totals.tax).toBeNull();
	});

	// 🚨 The live incident (2026-10-03): Stripe's real payload formats `amount` as a
	// currency string — "$10.80" with the symbol in it — and the old code parsed THAT,
	// shipping "Pay $NaN" to production because every fake in this suite returned a bare
	// numeric string. The contract is now minorUnitsAmount (plain cents) converted here,
	// and this case pins it: a symbol-carrying `amount` must not be what the figure comes
	// from, and nothing here may `Number()` the formatted string.
	test("figures come from minorUnitsAmount, never from the currency-formatted amount string", () => {
		const formatted = session("$10.80", [tax("$0.80", false)]);
		const totals = sessionTotals(formatted);
		// $10.80 → 1080 cents → 10.8 dollars, whatever the formatted string looks like.
		expect(Number.isNaN(totals.buyerTotal)).toBe(false);
		expect(totals.buyerTotal).toBeCloseTo(10.8);
		expect(totals.tax).toBeCloseTo(0.8);
	});
});

describe("mayConfirm", () => {
	// 🚨 **The gate: no address on the session, no confirm.** `canConfirm` is Stripe's own
	// readiness and tracks the Payment Element, not our address form — a buyer with a
	// blank address satisfies it. `accepted` is our own record that the session actually
	// took a US address via `updateBillingAddress`, and only both together open the Pay
	// button. This is the predicate the deliberate-break test stubs open.
	test("requires both Stripe's readiness and an accepted address", () => {
		expect(mayConfirm(true, true)).toBe(true);
		expect(mayConfirm(true, false)).toBe(false);
		expect(mayConfirm(false, true)).toBe(false);
		expect(mayConfirm(false, false)).toBe(false);
	});

	test("a ready card with no address stays gated — the defect this exists for", () => {
		// Stripe reports the Payment Element ready the moment it mounts. Without the
		// address half, that alone must not open the Pay button.
		expect(mayConfirm(true, false)).toBe(false);
	});

	test("an accepted address with no card stays gated too", () => {
		expect(mayConfirm(false, true)).toBe(false);
	});
});

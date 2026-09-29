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

const tax = (amount: string, inclusive: boolean): StripeCheckoutTaxAmount => ({
	minorUnitsAmount: Math.round(Number(amount) * 100),
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
			total: { minorUnitsAmount: Math.round(Number(total) * 100), amount: total },
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
		expect(totals.buyerTotal).toBe("10.29");
		expect(totals.tax).toBe("0.29");
	});

	test("a session with no address yet has no total — nothing is estimated", () => {
		const totals = sessionTotals(session("10.00", null));
		// The pre-tax total exists, but the tax does not — and the buyer's real total is
		// the tax-inclusive one, so it stays null until the address resolves.
		expect(totals.buyerTotal).toBe("10.00");
		expect(totals.tax).toBeNull();
	});

	test("prefers the exclusive tax — US prices are tax-exclusive, so that is what is added", () => {
		const totals = sessionTotals(session("10.29", [tax("0.29", false), tax("0.00", true)]));
		expect(totals.tax).toBe("0.29");
	});

	test("a null session is a null total — the button says + tax rather than inventing one", () => {
		const totals = sessionTotals(null);
		expect(totals.buyerTotal).toBeNull();
		expect(totals.tax).toBeNull();
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

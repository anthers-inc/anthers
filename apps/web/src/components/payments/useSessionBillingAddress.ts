// SPDX-License-Identifier: Apache-2.0

import type { StripeUseCheckoutElementsResult } from "@stripe/react-stripe-js/checkout";
import type {
	StripeCheckoutContact,
	StripeCheckoutSession,
	StripeCheckoutUpdateAddressResult,
} from "@stripe/stripe-js";
import { useCallback, useState } from "react";
import {
	EMPTY_ADDRESS,
	isAddressComplete,
	toCheckoutContact,
	type UsAddressInput,
} from "./UsBillingAddressForm";

/** What `useSessionBillingAddress` exposes to a purchase surface. */
export interface SessionBillingAddress {
	/** The buyer's typed fields — owned here so both purchase surfaces share one state. */
	address: UsAddressInput;
	setAddress: (next: UsAddressInput) => void;
	/** Submit the address to the session as its own step (`updateBillingAddress`). */
	submitAddress: () => Promise<boolean>;
	/** True once the session accepted the address — the tax resolved against something. */
	accepted: boolean;
	/** Why submission failed, in the buyer's words rather than Stripe's. */
	error: string | null;
	/** True while the session is resolving the address. */
	updating: boolean;
}

/**
 * Whether a purchase surface may let the buyer confirm: Stripe's own Payment Element
 * readiness AND our record that the session took a US address. Neither implies the
 * other — `canConfirm` alone let a buyer with a blank address through, which is the
 * defect this gate exists for.
 */
export function mayConfirm(stripeCanConfirm: boolean, addressAccepted: boolean): boolean {
	return stripeCanConfirm && addressAccepted;
}

/**
 * The address step a Checkout session's tax resolves from — the shared half of every
 * purchase surface, so a purchase form only supplies its own receipt and Pay button.
 *
 * The address is submitted to the session BEFORE the buyer confirms, as its own step:
 * `updateBillingAddress` writes the contact onto the session, Stripe Tax resolves the
 * rate from it, and the session re-renders through `useCheckoutElements()` — which is
 * how the buyer sees the tax-inclusive total before they pay rather than after.
 *
 * 🚨 **Confirm is gated on `accepted`, not on `canConfirm` alone.** `canConfirm` is
 * Stripe's own notion of readiness and tracks the Payment Element, not our address form
 * — a buyer with a blank address can satisfy it. `accepted` flips only when the session
 * has actually taken the address, so a buyer cannot pay without a resolvable US address
 * on the session.
 */
export function useSessionBillingAddress(
	checkoutState: StripeUseCheckoutElementsResult,
): SessionBillingAddress {
	const [address, setAddress] = useState<UsAddressInput>(EMPTY_ADDRESS);
	const [accepted, setAccepted] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [updating, setUpdating] = useState(false);

	const submitAddress = useCallback(async (): Promise<boolean> => {
		if (checkoutState.type !== "success") return false;
		if (!isAddressComplete(address)) {
			setError("Enter your full billing address — sales tax is calculated from it.");
			return false;
		}
		setUpdating(true);
		setError(null);
		try {
			const contact: StripeCheckoutContact = toCheckoutContact(address);
			const result: StripeCheckoutUpdateAddressResult =
				await checkoutState.checkout.updateBillingAddress(contact);
			if (result.type === "error") {
				setAccepted(false);
				setError(result.error.message || "That address didn't work. Please check it and retry.");
				return false;
			}
			setAccepted(true);
			return true;
		} catch {
			setAccepted(false);
			setError("We couldn't save your address. Please try again.");
			return false;
		} finally {
			setUpdating(false);
		}
	}, [checkoutState, address]);

	return { address, setAddress, submitAddress, accepted, error, updating };
}

/**
 * What the session's own totals say once the address is on it — the tax-inclusive total
 * and the tax figure, read from the session object `useCheckoutElements()` re-renders
 * with. Null before the address resolves: the session has not resolved a rate yet, and a
 * guessed figure is the flat-rate charge this flow exists to retire.
 *
 * `StripeCheckoutAmount` is `{ minorUnitsAmount, amount }` — `amount` is a formatted
 * string in the session's currency, so it is what a receipt renders and a button quotes.
 */
export function sessionTotals(
	session: Pick<StripeCheckoutSession, "total" | "taxAmounts"> | null,
): { buyerTotal: string | null; tax: string | null } {
	if (!session) return { buyerTotal: null, tax: null };
	const total = session.total?.total?.amount;
	if (!total) return { buyerTotal: null, tax: null };
	// Exclusive tax is what US prices carry (the session builds its line items
	// `tax_behavior: "exclusive"`), so the tax the buyer adds on top is the exclusive
	// figure. Inclusive tax is inside the price already and adds nothing.
	const tax =
		session.taxAmounts?.find((t) => !t.inclusive)?.amount ??
		session.taxAmounts?.[0]?.amount ??
		null;
	return { buyerTotal: total, tax };
}

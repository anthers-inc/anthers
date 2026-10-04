// SPDX-License-Identifier: Apache-2.0

import type { StripeUseCheckoutElementsResult } from "@stripe/react-stripe-js/checkout";
import type {
	StripeCheckoutContact,
	StripeCheckoutSession,
	StripeCheckoutUpdateAddressResult,
} from "@stripe/stripe-js";
import { useCallback, useEffect, useRef, useState } from "react";
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
	/**
	 * The address value the session last accepted — what the summary line shows and what
	 * an edit re-resolves from. Null before the first resolution.
	 */
	acceptedAddress: UsAddressInput | null;
	/** True once the session accepted the address — the tax resolved against something. */
	accepted: boolean;
	/** Why a resolution failed, in the buyer's words rather than Stripe's. */
	error: string | null;
	/** True while the session is resolving the address. */
	updating: boolean;
}

/**
 * How long an address must sit unchanged before the session is asked to resolve tax
 * from it — one resolution per settled edit, never per keystroke. Exported so the test
 * suites wait on the real value rather than a copy of it.
 */
export const TAX_RESOLVE_DEBOUNCE_MS = 600;

/**
 * Whether a purchase surface may let the buyer confirm: Stripe's own Payment Element
 * readiness AND our record that the session took a US address. Neither implies the
 * other — `canConfirm` alone let a buyer with a blank address through, which is the
 * defect this gate exists for.
 */
export function mayConfirm(stripeCanConfirm: boolean, addressAccepted: boolean): boolean {
	return stripeCanConfirm && addressAccepted;
}

/** A comparable identity for a contact — the settled value the session was asked for. */
function contactKey(address: UsAddressInput): string {
	return JSON.stringify(toCheckoutContact(address));
}

/**
 * The address step a Checkout session's tax resolves from — the shared half of every
 * purchase surface, so a purchase form only supplies its own receipt and Pay button.
 *
 * 🚨 **Tax resolves AUTOMATICALLY from the typed address — there is no button for it.**
 * (Parker, 2026-10-03: "you shouldn't have to click a button to calculate tax, it should
 * do it automatically when you enter your address. The only button you click is the
 * button to complete the purchase.") As the buyer types, each settled edit that leaves a
 * complete, well-formed US address is written onto the session (`updateBillingAddress`)
 * after the debounce below; Stripe Tax resolves the rate and the session re-renders
 * through `useCheckoutElements()` — which is how the buyer sees the tax-inclusive total
 * before they pay rather than after. An incomplete address never fires: the timer only
 * arms once `isAddressComplete` is true, so a half-typed ZIP cannot spam the session.
 * `updateBillingAddress` failing keeps every typed field on screen with the server's own
 * message, and editing again re-arms the resolution.
 *
 * 🚨 **Confirm is gated on `accepted`, not on `canConfirm` alone.** `canConfirm` is
 * Stripe's own notion of readiness and tracks the Payment Element, not our address form
 * — a buyer with a blank address can satisfy it. `accepted` flips only when the session
 * has actually taken the address, so a buyer cannot pay without a resolvable US address
 * on the session. While the buyer edits an already-accepted address the session still
 * holds the previous one — the totals shown are the session's own, so what the Pay
 * button offers is exactly what the charge would be until the new value lands.
 */
export function useSessionBillingAddress(
	checkoutState: StripeUseCheckoutElementsResult,
): SessionBillingAddress {
	const [address, setAddress] = useState<UsAddressInput>(EMPTY_ADDRESS);
	const [accepted, setAccepted] = useState(false);
	const [acceptedAddress, setAcceptedAddress] = useState<UsAddressInput | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [updating, setUpdating] = useState(false);

	// The session object `useCheckoutElements()` re-renders with a fresh identity on every
	// tick, so the resolve effect below must not name it as a dependency — it would
	// re-arm on every tick. The latest session object is read through this ref at fire
	// time instead; this effect keeps it current on every commit.
	// 🚨 The ref is typed from the hook's own SUCCESS branch — `Extract` picks the
	// merged value the hook actually returns (session state AND the update actions,
	// `updateBillingAddress` among them). Typing it as the narrow `StripeCheckoutSession`
	// does not compile against the real package types: the action lives on the SDK
	// object, not the session interface. (CI caught exactly this — a hand-patched local
	// `node_modules` copy of stripe-js's types, widening the session interface to carry
	// the action, let the wrong typecheck pass locally while the fresh CI install
	// failed it. Found 2026-10-04 on PR #348.)
	const checkoutRef = useRef<Extract<StripeUseCheckoutElementsResult, { type: "success" }>["checkout"] | null>(null);
	useEffect(() => {
		checkoutRef.current = checkoutState.type === "success" ? checkoutState.checkout : null;
	});
	// Whether the Checkout session is mounted at all — flipping true re-arms an address
	// resolve that fired before the session existed (a buyer who types fast while the
	// client secret is still loading must not lose their resolution).
	const checkoutReady = checkoutState.type === "success";

	// One resolution in flight at a time — an edit landing mid-request must not stack a
	// second `updateBillingAddress` on top; the completing request updates state, whose
	// change re-arms the effect for the newer value.
	const resolvingRef = useRef(false);

	const resolveAddress = useCallback(
		async (contact: StripeCheckoutContact, origin: UsAddressInput): Promise<boolean> => {
			const checkout = checkoutRef.current;
			if (!checkout || resolvingRef.current) return false;
			resolvingRef.current = true;
			setUpdating(true);
			setError(null);
			try {
				const result: StripeCheckoutUpdateAddressResult =
					await checkout.updateBillingAddress(contact);
				if (result.type === "error") {
					setAccepted(false);
					// The server's (or Stripe's) own sentence — never a paraphrase. The typed
					// fields stay exactly as the buyer left them.
					setError(result.error.message || "That address didn't work. Please check it and retry.");
					return false;
				}
				setAccepted(true);
				setAcceptedAddress(origin);
				return true;
			} catch {
				setAccepted(false);
				setError("We couldn't update your address. Please try again.");
				return false;
			} finally {
				resolvingRef.current = false;
				setUpdating(false);
			}
		},
		[],
	);

	// The two deps Biome would drop — `checkoutReady` and `updating` at the bottom of the
	// array — are the debounce's re-arm triggers, not values the body reads: the session
	// object arriving late must re-fire a resolve that happened without it, and a settle
	// must re-fire a queued edit. `useExhaustiveDependencies` cannot see either, so:
	// biome-ignore lint/correctness/useExhaustiveDependencies: unread deps are the timer's re-arm triggers
	useEffect(() => {
		// 🚨 Never fires while the buyer is mid-edit on an incomplete address — the whole
		// effect returns before a timer exists unless the address is complete AND
		// well-formed (`isAddressComplete` shape-checks the ZIP). Each keystroke resets
		// the timer, so one settled edit produces exactly one resolution.
		if (!isAddressComplete(address)) return;
		const contact = toCheckoutContact(address);
		// Already on the session: the accepted value and the typed value agree, so there
		// is nothing to resolve — without this guard every effect re-run (an edit that
		// resolved, a session tick) would re-fire the same request forever.
		if (accepted && acceptedAddress != null && contactKey(acceptedAddress) === contactKey(address))
			return;
		const timer = setTimeout(() => {
			void resolveAddress(contact, address);
		}, TAX_RESOLVE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
		// Re-arm triggers beyond the values read above: `checkoutReady` (the session
		// object arriving — a resolve refused before it existed must fire once it does,
		// so a buyer who types faster than the client secret loads keeps their address)
		// and `updating` (a resolution settling — an edit queued behind an in-flight one
		// fires on the settle). Neither is read as a value in this body; both are the
		// timer's triggers, deliberately. See the hook's doc block too.
	}, [address, accepted, acceptedAddress, checkoutReady, resolveAddress, updating]);

	return { address, setAddress, acceptedAddress, accepted, error, updating };
}

/**
 * What the session's own totals say once the address is on it — the tax-inclusive total
 * and the tax figure, read from the session object `useCheckoutElements()` re-renders
 * with. Null before the address resolves: the session has not resolved a rate yet, and a
 * guessed figure is the flat-rate charge this flow exists to retire.
 *
 * 🚨 **Rendered from `minorUnitsAmount`, NEVER from `amount`.** `StripeCheckoutAmount` is
 * `{ minorUnitsAmount, amount }` where `amount` is a FORMATTED string in the session's
 * currency — `"$10.80"` with the symbol in it — and every consumer of these figures does
 * `Number(...)` on the string. `Number("$10.80")` is `NaN`, which is exactly the "Pay $NaN"
 * the live checkout shipped on 2026-10-03: the fakes in the test suites return bare
 * numeric strings, so no suite caught that Stripe's real payload is currency-formatted.
 * `minorUnitsAmount` is the plain integer of cents — unambiguous, symbol-free — so it is
 * converted here, once, and the callers receive a number of dollars they can format.
 */
export function sessionTotals(
	session: Pick<StripeCheckoutSession, "total" | "taxAmounts"> | null,
): { buyerTotal: number | null; tax: number | null } {
	if (!session) return { buyerTotal: null, tax: null };
	const totalCents = session.total?.total?.minorUnitsAmount;
	if (totalCents == null) return { buyerTotal: null, tax: null };
	// Exclusive tax is what US prices carry (the session builds its line items
	// `tax_behavior: "exclusive"`), so the tax the buyer adds on top is the exclusive
	// figure. Inclusive tax is inside the price already and adds nothing.
	const taxCents =
		session.taxAmounts?.find((t) => !t.inclusive)?.minorUnitsAmount ??
		session.taxAmounts?.[0]?.minorUnitsAmount ??
		null;
	return { buyerTotal: totalCents / 100, tax: taxCents == null ? null : taxCents / 100 };
}

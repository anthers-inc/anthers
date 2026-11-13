// SPDX-License-Identifier: Apache-2.0
import type { StripeUseCheckoutElementsResult } from "@stripe/react-stripe-js/checkout";
import type { StripeCheckoutContact, StripeCheckoutUpdateAddressResult } from "@stripe/stripe-js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	EMPTY_ADDRESS,
	isAddressComplete,
	toCheckoutContact,
	type UsAddressInput,
} from "./UsBillingAddressForm";
import { type SessionBillingAddress, TAX_RESOLVE_DEBOUNCE_MS } from "./useSessionBillingAddress";

/** What the cart's delivery block reads. */
export interface SessionShippingAddress {
	/** Whether the parcel goes to the billing address. */
	sameAsBilling: boolean;
	/** Choose the billing address or a separate delivery address. */
	setSameAsBilling: (next: boolean) => void;
	address: UsAddressInput;
	setAddress: (next: UsAddressInput) => void;
	/** True once the session accepted a delivery address. */
	accepted: boolean;
	acceptedAddress: UsAddressInput | null;
	error: string | null;
	updating: boolean;
}

function contactKey(address: UsAddressInput): string {
	return JSON.stringify(toCheckoutContact(address));
}

/**
 * The delivery address a physical cart resolves through the session.
 *
 * **Only physical carts mount this, and only they gate confirm on it.** With "same as
 * billing" on, the accepted billing address is pushed to `updateShippingAddress` whenever
 * it changes, so there is one address to type and the tax resolves from the place the
 * parcel goes. Unchecking it reveals a separate US shipping `AddressElement`; its settled
 * edits are written the same way. The server set `shipping_address_collection` on a
 * physical session, and `customer_update.shipping: "auto"` lets Stripe write the delivery
 * address to the Customer while the saved billing address stays the one settings owns.
 */
export function useSessionShippingAddress({
	checkoutState,
	billing,
	enabled,
}: {
	checkoutState: StripeUseCheckoutElementsResult;
	billing: SessionBillingAddress;
	enabled: boolean;
}): SessionShippingAddress {
	const [sameAsBilling, setSameAsBillingState] = useState(true);
	const [address, setAddress] = useState<UsAddressInput>(EMPTY_ADDRESS);
	const [accepted, setAccepted] = useState(false);
	const [acceptedAddress, setAcceptedAddress] = useState<UsAddressInput | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [updating, setUpdating] = useState(false);
	const checkoutRef = useRef<
		Extract<StripeUseCheckoutElementsResult, { type: "success" }>["checkout"] | null
	>(null);
	const resolvingRef = useRef(false);
	// Whether the session exists yet; a resolve that fired before it must re-arm once it does.
	const checkoutReady = checkoutState.type === "success";

	useEffect(() => {
		checkoutRef.current = checkoutState.type === "success" ? checkoutState.checkout : null;
	});

	const resolve = useCallback(
		async (contact: StripeCheckoutContact, origin: UsAddressInput): Promise<boolean> => {
			const checkout = checkoutRef.current;
			if (!checkout || resolvingRef.current) return false;
			resolvingRef.current = true;
			setUpdating(true);
			setError(null);
			try {
				const result: StripeCheckoutUpdateAddressResult =
					await checkout.updateShippingAddress(contact);
				if (result.type === "error") {
					setAccepted(false);
					setError(result.error.message || "That delivery address didn't work. Please check it.");
					return false;
				}
				setAccepted(true);
				setAcceptedAddress(origin);
				return true;
			} catch {
				setAccepted(false);
				setError("We couldn't update the delivery address. Please try again.");
				return false;
			} finally {
				resolvingRef.current = false;
				setUpdating(false);
			}
		},
		[],
	);

	const setSameAsBilling = (next: boolean) => {
		setSameAsBillingState(next);
		setAccepted(false);
		setError(null);
	};

	useEffect(() => {
		if (!enabled) {
			setAccepted(true);
			setError(null);
			return;
		}
		if (!checkoutReady) return;
		if (!sameAsBilling) return;
		if (!billing.accepted || !billing.acceptedAddress) {
			setAccepted(false);
			return;
		}
		void resolve(toCheckoutContact(billing.acceptedAddress), billing.acceptedAddress);
	}, [enabled, sameAsBilling, billing.accepted, billing.acceptedAddress, resolve, checkoutReady]);

	useEffect(() => {
		if (!enabled || sameAsBilling) return;
		if (!checkoutReady) return;
		if (!isAddressComplete(address)) return;
		const contact = toCheckoutContact(address);
		if (accepted && acceptedAddress && contactKey(acceptedAddress) === contactKey(address)) return;
		const timer = setTimeout(() => {
			void resolve(contact, address);
		}, TAX_RESOLVE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [enabled, sameAsBilling, address, accepted, acceptedAddress, resolve, checkoutReady]);

	return {
		sameAsBilling,
		setSameAsBilling,
		address,
		setAddress,
		accepted,
		acceptedAddress,
		error,
		updating,
	};
}

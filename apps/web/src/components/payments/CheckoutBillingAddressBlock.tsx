// SPDX-License-Identifier: Apache-2.0
/**
 * The billing address block on a purchase surface: Stripe's advanced `AddressElement` in
 * billing mode, restricted to the US, resolving tax automatically as the buyer types and
 * STAYING OPEN (Parker, 2026-10-04: the post-fill collapse was disorienting; the buyer sees
 * their address through the whole purchase and gets a checkmark once the tax resolved from
 * it).
 *
 * 🚨 **Why this is the advanced element and not the Checkout one.** The Checkout-flavored
 * `BillingAddressElement` offers no `allowedCountries`, so a buyer could choose any country
 * it offers and only the server-side completion path would refuse it. The advanced
 * `AddressElement` in billing mode does support `allowedCountries: ["US"]`, and its value
 * feeds `checkout.updateBillingAddress` through the shared hook, so the US boundary stays
 * client-side and the buyer gets Stripe's autocomplete and validation.
 *
 * There is NO submit button here (Parker, 2026-10-03: "the only button you click is the
 * button to complete the purchase") — the block is an owned `<div>`, never a `<form>`,
 * because a purchase surface's only `<form>` is the checkout's own, whose submit is the
 * Pay button. Tax resolution lives in `useSessionBillingAddress`: once the typed address
 * is complete and settled, it is written to the session and Stripe Tax resolves the rate;
 * `accepted` carries the checkmark.
 */
import type { SavedBillingAddress } from "@anthers/web-shared/types";
import { AddressElement, Elements } from "@stripe/react-stripe-js";
import type { StripeAddressElementChangeEvent } from "@stripe/stripe-js";
import { useMemo } from "react";
import { getStripe } from "../../lib/stripe";
import { stripeAppearance } from "../../lib/stripeCard";
import type { UsAddressInput } from "./UsBillingAddressForm";
import type { SavedPrefill } from "./useSavedBillingAddress";
import type { SessionBillingAddress } from "./useSessionBillingAddress";

/** The element's value in the form shape the tax hook owns. */
function addressFromValue(value: StripeAddressElementChangeEvent["value"]): UsAddressInput {
	return {
		name: value.name,
		line1: value.address.line1 ?? "",
		line2: value.address.line2 ?? "",
		city: value.address.city ?? "",
		state: value.address.state ?? "",
		postalCode: value.address.postal_code ?? "",
	};
}

/** The saved address in the element's mount-time defaults. */
function addressDefaults(prefill: SavedPrefill) {
	if (!prefill) return undefined;
	return {
		name: prefill.name,
		address: {
			line1: prefill.line1,
			line2: prefill.line2 ?? "",
			city: prefill.city,
			state: prefill.state,
			postal_code: prefill.postalCode,
			country: "US",
		},
	};
}

export default function CheckoutBillingAddressBlock({
	billing,
	prefill,
}: {
	billing: SessionBillingAddress;
	/** The saved address, or null when none; `undefined` while the fetch is still in flight. */
	prefill: SavedPrefill;
}) {
	const { setAddress, accepted, error, updating } = billing;
	const appearance = useMemo(stripeAppearance, []);
	const options = useMemo(
		() => ({
			mode: "billing" as const,
			allowedCountries: ["US" as const],
			fields: { phone: "never" as const },
			defaultValues: addressDefaults(prefill),
		}),
		[prefill],
	);

	// The element has no imperative prefill; gate its mount on the saved-address fetch so
	// the defaults are applied once, from the value the buyer will see.
	if (prefill === undefined) {
		return (
			<div className="border border-base-300 rounded-lg p-3 bg-base-100">
				<div className="skeleton h-4 w-32" />
				<div className="mt-3 flex flex-col gap-2">
					<div className="skeleton h-10 w-full" />
					<div className="skeleton h-10 w-full" />
					<div className="skeleton h-10 w-2/3" />
				</div>
			</div>
		);
	}

	return (
		<div className="border border-base-300 rounded-lg p-3 bg-base-100">
			<div className="flex items-center justify-between mb-2">
				<span className="font-semibold text-sm">Billing address</span>
				{/* The checkmark IS the "the session took it" moment: tax resolved against
				    this address, and the buyer's total is real. `accepted` flips only on a
				    successful `updateBillingAddress` — see the hook. */}
				{accepted && (
					<span
						className="inline-flex items-center gap-1 text-success text-xs font-medium"
						data-testid="billing-address-accepted"
					>
						<svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
							<path
								fillRule="evenodd"
								d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
								clipRule="evenodd"
							/>
						</svg>
						Tax calculated
					</span>
				)}
			</div>
			<div data-testid="billing-address-form">
				<Elements stripe={getStripe()} options={{ appearance }}>
					<AddressElement
						options={options}
						onChange={(event) => setAddress(addressFromValue(event.value))}
					/>
				</Elements>
			</div>
			{updating && (
				<p className="text-base-content/60 text-xs mt-2" data-testid="tax-resolving">
					Calculating tax…
				</p>
			)}
			{error && (
				<p className="text-error text-xs mt-2" data-testid="billing-address-error">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * The typed address a purchase surface resolves from — re-exported so a consumer that
 * formats an address for elsewhere (a summary line, a receipt) keeps one `formatAddress`.
 */
export type { SavedBillingAddress, UsAddressInput };

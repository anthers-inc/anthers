// SPDX-License-Identifier: Apache-2.0
/**
 * The delivery address block on a cart that contains a physical good.
 *
 * A physical charge is the only kind whose tax and shipping depend on where the parcel
 * goes, so this block is mounted only when the cart has a physical line. "Ship to my
 * billing address" is the default and uses the address the billing block already
 * accepted; unchecking it reveals a US-only shipping `AddressElement`, whose settled
 * value is written through `checkout.updateShippingAddress`. The confirmation gate waits
 * on that acceptance, the same way it waits on the billing address.
 */
import { AddressElement, Elements } from "@stripe/react-stripe-js";
import type { StripeAddressElementChangeEvent } from "@stripe/stripe-js";
import { useMemo } from "react";
import { getStripe } from "../../lib/stripe";
import { stripeAppearance } from "../../lib/stripeCard";
import type { UsAddressInput } from "./UsBillingAddressForm";
import type { SessionShippingAddress } from "./useSessionShippingAddress";

function addressDefaults(address: UsAddressInput | null) {
	if (!address) return undefined;
	return {
		name: address.name,
		address: {
			line1: address.line1,
			line2: address.line2 ?? "",
			city: address.city,
			state: address.state,
			postal_code: address.postalCode,
			country: "US",
		},
	};
}

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

export default function CheckoutShippingAddressBlock({
	shipping,
	billingAddress,
}: {
	shipping: SessionShippingAddress;
	billingAddress: UsAddressInput | null;
}) {
	const appearance = useMemo(stripeAppearance, []);
	const options = useMemo(
		() => ({
			mode: "shipping" as const,
			allowedCountries: ["US" as const],
			fields: { phone: "never" as const },
			defaultValues: addressDefaults(billingAddress),
		}),
		[billingAddress],
	);

	return (
		<div className="border border-base-300 rounded-lg p-3 bg-base-100">
			<div className="flex items-center justify-between gap-3">
				<label className="label cursor-pointer justify-start gap-2 p-0">
					<input
						type="checkbox"
						className="checkbox checkbox-sm"
						checked={shipping.sameAsBilling}
						onChange={(event) => {
							// Unchecking starts the separate form from the billing address, so the
							// buyer edits what they already typed rather than an empty set of fields.
							if (!event.target.checked && billingAddress) shipping.setAddress(billingAddress);
							shipping.setSameAsBilling(event.target.checked);
						}}
					/>
					<span className="label-text text-sm font-semibold">Ship to my billing address</span>
				</label>
				{shipping.accepted && (
					<span
						className="inline-flex items-center gap-1 text-success text-xs font-medium"
						data-testid="shipping-address-accepted"
					>
						<svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
							<path
								fillRule="evenodd"
								d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
								clipRule="evenodd"
							/>
						</svg>
						Delivery set
					</span>
				)}
			</div>
			{!shipping.sameAsBilling && (
				<div className="mt-3" data-testid="shipping-address-form">
					<Elements stripe={getStripe()} options={{ appearance }}>
						<AddressElement
							options={options}
							onChange={(event) => shipping.setAddress(addressFromValue(event.value))}
						/>
					</Elements>
				</div>
			)}
			{shipping.updating && (
				<p className="text-base-content/60 text-xs mt-2" data-testid="shipping-resolving">
					Calculating delivery…
				</p>
			)}
			{shipping.error && (
				<p className="text-error text-xs mt-2" data-testid="shipping-address-error">
					{shipping.error}
				</p>
			)}
		</div>
	);
}

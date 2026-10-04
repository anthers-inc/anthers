// SPDX-License-Identifier: Apache-2.0
import type { StripeCheckoutContact } from "@stripe/stripe-js";
import { useState } from "react";

/**
 * The US states, DC and the armed-forces codes — what a `<select>` needs and nothing more.
 * No territories are listed: they are US-flag codes in some contexts but sales-tax nexus
 * is their own, and the posture names the fifty states plus DC as the launch market.
 */
export const US_STATES: { code: string; name: string }[] = [
	{ code: "AL", name: "Alabama" },
	{ code: "AK", name: "Alaska" },
	{ code: "AZ", name: "Arizona" },
	{ code: "AR", name: "Arkansas" },
	{ code: "CA", name: "California" },
	{ code: "CO", name: "Colorado" },
	{ code: "CT", name: "Connecticut" },
	{ code: "DE", name: "Delaware" },
	{ code: "DC", name: "District of Columbia" },
	{ code: "FL", name: "Florida" },
	{ code: "GA", name: "Georgia" },
	{ code: "HI", name: "Hawaii" },
	{ code: "ID", name: "Idaho" },
	{ code: "IL", name: "Illinois" },
	{ code: "IN", name: "Indiana" },
	{ code: "IA", name: "Iowa" },
	{ code: "KS", name: "Kansas" },
	{ code: "KY", name: "Kentucky" },
	{ code: "LA", name: "Louisiana" },
	{ code: "ME", name: "Maine" },
	{ code: "MD", name: "Maryland" },
	{ code: "MA", name: "Massachusetts" },
	{ code: "MI", name: "Michigan" },
	{ code: "MN", name: "Minnesota" },
	{ code: "MS", name: "Mississippi" },
	{ code: "MO", name: "Missouri" },
	{ code: "MT", name: "Montana" },
	{ code: "NE", name: "Nebraska" },
	{ code: "NV", name: "Nevada" },
	{ code: "NH", name: "New Hampshire" },
	{ code: "NJ", name: "New Jersey" },
	{ code: "NM", name: "New Mexico" },
	{ code: "NY", name: "New York" },
	{ code: "NC", name: "North Carolina" },
	{ code: "ND", name: "North Dakota" },
	{ code: "OH", name: "Ohio" },
	{ code: "OK", name: "Oklahoma" },
	{ code: "OR", name: "Oregon" },
	{ code: "PA", name: "Pennsylvania" },
	{ code: "RI", name: "Rhode Island" },
	{ code: "SC", name: "South Carolina" },
	{ code: "SD", name: "South Dakota" },
	{ code: "TN", name: "Tennessee" },
	{ code: "TX", name: "Texas" },
	{ code: "UT", name: "Utah" },
	{ code: "VT", name: "Vermont" },
	{ code: "VA", name: "Virginia" },
	{ code: "WA", name: "Washington" },
	{ code: "WV", name: "West Virginia" },
	{ code: "WI", name: "Wisconsin" },
	{ code: "WY", name: "Wyoming" },
];

/**
 * The buyer's address, as the buyer typed it — every field a US street address has and no
 * country field at all, because the country is `US` by construction rather than by choice.
 */
export interface UsAddressInput {
	/** Name on the card. The Checkout session's contact shape carries it, so we ask. */
	name: string;
	line1: string;
	line2: string;
	city: string;
	/** A two-letter state code from the `<select>` — never free text. */
	state: string;
	/** ZIP. Five digits is the floor of what US tax resolution needs; ZIP+4 is welcome. */
	postalCode: string;
}

export const EMPTY_ADDRESS: UsAddressInput = {
	name: "",
	line1: "",
	line2: "",
	city: "",
	state: "",
	postalCode: "",
};

/**
 * Is this ZIP shaped like a US ZIP — `12345` or `12345-6789`?
 */
function isUsZip(zip: string): boolean {
	return /^\d{5}(-\d{4})?$/.test(zip.trim());
}

/**
 * The five-digit ZIP tax resolution needs, from whatever the buyer typed.
 *
 * 🚨 **Five digits is what goes to the session, whatever the field holds.** A ZIP+4 is
 * welcome in the input (it is what a password manager often autofills, and letting the
 * buyer type it beats refusing it), but Stripe Tax resolves from the five-digit code and
 * the purchase row's `buyerPostalCode` is read back as one — so the +4 suffix is
 * stripped here, at the boundary to the session, rather than anywhere a reader would
 * have to remember to do it again. `80202-1234` → `80202`; anything else passes through
 * trimmed and is refused by the shape check before it gets this far.
 */
export function zipForTax(postalCode: string): string {
	return postalCode.trim().replace(/-\d{4}$/, "");
}

/**
 * Is this address complete enough to resolve tax from — every field the Checkout session
 * needs, non-empty and well-formed? The parts of the check a buyer could typo into are
 * shape checks (the ZIP); the parts they could only choose wrong are structural (the
 * state comes from our own list, so a value outside it means a tampered form, not a
 * mistake).
 */
export function isAddressComplete(address: UsAddressInput): boolean {
	return (
		address.name.trim() !== "" &&
		address.line1.trim() !== "" &&
		address.city.trim() !== "" &&
		US_STATES.some((s) => s.code === address.state) &&
		isUsZip(address.postalCode)
	);
}

/**
 * Build the contact object `updateBillingAddress` takes. `country` is a literal — the form
 * has no way to enter anything else, so a non-US address cannot be produced here. This is
 * the whole fix: Stripe's Checkout Billing Address Element offers no country allow-list,
 * so a determined buyer could pick any country it offers and complete a charge the
 * server would then refuse by hand; Anthers' own form makes the US the only thing there
 * is to submit.
 */
export function toCheckoutContact(address: UsAddressInput): StripeCheckoutContact {
	return {
		name: address.name.trim(),
		address: {
			country: "US",
			line1: address.line1.trim(),
			line2: address.line2.trim() || null,
			city: address.city.trim(),
			state: address.state,
			// Five digits — see `zipForTax`; the +4 a buyer typed never reaches the session.
			postal_code: zipForTax(address.postalCode),
		},
	};
}

/**
 * One line of a resolved address, for the editable block after the session accepted it.
 */
export function formatAddress(address: UsAddressInput): string {
	const line2 = address.line2.trim() ? ` ${address.line2.trim()}` : "";
	return `${address.name.trim()}, ${address.line1.trim()}${line2}, ${address.city.trim()}, ${address.state} ${address.postalCode.trim()}`;
}

interface UsBillingAddressFormProps {
	/** Where the buyer's typed fields live — the parent owns the form state. */
	value: UsAddressInput;
	onChange: (next: UsAddressInput) => void;
}

const inputClass = "input input-bordered w-full";
const labelClass = "form-control";

/**
 * The US billing address a purchase's sales tax resolves from — Anthers' own form, not
 * Stripe's Billing Address Element.
 *
 * The Checkout-flavored element supports only `contacts` and `display`, no
 * `allowedCountries`, so a buyer could select any country it offers and only the
 * server-side completion path would refuse the charge — after the money moved, leaving
 * rows `pending` for a hand refund. This form is US by construction instead: there is no
 * country field to set, and the state is a `<select>` of US states, so a non-US address
 * cannot be produced from the purchase surfaces at all.
 *
 * The address is submitted to the Checkout session as its own step
 * (`checkout.updateBillingAddress`) before the buyer confirms, which is what makes the
 * session resolve — and show — the real tax-inclusive total.
 */
export default function UsBillingAddressForm({ value, onChange }: UsBillingAddressFormProps) {
	const [touched, setTouched] = useState(false);
	const set =
		(field: keyof UsAddressInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
			onChange({ ...value, [field]: e.target.value });

	return (
		<div className="flex flex-col gap-3">
			{/* 🚨 Every field carries BOTH a `name` and a full `autocomplete` token.
			    Bitwarden (and every password manager) keys on the pair: 2026-10-03's live
			    checkout filled only Address line 1 — Name on Card, City and State stayed
			    empty — because these three had no `name` attribute and, for the state
			    `<select>`, no token at all. The tokens are the WHAT-WAS-TYPED-HERE
			    contract; a missing one is an unfilled field, not a style nit. */}
			<label className={labelClass}>
				<span className="label-text mb-1">Name on card</span>
				<input
					className={inputClass}
					name="cc-name"
					autoComplete="cc-name"
					value={value.name}
					onChange={set("name")}
					onBlur={() => setTouched(true)}
					required
				/>
			</label>
			<label className={labelClass}>
				<span className="label-text mb-1">Street address</span>
				<input
					className={inputClass}
					name="address"
					autoComplete="billing address-line1"
					value={value.line1}
					onChange={set("line1")}
					onBlur={() => setTouched(true)}
					required
				/>
			</label>
			<label className={labelClass}>
				<span className="label-text mb-1">Apartment, suite, etc. (optional)</span>
				<input
					className={inputClass}
					name="address2"
					autoComplete="billing address-line2"
					value={value.line2}
					onChange={set("line2")}
				/>
			</label>
			<div className="flex gap-2">
				<label className={`${labelClass} flex-1`}>
					<span className="label-text mb-1">City</span>
					<input
						className={inputClass}
						name="city"
						autoComplete="billing address-level2"
						value={value.city}
						onChange={set("city")}
						onBlur={() => setTouched(true)}
						required
					/>
				</label>
				<label className={`${labelClass} w-36`}>
					<span className="label-text mb-1">State</span>
					<select
						className="select select-bordered w-full"
						name="state"
						autoComplete="billing address-level1"
						value={value.state}
						onChange={set("state")}
						onBlur={() => setTouched(true)}
						required
					>
						<option value="" disabled>
							State
						</option>
						{US_STATES.map((s) => (
							<option key={s.code} value={s.code}>
								{s.name}
							</option>
						))}
					</select>
				</label>
			</div>
			<label className={labelClass}>
				<span className="label-text mb-1">ZIP code</span>
				<input
					className={inputClass}
					name="zip"
					autoComplete="billing postal-code"
					value={value.postalCode}
					onChange={set("postalCode")}
					onBlur={() => setTouched(true)}
					inputMode="numeric"
					// A nine-digit (ZIP+4) value is accepted — see `zipForTax`, which strips
					// the suffix before the address reaches the session. The pattern keeps
					// native validation honest for everything else.
					pattern="\d{5}(-\d{4})?"
					title="A five-digit ZIP, or a nine-digit ZIP+4"
					required
				/>
				{touched && value.postalCode !== "" && !isUsZip(value.postalCode) && (
					<span className="label-text-alt text-error mt-1">
						Enter a five-digit ZIP code, like 80202.
					</span>
				)}
			</label>
		</div>
	);
}

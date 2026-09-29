// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import UsBillingAddressForm, { formatAddress } from "./UsBillingAddressForm";
import type { SessionBillingAddress } from "./useSessionBillingAddress";

/**
 * The billing address block on a purchase surface: Anthers' own US-only form before the
 * session has the address, a one-line editable summary after.
 *
 * The block never disappears once the address is accepted — the buyer needs to see what
 * their tax resolved from, and a buyer who typoed their ZIP needs to be able to fix it
 * without starting over. Editing re-opens the form and requires a fresh submit, which
 * re-resolves the session's tax before the buyer can confirm again (the gate re-arms
 * because `accepted` is only set by a successful `updateBillingAddress`).
 */
export default function CheckoutBillingAddressBlock({
	billing,
}: {
	billing: SessionBillingAddress;
}) {
	const [editing, setEditing] = useState(false);
	const { address, setAddress, submitAddress, accepted, error, updating } = billing;
	const showForm = !accepted || editing;

	return (
		<div className="border border-base-300 rounded-lg p-3 bg-base-100">
			<div className="flex items-center justify-between mb-2">
				<span className="font-semibold text-sm">Billing address</span>
				{accepted && !editing && (
					<button
						type="button"
						className="link link-primary text-xs"
						onClick={() => setEditing(true)}
					>
						Edit
					</button>
				)}
			</div>
			{showForm ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						// Close the form only on a submit the session accepted — a failed
						// one leaves the buyer looking at what they typed, with the error.
						void submitAddress().then((ok) => {
							if (ok) setEditing(false);
						});
					}}
				>
					<UsBillingAddressForm value={address} onChange={setAddress} />
					<button type="submit" className="btn btn-sm btn-outline btn-primary" disabled={updating}>
						{updating ? "Calculating tax…" : "Save address"}
					</button>
				</form>
			) : (
				<div className="flex items-start justify-between gap-2">
					<p className="text-sm">{formatAddress(address)}</p>
				</div>
			)}
			{error && <p className="text-error text-xs mt-2">{error}</p>}
		</div>
	);
}

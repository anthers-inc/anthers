// SPDX-License-Identifier: Apache-2.0
/**
 * The billing address block on a purchase surface: Anthers' own US-only form, resolving
 * tax automatically as the buyer types.
 *
 * There is NO submit button here (Parker, 2026-10-03: "the only button you click is the
 * button to complete the purchase") — the block is an owned `<div>`, never a `<form>`,
 * because a purchase surface's only `<form>` is the checkout's own, whose submit is the
 * Pay button. Tax resolution lives in `useSessionBillingAddress`: once the typed address
 * is complete and settled, it is written to the session and Stripe Tax resolves the rate.
 *
 * The block never disappears once the address is accepted — the buyer needs to see what
 * their tax resolved from, and a buyer who typoed their ZIP needs to be able to fix it
 * without starting over. Editing re-opens the form; the effect in the hook re-resolves
 * the session's tax from the settled, changed value (the gate re-arms because `accepted`
 * is only set by a successful `updateBillingAddress`).
 */
import { useEffect, useRef, useState } from "react";
import UsBillingAddressForm, { formatAddress, type UsAddressInput } from "./UsBillingAddressForm";
import type { SessionBillingAddress } from "./useSessionBillingAddress";

export default function CheckoutBillingAddressBlock({
	billing,
}: {
	billing: SessionBillingAddress;
}) {
	const [editing, setEditing] = useState(false);
	// Pinned when the buyer opens the form over an accepted address; an auto-resolve is
	// only the edit's own result if the typed value was still that accepted one.
	const editOriginRef = useRef<UsAddressInput | null>(null);
	const { address, setAddress, acceptedAddress, accepted, error, updating } = billing;
	const showForm = !accepted || editing;

	// When a settled edit resolves, the form folds back to the one-line summary — the
	// same "the session took it" moment a submit used to produce. The origin guard is
	// what keeps this honest: if the buyer changed the fields again while the first edit
	// was resolving, that resolve is not accepted as the close (nothing did), and the
	// form stays open for the newer value's own resolution.
	const wasEditingRef = useRef(false);
	useEffect(() => {
		if (editing && acceptedAddress && editOriginRef.current == null) {
			editOriginRef.current = acceptedAddress;
			wasEditingRef.current = true;
		}
		if (!editing) {
			editOriginRef.current = null;
			wasEditingRef.current = false;
		}
	}, [editing, acceptedAddress]);
	useEffect(() => {
		if (!wasEditingRef.current || updating || error) return;
		if (
			accepted &&
			acceptedAddress &&
			editOriginRef.current != null &&
			formatAddress(editOriginRef.current) !== formatAddress(acceptedAddress)
		) {
			setEditing(false);
		}
	}, [accepted, acceptedAddress, error, updating]);

	return (
		<div className="border border-base-300 rounded-lg p-3 bg-base-100">
			<div className="flex items-center justify-between mb-2">
				<span className="font-semibold text-sm">Billing address</span>
				{/* The edit control opens the typed-fields view while the session still holds
				    the accepted address — its totals keep showing until the changed address
				    resolves, and an abandoned edit costs nothing. */}
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
				<div data-testid="billing-address-form">
					<UsBillingAddressForm value={address} onChange={setAddress} />
				</div>
			) : acceptedAddress ? (
				<div className="flex items-start justify-between gap-2">
					<p className="text-sm">{formatAddress(acceptedAddress)}</p>
				</div>
			) : null}
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

// SPDX-License-Identifier: Apache-2.0
/**
 * The billing address block on a purchase surface: Anthers' own US-only form, resolving
 * tax automatically as the buyer types — and STAYING OPEN (Parker, 2026-10-04: the
 * post-fill collapse was disorienting; the buyer sees their address through the whole
 * purchase and gets a checkmark once the tax resolved from it).
 *
 * There is NO submit button here (Parker, 2026-10-03: "the only button you click is the
 * button to complete the purchase") — the block is an owned `<div>`, never a `<form>`,
 * because a purchase surface's only `<form>` is the checkout's own, whose submit is the
 * Pay button. Tax resolution lives in `useSessionBillingAddress`: once the typed address
 * is complete and settled, it is written to the session and Stripe Tax resolves the rate;
 * `accepted` carries the checkmark, and the resolved rate appears in the summary beside
 * the form ("Sales tax from your address" turns into a figure there).
 *
 * An edit is nothing special any more: the fields are always on screen, so the buyer who
 * typoed their ZIP just fixes it, and the hook's resolve effect re-resolves the session's
 * tax from the changed value (the gate re-arms because `accepted` is only set by a
 * successful `updateBillingAddress`).
 */
import UsBillingAddressForm, { type UsAddressInput } from "./UsBillingAddressForm";
import type { SessionBillingAddress } from "./useSessionBillingAddress";

export default function CheckoutBillingAddressBlock({
	billing,
}: {
	billing: SessionBillingAddress;
}) {
	const { address, setAddress, accepted, error, updating } = billing;

	return (
		<div className="border border-base-300 rounded-lg p-3 bg-base-100">
			<div className="flex items-center justify-between mb-2">
				<span className="font-semibold text-sm">Billing address</span>
				{/* The checkmark IS the "the session took it" moment the old collapse used to
				    announce: tax resolved against this address, and the buyer's total is real.
				    `accepted` flips only on a successful `updateBillingAddress` — see the hook. */}
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
				<UsBillingAddressForm value={address} onChange={setAddress} />
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
 * The accepted-summary line the old block showed is gone with the collapse; the address
 * is on screen in full, so nothing repeats it.
 */
export type { UsAddressInput };

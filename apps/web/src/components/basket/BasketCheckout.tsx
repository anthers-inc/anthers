// SPDX-License-Identifier: Apache-2.0
/**
 * Paying for a basket — the same Checkout flow as a single purchase, against one charge.
 *
 * Modeled on `ProjectPricing`'s form rather than shared with it, because the two differ in
 * the one place that matters: this posts a *list* of Works to `/basket/checkout`, which
 * writes one purchase row per Work against a single Checkout Session — one line item per
 * Work, each carrying that Work's own tax code. What they must not differ on is the money,
 * and they don't — both let the server build the session (the price, the codes, the
 * automatic-tax setting) and neither computes a total in the browser.
 */
import { client } from "@anthers/web-shared/rpc";
import {
	CheckoutElementsProvider,
	PaymentElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { useEffect, useState } from "react";
import { getStripe } from "../../lib/stripe";
import CheckoutBillingAddressBlock from "../payments/CheckoutBillingAddressBlock";
import {
	mayConfirm,
	sessionTotals,
	useSessionBillingAddress,
} from "../payments/useSessionBillingAddress";

interface BasketCheckoutProps {
	workIds: number[];
	/** Server-quoted subtotal, shown on the button; the tax joins it at the session. */
	buyerTotal: string;
	onComplete: () => void;
}

function CheckoutForm({ workIds, buyerTotal, onComplete }: BasketCheckoutProps) {
	const checkoutState = useCheckoutElements();
	const billing = useSessionBillingAddress(checkoutState);
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		// The address must already be on the session — its own submit step resolved the
		// tax. Confirming without one would charge a total whose rate was never resolved.
		if (checkoutState.type !== "success" || !billing.accepted) return;
		setProcessing(true);
		setError(null);

		try {
			// The session was already created by the provider's client secret fetch — the
			// server built its line items, tax codes and transfer when that happened, so
			// confirming is all that is left.
			const result = await checkoutState.checkout.confirm();
			if (result.type === "error") {
				setError(result.error.message || "Payment failed.");
				return;
			}

			// The purchases are written `pending` at checkout and flipped by the webhook,
			// so access follows within moments rather than instantly. Say that plainly
			// instead of showing a download link that might 403 for a second.
			setSucceeded(true);
			onComplete();
		} catch {
			setError("Failed to process payment. Please try again.");
		} finally {
			setProcessing(false);
		}
	};

	if (succeeded) {
		return (
			<div className="alert alert-success">
				<span>Purchase complete — everything in this basket is yours, in your Library.</span>
			</div>
		);
	}

	if (checkoutState.type === "error") {
		return (
			<div className="alert alert-error text-sm">
				<span>Checkout couldn't load. Please refresh and try again.</span>
			</div>
		);
	}

	// What the session itself totals once the address is on it — the tax-inclusive figure
	// the buyer is charged. Null until the address resolves, so the button says "+ tax"
	// rather than quoting a number nobody has calculated yet.
	const totals = checkoutState.type === "success" ? sessionTotals(checkoutState.checkout) : null;

	// 🚨 Two gates, and neither implies the other: Stripe's `canConfirm` tracks the
	// Payment Element, `accepted` is our own record that the session took a US address.
	const canConfirm =
		checkoutState.type === "success" &&
		mayConfirm(checkoutState.checkout.canConfirm, billing.accepted);

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			{/* Anthers' own US-only form, not Stripe's Billing Address Element — the element
			    offers no country allow-list, so this form is US by construction. Submitting
			    it resolves the session's tax, which is what makes the button's total real. */}
			<CheckoutBillingAddressBlock billing={billing} />
			<div className="rounded-lg border border-base-300 p-3">
				{/* `fields.billingDetails: "never"` because the address above already
				    collected everything AVS would check — asking twice on one screen is
				    the double collection this option exists to prevent, and the card's
				    own AVS check runs against the session's address. */}
				<PaymentElement options={{ fields: { billingDetails: "never" } }} />
			</div>
			<p className="text-xs text-base-content/50">
				Sales tax is calculated from your billing address — the rate varies by location, and Anthers
				sells to US billing addresses at launch.
			</p>
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}
			<button
				type="submit"
				className="btn btn-primary w-full"
				disabled={!canConfirm || processing || workIds.length === 0}
			>
				{processing
					? "Processing…"
					: totals?.buyerTotal
						? `Pay $${totals.buyerTotal.toFixed(2)}`
						: `Pay $${buyerTotal} + tax`}
			</button>
		</form>
	);
}

/** Fetch the basket's session client secret from the server, once. */
function useBasketClientSecret(workIds: number[]) {
	const [secret, setSecret] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | true>(false as string | true);
	useEffect(() => {
		let canceled = false;
		client.api.payments.basket.checkout
			.$post({ json: { workIds } })
			.then(async (res) => {
				if (canceled) return;
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setFailed(body?.error ?? true);
					return;
				}
				const checkout = (await res.json()) as unknown as { clientSecret?: string | null };
				if (!checkout.clientSecret) {
					setFailed(true as const);
					return;
				}
				setSecret(checkout.clientSecret);
			})
			.catch(() => {
				if (!canceled) setFailed(true as const);
			});
		return () => {
			canceled = true;
		};
		// The basket's contents are fixed at mount — the page re-renders the component
		// with a new key when the basket changes, so `workIds` is not a dependency here.
	}, [workIds]);
	return { secret, failed };
}

export default function BasketCheckout(props: BasketCheckoutProps) {
	const { secret, failed } = useBasketClientSecret(props.workIds);
	if (failed) {
		return (
			<div className="alert alert-warning text-sm">
				<span>
					{typeof failed === "string" ? failed : "Couldn't start checkout. Please try again."}
				</span>
			</div>
		);
	}
	if (!secret) {
		return <div className="skeleton h-64 w-full" aria-hidden="true" />;
	}
	return (
		<CheckoutElementsProvider stripe={getStripe()} options={{ clientSecret: secret }}>
			<CheckoutForm {...props} />
		</CheckoutElementsProvider>
	);
}

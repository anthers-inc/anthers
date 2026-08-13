// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Paying for a basket — the same card flow as a single purchase, against one charge.
 *
 * Modelled on `ProjectPricing`'s `CheckoutForm` rather than shared with it, because the
 * two differ in the one place that matters: this posts a *list* of Works to
 * `/basket/checkout`, which writes one purchase row per Work against a single
 * PaymentIntent. What they must not differ on is the money, and they don't — both let the
 * server quote and charge, and neither computes a total in the browser.
 */
import { client } from "@anthers/web-shared/rpc";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useState } from "react";
import { getStripe } from "../../lib/stripe";

interface BasketCheckoutProps {
	workIds: number[];
	/** Server-quoted, shown on the button so the figure the buyer clicks is the charge. */
	buyerTotal: string;
	onComplete: () => void;
}

function CheckoutForm({ workIds, buyerTotal, onComplete }: BasketCheckoutProps) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!stripe || !elements) return;
		setProcessing(true);
		setError(null);

		try {
			const res = await client.api.payments.basket.checkout.$post({ json: { workIds } });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "Couldn't start checkout.");
				return;
			}
			const checkout = (await res.json()) as unknown as { clientSecret?: string };
			if (!checkout.clientSecret) {
				setError("Couldn't start checkout. Please try again.");
				return;
			}

			const cardElement = elements.getElement(CardElement);
			if (!cardElement) {
				setError("Card element not found.");
				return;
			}

			const { error: stripeError } = await stripe.confirmCardPayment(checkout.clientSecret, {
				payment_method: { card: cardElement },
			});
			if (stripeError) {
				setError(stripeError.message || "Payment failed.");
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

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			<div className="rounded-lg border border-base-300 p-3">
				<CardElement options={{ style: { base: { fontSize: "16px" } } }} />
			</div>
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}
			<button
				type="submit"
				className="btn btn-primary w-full"
				disabled={!stripe || processing || workIds.length === 0}
			>
				{processing ? "Processing…" : `Pay $${buyerTotal}`}
			</button>
		</form>
	);
}

export default function BasketCheckout(props: BasketCheckoutProps) {
	return (
		<Elements stripe={getStripe()}>
			<CheckoutForm {...props} />
		</Elements>
	);
}

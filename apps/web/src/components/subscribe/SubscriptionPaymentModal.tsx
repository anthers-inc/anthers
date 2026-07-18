// SPDX-License-Identifier: AGPL-3.0-or-later
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useMemo, useState } from "react";
import { stripePromise } from "../../lib/stripe";
import { cardElementStyle } from "../../lib/stripeCard";

interface Props {
	/** Confirmation secret from the incomplete subscription's first invoice. */
	clientSecret: string;
	/** Human plan name for the heading (e.g. "Blossom"). */
	planName: string;
	/** Monthly price for display (e.g. "40.00"). */
	priceLabel: string;
	/** Called after the card is confirmed — the webhook then applies the badge. */
	onDone: () => void;
	onClose: () => void;
}

function PaymentForm({ clientSecret, planName, priceLabel, onDone, onClose }: Props) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cardStyle = useMemo(cardElementStyle, []);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!stripe || !elements) return;
		setProcessing(true);
		setError(null);
		const card = elements.getElement(CardElement);
		if (!card) {
			setError("Card field isn't ready. Please try again.");
			setProcessing(false);
			return;
		}
		const { error: err } = await stripe.confirmCardPayment(clientSecret, {
			payment_method: { card },
		});
		if (err) {
			setError(err.message ?? "Payment failed.");
			setProcessing(false);
			return;
		}
		onDone();
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<h3 className="font-bold text-lg mb-1">Confirm your {planName} plan</h3>
				<p className="text-sm text-base-content/60 mb-4">
					${priceLabel}/month, billed to this card. Cancel anytime — your plan stays active through
					the period you've paid for.
				</p>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<div className="border border-base-300 rounded-lg p-3 bg-base-100">
						<CardElement options={{ style: cardStyle }} />
					</div>
					{error && (
						<div className="alert alert-error text-sm">
							<span>{error}</span>
						</div>
					)}
					<div className="flex gap-2 justify-end">
						<button type="button" className="btn btn-ghost" onClick={onClose} disabled={processing}>
							Cancel
						</button>
						<button type="submit" className="btn btn-primary" disabled={!stripe || processing}>
							{processing ? "Processing…" : `Subscribe · $${priceLabel}/mo`}
						</button>
					</div>
				</form>
			</div>
			<button
				type="button"
				className="modal-backdrop"
				onClick={onClose}
				aria-label="Close"
				disabled={processing}
			/>
		</div>
	);
}

export default function SubscriptionPaymentModal(props: Props) {
	return (
		<Elements stripe={stripePromise}>
			<PaymentForm {...props} />
		</Elements>
	);
}

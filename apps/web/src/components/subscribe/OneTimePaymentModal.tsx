// SPDX-License-Identifier: AGPL-3.0-or-later
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeCardElement } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { getStripe } from "../../lib/stripe";
import { cardElementStyle } from "../../lib/stripeCard";

interface Props {
	title: string;
	blurb: string;
	/** PaymentIntent client secret to confirm. */
	clientSecret: string;
	savedCard: { id: string; brand: string; last4: string } | null;
	confirmLabel: string;
	/** Called after the payment confirms — the webhook then credits the account. */
	onComplete: () => void;
	onClose: () => void;
}

function PaymentForm({
	title,
	blurb,
	clientSecret,
	savedCard,
	confirmLabel,
	onComplete,
	onClose,
}: Props) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [useNewCard, setUseNewCard] = useState(!savedCard);
	const cardStyle = useMemo(cardElementStyle, []);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!stripe) return;
		setProcessing(true);
		setError(null);
		let payment_method: string | { card: StripeCardElement };
		if (savedCard && !useNewCard) {
			payment_method = savedCard.id;
		} else {
			const card = elements?.getElement(CardElement);
			if (!card) {
				setError("Card field isn't ready. Please try again.");
				setProcessing(false);
				return;
			}
			payment_method = { card };
		}
		const { error: err } = await stripe.confirmCardPayment(clientSecret, { payment_method });
		if (err) {
			setError(err.message ?? "Payment failed.");
			setProcessing(false);
			return;
		}
		onComplete();
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<h3 className="font-bold text-lg mb-1">{title}</h3>
				<p className="text-sm text-base-content/60 mb-4">{blurb}</p>
				<form onSubmit={submit} className="flex flex-col gap-3">
					{savedCard && !useNewCard ? (
						<div className="flex items-center justify-between rounded-lg border border-base-300 px-3 py-2 text-sm">
							<span className="capitalize">
								{savedCard.brand} •••• {savedCard.last4}
							</span>
							<button
								type="button"
								className="link link-primary text-xs"
								onClick={() => setUseNewCard(true)}
							>
								Use a different card
							</button>
						</div>
					) : (
						<div>
							<div className="border border-base-300 rounded-lg p-3 bg-base-100">
								<CardElement options={{ style: cardStyle }} />
							</div>
							{savedCard && (
								<button
									type="button"
									className="link link-primary text-xs mt-1"
									onClick={() => setUseNewCard(false)}
								>
									Use saved {savedCard.brand} •••• {savedCard.last4}
								</button>
							)}
						</div>
					)}
					{error && (
						<div className="alert alert-error text-sm">
							<span>{error}</span>
						</div>
					)}
					<div className="flex gap-2 justify-end mt-1">
						<button type="button" className="btn btn-ghost" onClick={onClose} disabled={processing}>
							Cancel
						</button>
						<button type="submit" className="btn btn-primary" disabled={!stripe || processing}>
							{processing ? "Processing…" : confirmLabel}
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

export default function OneTimePaymentModal(props: Props) {
	return (
		<Elements stripe={getStripe()}>
			<PaymentForm {...props} />
		</Elements>
	);
}

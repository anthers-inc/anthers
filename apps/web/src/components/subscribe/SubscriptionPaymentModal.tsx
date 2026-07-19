// SPDX-License-Identifier: AGPL-3.0-or-later
import { client } from "@anthers/web-shared/rpc";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeCardElement } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { stripePromise } from "../../lib/stripe";
import { cardElementStyle } from "../../lib/stripeCard";

/** What the confirmation modal needs — computed server-side by /subscriptions/preview. */
export interface SubscriptionPreview {
	isChange: boolean;
	recurring: { amount: string; interval: string };
	chargeNow: string;
	nextBillingUnix: number | null;
	savedCard: { id: string; brand: string; last4: string } | null;
}

interface Props {
	/** The target Anthers-Seed count to subscribe to (the subscription quantity). */
	anthersSeeds: number;
	planName: string;
	preview: SubscriptionPreview;
	/** Called after the change is confirmed — the webhook then applies the Seed count. */
	onComplete: () => void;
	onClose: () => void;
}

function formatDate(unix: number | null): string | null {
	if (!unix) return null;
	return new Date(unix * 1000).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

function PaymentForm({ anthersSeeds, planName, preview, onComplete, onClose }: Props) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// New subscriptions can choose saved vs new card; a plan change always uses the
	// subscription's card on file. Default to the saved card when there is one.
	const [useNewCard, setUseNewCard] = useState(!preview.savedCard);
	const cardStyle = useMemo(cardElementStyle, []);

	const nextDate = formatDate(preview.nextBillingUnix);
	const { savedCard, isChange } = preview;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setProcessing(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.account.$post({ json: { anthersSeeds } });
			if (!res.ok) {
				setError("Couldn't update your plan. Please try again.");
				setProcessing(false);
				return;
			}
			const data = (await res.json()) as { pending?: boolean; clientSecret?: string | null };

			// A new subscription returns a client secret to confirm inline. A plan change is
			// charged to the card on file, so there's nothing to confirm here.
			if (data.pending && data.clientSecret) {
				if (!stripe) {
					setError("Payments aren't ready. Please try again.");
					setProcessing(false);
					return;
				}
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
				const { error: err } = await stripe.confirmCardPayment(data.clientSecret, {
					payment_method,
				});
				if (err) {
					setError(err.message ?? "Payment failed.");
					setProcessing(false);
					return;
				}
			}
			onComplete();
		} catch {
			setError("Couldn't update your plan. Please try again.");
			setProcessing(false);
		}
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<h3 className="font-bold text-lg mb-1">
					{isChange ? `Switch to ${planName}` : `Subscribe to ${planName}`}
				</h3>

				{/* What they'll be charged — now and going forward */}
				<div className="rounded-lg bg-base-200 p-4 my-3 text-sm flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<span>{isChange ? "Due today (prorated)" : "Charged today"}</span>
						<strong>${preview.chargeNow}</strong>
					</div>
					<div className="flex items-center justify-between text-base-content/70">
						<span>Then</span>
						<span>
							${preview.recurring.amount}/{preview.recurring.interval}
						</span>
					</div>
					{nextDate && (
						<div className="flex items-center justify-between text-base-content/70">
							<span>Next charge</span>
							<span>{nextDate}</span>
						</div>
					)}
				</div>
				<p className="text-xs text-base-content/50 mb-3">
					Renews automatically. Cancel anytime — your plan stays active through the period you've
					paid for.
				</p>

				<form onSubmit={submit} className="flex flex-col gap-3">
					{/* Payment method */}
					{isChange ? (
						savedCard && (
							<div className="text-sm text-base-content/70">
								Charged to your saved <span className="capitalize">{savedCard.brand}</span> ••••{" "}
								{savedCard.last4}.
							</div>
						)
					) : savedCard && !useNewCard ? (
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
						<button type="submit" className="btn btn-primary" disabled={processing}>
							{processing
								? "Processing…"
								: isChange
									? "Confirm change"
									: `Subscribe · $${preview.chargeNow}`}
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

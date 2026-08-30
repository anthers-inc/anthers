// SPDX-License-Identifier: AGPL-3.0-or-later
import { client } from "@anthers/web-shared/rpc";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeCardElement } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { getStripe } from "../../lib/stripe";
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
	/**
	 * ⚠️ **Dollars a month, not a count.** It is `number` either way, so a caller passing a
	 * count typechecks and bills the wrong amount — which `/subscribe` did between the Seed
	 * retirement and 2026-08-16, subscribing people at $1.
	 */
	anthersSupport: number;
	/**
	 * Support pointed at creators, riding on the same charge.
	 *
	 * The subscription carries ONE ITEM PER DESTINATION — `anthersSupport` and each of
	 * these — because everything a user gives arrives on one monthly charge, which is also
	 * what amortizes the fixed card fee across the creators on it. ⚠️ This said the
	 * *quantity* was `anthersSupport` plus these until 2026-08-16; a quantity can only
	 * express multiples of one unit, so the retirement replaced it with itemized amounts.
	 * Omitted everywhere the caller only changes the Anthers amount (the post unlock,
	 * /subscription).
	 */
	directed?: { creatorId: number; amount: number }[];
	badgeName: string;
	preview: SubscriptionPreview;
	/** Called after the change is confirmed — the webhook then applies the new amount. */
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

/**
 * Whether what the user was quoted differs from what the POST would bill.
 *
 * Compared in whole cents, because both sides arrive as floats and a cent is the finest
 * grain anything can actually be charged at.
 */
export function quoteDisagrees(
	quotedAmount: string,
	anthersSupport: number,
	directed?: { amount: number }[],
): boolean {
	const quoted = Number(quotedAmount);
	if (!Number.isFinite(quoted)) return true;
	const billed = (directed ?? []).reduce((sum, d) => sum + d.amount, anthersSupport);
	return Math.round(quoted * 100) !== Math.round(billed * 100);
}

function PaymentForm({ anthersSupport, directed, badgeName, preview, onComplete, onClose }: Props) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// New subscriptions can choose saved vs new card; a change always uses the
	// subscription's card on file. Default to the saved card when there is one.
	const [useNewCard, setUseNewCard] = useState(!preview.savedCard);
	const cardStyle = useMemo(cardElementStyle, []);

	const nextDate = formatDate(preview.nextBillingUnix);
	const { savedCard, isChange } = preview;

	/**
	 * 🚨 **The quote and the charge must be the same number**, checked at the last point
	 * before money moves.
	 *
	 * This modal is the only place that holds both: `preview.recurring.amount`, which is
	 * what the user has just read, and `anthersSupport + directed`, which is what the POST
	 * will bill. They are derived independently by the caller, and on 2026-08-16
	 * `/subscribe` derived them **differently** — quoting $9 and charging $1 — with nothing
	 * between the discrepancy and the card.
	 *
	 * ⚠️ Honest about what it is: `recurring.amount` echoes the amount the client asked
	 * `preview/:amount` about, so this is a **consistency** check and not server
	 * verification. That is still exactly the defect class — one caller computing the
	 * displayed number and the billed number by two routes — and it is the shape the
	 * ceremony bug had. Real server-side authority would mean the preview issuing a token
	 * the charge has to present, which is a larger change than this guard.
	 *
	 * `chargeNow` is deliberately NOT compared: on a change it is a real Stripe proration
	 * and legitimately differs from the recurring amount.
	 */
	const mismatch = quoteDisagrees(preview.recurring.amount, anthersSupport, directed);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (mismatch) {
			// Never silently charge the other number. A refusal a user can retry past is a
			// worse outcome than the one this prevents, so it stops here.
			setError("This doesn't add up — we won't charge you. Please reload and try again.");
			return;
		}
		setProcessing(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.account.$post({
				json: { anthersSupport, ...(directed?.length ? { directed } : {}) },
			});
			if (!res.ok) {
				setError("Couldn't update your support. Please try again.");
				setProcessing(false);
				return;
			}
			const data = (await res.json()) as { pending?: boolean; clientSecret?: string | null };

			// A new subscription returns a client secret to confirm inline. A change is
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
			setError("Couldn't update your support. Please try again.");
			setProcessing(false);
		}
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<h3 className="font-bold text-lg mb-1">
					{isChange ? `Switch to ${badgeName}` : `Give ${badgeName}`}
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
					Renews automatically. Stop anytime — your support stays active through the period you've
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
						<button type="submit" className="btn btn-primary" disabled={processing || mismatch}>
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
		<Elements stripe={getStripe()}>
			<PaymentForm {...props} />
		</Elements>
	);
}

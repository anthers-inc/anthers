// SPDX-License-Identifier: AGPL-3.0-or-later
import { FOUNDATION_FEE_PERCENTAGE } from "@anthers/shared/constants";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useState } from "react";
import { client } from "../../lib/rpc";
import { stripePromise } from "../../lib/stripe";
import type { CheckoutResponse } from "../../lib/types";
import TransparentReceipt from "../ui/TransparentReceipt";

interface ProjectPricingProps {
	pricingType: "free" | "pwyw" | "paid";
	price: string | null;
	slug: string;
	creatorHasStripe: boolean;
	userOwns: boolean | null; // null = loading/unknown
	downloadBytes: number; // total size of downloadable assets, for the delivery line
	onPurchaseComplete: () => void;
}

function buildReceipt(price: number, downloadBytes: number) {
	const processing = Math.round(price * 0.029 * 100) / 100 + 0.3;
	const foundation = Math.round(price * (FOUNDATION_FEE_PERCENTAGE / 100) * 100) / 100;
	let delivery = Math.round((downloadBytes / 1_000_000_000) * 0.01 * 100) / 100;
	// Any real download costs at least a cent to deliver — we can't bill sub-cent.
	if (downloadBytes > 0 && delivery <= 0) delivery = 0.01;
	// Pass-through: the creator receives the full price; fees are added on top.
	const buyerTotal = Math.round((price + delivery + foundation + processing) * 100) / 100;

	return {
		price,
		buyerTotal,
		lines: [
			{ label: "Delivery", amount: delivery, note: "download bandwidth" },
			{
				label: "Anthers Foundation Fee",
				amount: foundation,
				note: `${FOUNDATION_FEE_PERCENTAGE}%`,
			},
			{ label: "Payment processing", amount: processing, note: "Stripe" },
		],
	};
}

function CheckoutForm({
	slug,
	price,
	downloadBytes,
	onPurchaseComplete,
}: {
	slug: string;
	price: number;
	downloadBytes: number;
	onPurchaseComplete: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);

	const receipt = buildReceipt(price, downloadBytes);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!stripe || !elements) return;

		setProcessing(true);
		setError(null);

		try {
			const res = await client.api.payments.checkout[":slug"].$post({
				param: { slug },
			});
			const checkout = (await res.json()) as CheckoutResponse;

			const cardElement = elements.getElement(CardElement);
			if (!cardElement) {
				setError("Card element not found.");
				setProcessing(false);
				return;
			}

			const { error: stripeError } = await stripe.confirmCardPayment(checkout.clientSecret, {
				payment_method: { card: cardElement },
			});

			if (stripeError) {
				setError(stripeError.message || "Payment failed.");
			} else {
				setSucceeded(true);
				onPurchaseComplete();
			}
		} catch {
			setError("Failed to process payment. Please try again.");
		} finally {
			setProcessing(false);
		}
	};

	if (succeeded) {
		return (
			<div className="alert alert-success">
				<span>Purchase complete! Downloads are now available.</span>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<TransparentReceipt {...receipt} />

			<div className="form-control">
				<div className="border border-base-300 rounded-lg p-3 bg-base-100">
					<CardElement
						options={{
							style: {
								base: {
									fontSize: "16px",
									color: "oklch(var(--bc))",
									"::placeholder": { color: "oklch(var(--bc) / 0.4)" },
								},
							},
						}}
					/>
				</div>
			</div>

			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			<button
				type="submit"
				className={`btn btn-primary ${processing ? "btn-disabled" : ""}`}
				disabled={!stripe || processing}
			>
				{processing ? "Processing..." : `Buy for $${receipt.buyerTotal.toFixed(2)}`}
			</button>
		</form>
	);
}

export default function ProjectPricing({
	pricingType,
	price,
	slug,
	creatorHasStripe,
	userOwns,
	downloadBytes,
	onPurchaseComplete,
}: ProjectPricingProps) {
	if (pricingType === "free") return null;

	const displayPrice = parseFloat(price || "0");

	return (
		<div>
			<h2 className="text-xl font-bold mb-4">Pricing</h2>

			<p className="text-2xl font-bold mb-3">${displayPrice.toFixed(2)}</p>

			{userOwns === true ? (
				<div className="badge badge-success badge-lg gap-1">Owned</div>
			) : !creatorHasStripe ? (
				<div className="p-3 bg-base-200 rounded-lg">
					<p className="text-sm text-base-content/60">
						Payments not available yet—the creator hasn't connected Stripe.
					</p>
				</div>
			) : !stripePromise ? (
				<div className="p-3 bg-base-200 rounded-lg">
					<p className="text-sm text-base-content/60">Payments are not configured.</p>
				</div>
			) : (
				<Elements stripe={stripePromise}>
					<CheckoutForm
						slug={slug}
						price={displayPrice}
						downloadBytes={downloadBytes}
						onPurchaseComplete={onPurchaseComplete}
					/>
				</Elements>
			)}
		</div>
	);
}

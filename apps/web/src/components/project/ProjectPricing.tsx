import { useState } from "react";
import {
	Elements,
	CardElement,
	useStripe,
	useElements,
} from "@stripe/react-stripe-js";
import { client } from "../../lib/rpc";
import type { CheckoutResponse } from "../../lib/types";
import { stripePromise } from "../../lib/stripe";
import TransparentReceipt from "../ui/TransparentReceipt";

interface ProjectPricingProps {
	pricingType: "free" | "pwyw" | "paid";
	price: string | null;
	slug: string;
	creatorHasStripe: boolean;
	userOwns: boolean | null; // null = loading/unknown
	onPurchaseComplete: () => void;
}

function buildReceipt(price: number) {
	const processing = Math.round(price * 0.029 * 100) / 100 + 0.3;
	const crf = Math.round(price * 0.03 * 100) / 100;
	const creatorTotal = Math.round((price - processing - crf) * 100) / 100;

	return {
		price,
		lines: [
			{ label: "Payment processing", amount: processing, note: "Stripe" },
			{ label: "Anthers Foundation Fee", amount: crf, note: "3%" },
		],
		creatorTotal: Math.max(creatorTotal, 0),
	};
}

function CheckoutForm({
	slug,
	price,
	onPurchaseComplete,
}: {
	slug: string;
	price: number;
	onPurchaseComplete: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);

	const receipt = buildReceipt(price);

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

			const { error: stripeError } = await stripe.confirmCardPayment(
				checkout.clientSecret,
				{ payment_method: { card: cardElement } },
			);

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
				{processing ? "Processing..." : `Buy for $${price.toFixed(2)}`}
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
					<p className="text-sm text-base-content/60">
						Payments are not configured.
					</p>
				</div>
			) : (
				<Elements stripe={stripePromise}>
					<CheckoutForm
						slug={slug}
						price={displayPrice}
						onPurchaseComplete={onPurchaseComplete}
					/>
				</Elements>
			)}
		</div>
	);
}

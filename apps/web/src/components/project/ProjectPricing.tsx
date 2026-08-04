// SPDX-License-Identifier: AGPL-3.0-or-later
import { CARD_FLAT, CARD_RATE, SALES_TAX_RATE } from "@anthers/shared/constants";
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult, CheckoutResponse } from "@anthers/web-shared/types";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useEffect, useMemo, useState } from "react";
import { stripePromise } from "../../lib/stripe";
import TransparentReceipt from "../ui/TransparentReceipt";

interface ProjectPricingProps {
	slug: string;
	access: AccessResult;
	creatorHasStripe?: boolean;
	onPurchaseComplete?: () => void;
}

function buildReceipt(price: number) {
	const r2 = (n: number) => Math.round(n * 100) / 100;
	// Direct purchase: the listed price IS the advertised price. Card processing and the
	// first download come out of it and Anthers keeps $0, so the only thing added is
	// sales tax — the sole carve-out mandatory-fee disclosure law allows. Delivery is
	// byte-based and finalised at checkout, which is why it isn't estimated here.
	const processing = r2(price * CARD_RATE + CARD_FLAT);
	const tax = r2(price * SALES_TAX_RATE);
	const buyerTotal = r2(price + tax);

	return {
		price,
		buyerTotal,
		lines: [
			{ label: "Card processing", amount: processing, note: "at cost" },
			{ label: "Sales tax", amount: tax, note: "est.", added: true },
		],
	};
}

interface Quote {
	amount: string;
	processingFee: string;
	deliveryFee: string;
	crfFee: string;
	salesTax: string;
	buyerTotal: string;
}

/** The exact server-computed receipt — the total here matches what Stripe charges. */
function receiptFromQuote(q: Quote) {
	const n = (s: string) => Number(s);
	const lines: { label: string; amount: number; note?: string; added?: boolean }[] = [];
	// Everything except tax comes OUT of the listed price; `crfFee` is always zero now
	// (Anthers takes no cut of a purchase) and is deliberately not rendered.
	lines.push({ label: "Card processing", amount: n(q.processingFee), note: "at cost" });
	if (n(q.deliveryFee) > 0)
		lines.push({ label: "First download", amount: n(q.deliveryFee), note: "at cost" });
	lines.push({ label: "Sales tax", amount: n(q.salesTax), note: "est.", added: true });
	return {
		price: n(q.amount),
		buyerTotal: n(q.buyerTotal),
		lines,
		creatorReceives: n(q.amount) - n(q.processingFee) - n(q.deliveryFee),
	};
}

/**
 * Stripe Elements only accepts concrete colors (hex/rgb) — not `oklch()` or CSS
 * vars. Resolve a themed color to an `rgb(a)` string by rasterising one pixel, so
 * the card input still tracks the active light/dark theme.
 */
function toRgb(cssColor: string): string {
	if (typeof document === "undefined") return "#111111";
	const probe = document.createElement("span");
	probe.style.color = cssColor;
	document.body.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	probe.remove();
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return computed;
	ctx.fillStyle = computed;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
	return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

function CheckoutForm({
	slug,
	price,
	onPurchaseComplete,
}: {
	slug: string;
	price: number;
	onPurchaseComplete?: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);
	const [quote, setQuote] = useState<Quote | null>(null);

	// Pull the exact fees from the server so the shown total matches the charge — the
	// client estimate can't know the byte-based delivery fee. Fall back until it loads.
	useEffect(() => {
		let cancelled = false;
		client.api.payments.quote[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as Quote;
				if (!cancelled) setQuote(data);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [slug]);

	const receipt = quote ? receiptFromQuote(quote) : buildReceipt(price);

	// Resolve the themed card colors once; Stripe rejects oklch()/var().
	const cardStyle = useMemo(
		() => ({
			base: {
				fontSize: "16px",
				color: toRgb("oklch(var(--bc))"),
				"::placeholder": { color: toRgb("oklch(var(--bc) / 0.4)") },
			},
		}),
		[],
	);

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
			if (!checkout.clientSecret) {
				setError("Couldn't start checkout. Please try again.");
				setProcessing(false);
				return;
			}

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
				onPurchaseComplete?.();
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
					<CardElement options={{ style: cardStyle }} />
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
	slug,
	access,
	creatorHasStripe = false,
	onPurchaseComplete,
}: ProjectPricingProps) {
	// Free posts have nothing to sell.
	if (access.isFree) return null;

	const price = parseFloat(access.price ?? "0");

	return (
		<div>
			<h2 className="text-xl font-bold mb-4">Pricing</h2>

			<div className="flex items-baseline gap-2 mb-3">
				<p className="text-2xl font-bold">${price.toFixed(2)}</p>
			</div>

			{access.canAccess ? (
				<div className="badge badge-success badge-lg gap-1">Owned</div>
			) : !access.requiresPurchase ? (
				<div className="p-3 bg-base-200 rounded-lg">
					<p className="text-sm text-base-content/60">Sign in to purchase this post.</p>
				</div>
			) : !creatorHasStripe ? (
				<div className="p-3 bg-base-200 rounded-lg">
					<p className="text-sm text-base-content/60">
						Payments not available yet—the creator hasn't connected Stripe.
					</p>
				</div>
			) : (
				<Elements stripe={stripePromise}>
					<CheckoutForm slug={slug} price={price} onPurchaseComplete={onPurchaseComplete} />
				</Elements>
			)}
		</div>
	);
}

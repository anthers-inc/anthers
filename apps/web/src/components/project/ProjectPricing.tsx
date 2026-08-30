// SPDX-License-Identifier: AGPL-3.0-or-later
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult, CheckoutResponse } from "@anthers/web-shared/types";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useEffect, useMemo, useState } from "react";
import { getStripe } from "../../lib/stripe";
import TransparentReceipt from "../ui/TransparentReceipt";

interface ProjectPricingProps {
	slug: string;
	access: AccessResult;
	creatorHasStripe?: boolean;
	onPurchaseComplete?: () => void;
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
	// Everything except tax comes OUT of the listed price. Two of the quote's fields are
	// structurally zero on any new purchase and neither is rendered: `crfFee` (Anthers
	// takes no cut of a purchase, 2026-08-03) and `deliveryFee` (delivery is free at any
	// volume, 2026-08-12 — `calculateFees` no longer even takes a size). Both stay in the
	// arithmetic below, because a receipt that ignores a field the server sent would stop
	// reconciling the moment one came back non-zero.
	lines.push({ label: "Card processing", amount: n(q.processingFee), note: "at cost" });
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
	onPurchaseComplete,
}: {
	slug: string;
	onPurchaseComplete?: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteFailed, setQuoteFailed] = useState(false);

	// The server is the ONLY thing that prices this purchase. There used to be a client
	// estimate rendered until the quote arrived, and it drifted: it recomputed the card
	// fee from the bare price while the server grossed up, so the button quoted a total
	// below what checkout charged. Re-deriving the estimate from `calculateFees` would
	// have re-synced the formula, but it also pulls decimal.js into the SPA bundle for a
	// sub-second placeholder — and two implementations that agree today are exactly how
	// this drifted the first time. So there is no second formula now: the receipt and the
	// button render from the quote or not at all, and a quote we could not get is a
	// disabled button rather than a number we guessed.
	useEffect(() => {
		let canceled = false;
		setQuote(null);
		setQuoteFailed(false);
		client.api.payments.quote[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (canceled) return;
				if (!res.ok) {
					setQuoteFailed(true);
					return;
				}
				setQuote((await res.json()) as Quote);
			})
			.catch(() => {
				if (!canceled) setQuoteFailed(true);
			});
		return () => {
			canceled = true;
		};
	}, [slug]);

	const receipt = quote ? receiptFromQuote(quote) : null;

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

	if (quoteFailed) {
		return (
			<div className="alert alert-warning text-sm">
				<span>We couldn't price this purchase right now. Please refresh and try again.</span>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{receipt ? (
				<TransparentReceipt {...receipt} />
			) : (
				/* Decorative: the button below already announces "Loading price…". */
				<div className="skeleton h-40 w-full" aria-hidden="true" />
			)}

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
				disabled={!stripe || processing || !receipt}
			>
				{processing
					? "Processing..."
					: receipt
						? `Buy for $${receipt.buyerTotal.toFixed(2)}`
						: "Loading price…"}
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
				<Elements stripe={getStripe()}>
					<CheckoutForm slug={slug} onPurchaseComplete={onPurchaseComplete} />
				</Elements>
			)}
		</div>
	);
}

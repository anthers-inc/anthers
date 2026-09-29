// SPDX-License-Identifier: Apache-2.0
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult, CheckoutResponse } from "@anthers/web-shared/types";
import {
	BillingAddressElement,
	CheckoutElementsProvider,
	PaymentElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { useEffect, useState } from "react";
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
	/** Null — the tax is resolved by Stripe Tax at the session, from the buyer's address. */
	salesTax: string | null;
	buyerTotal: string | null;
}

/**
 * The server-computed receipt. Tax is deliberately absent: the rate varies by location and
 * is calculated at checkout, so the receipt shows where the price goes and names the tax as
 * coming — an "estimated" figure here would be the flat-rate charge this flow exists to
 * retire, one screen earlier.
 */
function receiptFromQuote(q: Quote) {
	const n = (s: string) => Number(s);
	const lines: { label: string; amount: number; note?: string; added?: boolean }[] = [];
	// Everything except tax comes OUT of the listed price. Two of the quote's fields are
	// structurally zero on any new purchase and neither is rendered: `crfFee` (Anthers
	// takes no cut of a purchase, 2026-08-03) and `deliveryFee` (delivery is free at any
	// volume, 2026-08-12). Both stay in the arithmetic below, because a receipt that
	// ignores a field the server sent would stop reconciling the moment one came back
	// non-zero.
	lines.push({ label: "Card processing", amount: n(q.processingFee), note: "at cost" });
	return {
		price: n(q.amount),
		buyerTotal: n(q.amount),
		lines,
		creatorReceives: n(q.amount) - n(q.processingFee) - n(q.deliveryFee),
	};
}

/**
 * The Checkout form, inside `CheckoutElementsProvider`.
 *
 * The Payment Element collects the card and the minimum billing details; the Billing
 * Address Element collects the full address, offered to the US only, because that is the
 * address tax resolves from and the posture sells to US buyers at launch. The session
 * itself — created server-side — carries the line item's tax code and the automatic-tax
 * setting; this side only mounts what Stripe built and confirms.
 */
function CheckoutForm({
	slug,
	onPurchaseComplete,
}: {
	slug: string;
	onPurchaseComplete?: () => void;
}) {
	const checkoutState = useCheckoutElements();
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

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (checkoutState.type !== "success") return;

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

			// Checkout confirms in place for cards — the session carries the line item, its
			// tax code and the automatic-tax setting, and Stripe Tax resolves the buyer's
			// rate from the address the elements collected.
			const result = await checkoutState.checkout.confirm();
			if (result.type === "error") {
				setError(result.error.message || "Payment failed.");
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

	if (checkoutState.type === "error") {
		return (
			<div className="alert alert-error text-sm">
				<span>Checkout couldn't load. Please refresh and try again.</span>
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

	const canConfirm = checkoutState.type === "success" && checkoutState.checkout.canConfirm;

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{receipt ? (
				<TransparentReceipt {...receipt} />
			) : (
				/* Decorative: the button below already announces "Loading price…". */
				<div className="skeleton h-40 w-full" aria-hidden="true" />
			)}

			{/* Tax is calculated from this address — the rate varies by location. Anthers sells
			    to US billing addresses at launch; anything else is refused at completion. */}
			<div className="border border-base-300 rounded-lg p-3 bg-base-100">
				<BillingAddressElement options={{ fields: { phone: "never" } }} />
			</div>

			<div className="border border-base-300 rounded-lg p-3 bg-base-100">
				<PaymentElement />
			</div>

			<p className="text-xs text-base-content/50">
				Sales tax is calculated from your billing address and shown before you pay — the rate varies
				by location.
			</p>

			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			<button
				type="submit"
				className={`btn btn-primary ${processing || !canConfirm ? "btn-disabled" : ""}`}
				disabled={!canConfirm || processing}
			>
				{processing
					? "Processing..."
					: receipt
						? `Buy for $${receipt.buyerTotal.toFixed(2)} + tax`
						: "Loading price…"}
			</button>
		</form>
	);
}

/** Fetch a session's client secret from the server and hand Checkout the promise. */
function useClientSecret(slug: string) {
	const [secret, setSecret] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let canceled = false;
		client.api.payments.checkout[":slug"]
			.$post({ param: { slug } })
			.then(async (res) => {
				if (canceled) return;
				if (!res.ok) {
					setFailed(true);
					return;
				}
				const checkout = (await res.json()) as CheckoutResponse;
				if (!checkout.clientSecret) {
					setFailed(true);
					return;
				}
				setSecret(checkout.clientSecret);
			})
			.catch(() => {
				if (!canceled) setFailed(true);
			});
		return () => {
			canceled = true;
		};
	}, [slug]);
	return { secret, failed };
}

export default function ProjectPricing({
	slug,
	access,
	creatorHasStripe = false,
	onPurchaseComplete,
}: ProjectPricingProps) {
	// Fetch the session's client secret up front, before any branch: hooks must run in
	// the same order on every render, and the early returns below (free, owned, signed
	// out) would skip one if this sat where it is used. The fetch is wasted on the
	// branches that never mount Checkout, which is a POST the buyer never reaches on
	// those branches anyway — and cheap against a rule the linter can enforce.
	const { secret, failed } = useClientSecret(slug);

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
			) : failed ? (
				<div className="alert alert-warning text-sm">
					<span>Checkout couldn't start. Please refresh and try again.</span>
				</div>
			) : !secret ? (
				<div className="skeleton h-64 w-full" aria-hidden="true" />
			) : (
				<CheckoutElementsProvider stripe={getStripe()} options={{ clientSecret: secret }}>
					<CheckoutForm slug={slug} onPurchaseComplete={onPurchaseComplete} />
				</CheckoutElementsProvider>
			)}
		</div>
	);
}

// SPDX-License-Identifier: Apache-2.0
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult, CheckoutResponse } from "@anthers/web-shared/types";
import {
	CheckoutElementsProvider,
	PaymentElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { useEffect, useState } from "react";
import { getStripe } from "../../lib/stripe";
import CheckoutBillingAddressBlock from "../payments/CheckoutBillingAddressBlock";
import {
	mayConfirm,
	sessionTotals,
	useSessionBillingAddress,
} from "../payments/useSessionBillingAddress";
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
	/** Null — the tax is resolved by Stripe Tax at the session, from the buyer's address. */
	salesTax: string | null;
	buyerTotal: string | null;
}

/**
 * The server-computed receipt. Tax is resolved by Stripe Tax at the session, from the
 * buyer's billing address — so the receipt carries the quote's price breakdown plus,
 * once the address is on the session, the real tax the session resolved and the
 * tax-inclusive total. Before that, the tax line is named as coming rather than shown:
 * an "estimated" figure here would be the flat-rate charge this flow exists to retire,
 * one screen earlier.
 */
function receiptFromQuote(q: Quote, sessionBuyerTotal: number | null, sessionTax: number | null) {
	const n = (s: string) => Number(s);
	const lines: { label: string; amount: number; note?: string; added?: boolean }[] = [];
	// Everything except tax comes OUT of the listed price. The retired fee fields
	// (`crfFee`, `deliveryFee`) left the quote when their columns left the purchase row —
	// both were structurally zero since 2026-08, and a quote that still carried them
	// would be promising a deduction the server can no longer take.
	lines.push({ label: "Card processing", amount: n(q.processingFee), note: "at cost" });
	if (sessionTax !== null) {
		lines.push({
			label: "Sales tax",
			// `sessionTax` is already a number of dollars (sessionTotals converts cents).
			amount: sessionTax,
			note: "from your address",
			added: true,
		});
	}
	return {
		price: n(q.amount),
		// `sessionBuyerTotal` is already a number of dollars (sessionTotals converts cents).
		buyerTotal: sessionBuyerTotal !== null ? sessionBuyerTotal : n(q.amount),
		lines,
		creatorReceives: n(q.amount) - n(q.processingFee),
	};
}

/**
 * The Checkout form, inside `CheckoutElementsProvider`.
 *
 * The Payment Element collects the card and nothing else — the billing address is
 * collected by Anthers' own US-only form (`CheckoutBillingAddressBlock`) and submitted
 * to the session as its own step before confirm, because Stripe's Checkout-flavored
 * Billing Address Element offers no country allow-list and the posture sells to US
 * billing addresses only. The session itself — created server-side — carries the line
 * item's tax code and the automatic-tax setting; this side collects the address,
 * resolves the tax onto the session, and confirms.
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
	const billing = useSessionBillingAddress(checkoutState);

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

	// What the session itself totals once the address is on it: the tax-inclusive figure
	// the buyer is charged and the tax that was added. Null until the address resolves —
	// the buyer sees "+ tax" rather than a number nobody has calculated yet.
	const totals = checkoutState.type === "success" ? sessionTotals(checkoutState.checkout) : null;

	// The receipt's buyer total is the session's once the address resolved the tax, and
	// the price itself until then — with the tax line named as coming rather than shown.
	const receipt = quote
		? receiptFromQuote(quote, totals?.buyerTotal ?? null, totals?.tax ?? null)
		: null;

	// 🚨 Two gates, and neither implies the other. `canConfirm` is Stripe's readiness for
	// the Payment Element; `accepted` is our own record that the session took a US
	// address. A buyer must clear both: no card, no confirm; no address, no confirm.
	const canConfirm =
		checkoutState.type === "success" &&
		mayConfirm(checkoutState.checkout.canConfirm, billing.accepted);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		// The address must already be on the session — its own submit step resolved the
		// tax and re-armed this gate. Confirming without one would charge a buyer whose
		// rate was never resolved, which is what the gate exists to prevent.
		if (checkoutState.type !== "success" || !billing.accepted) return;

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
			// rate from the address the form submitted onto the session.
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

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{receipt ? (
				<TransparentReceipt {...receipt} />
			) : (
				/* Decorative: the button below already announces "Loading price…". */
				<div className="skeleton h-40 w-full" aria-hidden="true" />
			)}

			{/* Anthers' own US-only form, not Stripe's Billing Address Element — the element
			    offers no country allow-list, so this form is US by construction. Submitting
			    it resolves the session's tax, which is what fills the receipt's real total. */}
			<CheckoutBillingAddressBlock billing={billing} />

			<div className="border border-base-300 rounded-lg p-3 bg-base-100">
				{/* `fields.billingDetails: "never"` because the address above already
				    collected everything AVS would check — asking twice on one screen is
				    the double collection this option exists to prevent. The card's own
				    AVS check runs against the session's address (the one
				    `updateBillingAddress` wrote), so nothing is lost by not re-asking. */}
				<PaymentElement options={{ fields: { billingDetails: "never" } }} />
			</div>

			<p className="text-xs text-base-content/50">
				Sales tax is calculated from your billing address — the rate varies by location, and Anthers
				sells to US billing addresses at launch.
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
						? totals?.buyerTotal
							? `Buy for $${totals.buyerTotal.toFixed(2)}`
							: `Buy for $${receipt.buyerTotal.toFixed(2)} + tax`
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

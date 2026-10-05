// SPDX-License-Identifier: Apache-2.0
/**
 * The price side of a purchasable Work — and nothing beyond it.
 *
 * 🚨 **There is no payment form here, and none may come back.** Until 2026-10-03 this
 * component mounted a whole checkout — its own session POST, its own
 * `CheckoutElementsProvider`, an address block, a confirm button — nested inside the Work
 * page's tree. That shipped three live defects in one purchase: a `<form>` inside the
 * page's `<form>`-shaped tree (hydration error, undefined submit behavior), a session
 * POST fired on mount for every user who merely scrolled past a price, and a dead end
 * whenever the session refused. Parker's decision the same day: **every purchase goes
 * through the basket.** Checkout exists once now, embedded on `/basket`
 * (`BasketCheckout`) — this component quotes the price, offers the two doors into that
 * flow, and renders nothing that touches a card.
 */

import { client } from "@anthers/web-shared/rpc";
import type { AccessResult } from "@anthers/web-shared/types";
import { useEffect, useState } from "react";
import AddToBasket from "../basket/AddToBasket";
import BuyNow from "../basket/BuyNow";

interface ProjectPricingProps {
	workId: number;
	slug: string;
	access: AccessResult;
	title: string;
	creatorHandle: string;
	thumbnail?: string | null;
	creatorHasStripe?: boolean;
}

interface Quote {
	amount: string;
	processingFee: string;
	/** Null — the tax is resolved by Stripe Tax at the session, from the buyer's address. */
	salesTax: string | null;
	buyerTotal: string | null;
}

export default function ProjectPricing({
	workId,
	slug,
	access,
	title,
	creatorHandle,
	thumbnail,
	creatorHasStripe = false,
}: ProjectPricingProps) {
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteError, setQuoteError] = useState<string | null>(null);

	// The quote is fetched unconditionally — hooks must run in the same order on every
	// render, and the early returns below (free, owned, signed out) would skip one if
	// this sat where it is used. The fetch is wasted on those branches; it was wasted
	// the same way for the session POST this rewrite retired, and that POST is gone.
	useEffect(() => {
		let canceled = false;
		setQuote(null);
		setQuoteError(null);
		client.api.payments.quote[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (canceled) return;
				const body = (await res.json().catch(() => null)) as (Quote & { error?: string }) | null;
				if (!res.ok) {
					// The server's own refusal — "already have access", "below what a card
					// payment can process" — is the information; the surface says it.
					setQuoteError(body?.error ?? "We couldn't price this purchase right now.");
					return;
				}
				if (body) setQuote(body);
			})
			.catch(() => {
				if (!canceled) setQuoteError("We couldn't price this purchase right now.");
			});
		return () => {
			canceled = true;
		};
	}, [slug]);

	// Free posts have nothing to sell.
	if (access.isFree) return null;

	// The listed price arrives as a string in dollars — no client-side money arithmetic
	// happens here; `toFixed(2)` formats, it never computes.
	const price = Number(access.price ?? "0");
	const basketProps = {
		workId,
		slug,
		title,
		price: access.price ?? quote?.amount ?? "0",
		creatorHandle,
		thumbnail: thumbnail ?? null,
	};

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
				<div className="space-y-3">
					{quote ? (
						<div className="text-sm space-y-1">
							<div className="flex justify-between">
								<span>Listed price</span>
								<span className="tabular-nums">${quote.amount}</span>
							</div>
							<div className="flex justify-between text-base-content/60">
								<span>
									Card processing <span className="text-xs">at cost</span>
								</span>
								<span className="tabular-nums">−${quote.processingFee}</span>
							</div>
							<div className="flex justify-between text-base-content/60">
								<span>Sales tax</span>
								<span className="text-xs">calculated at checkout</span>
							</div>
							<div className="flex justify-between font-semibold">
								<span>You pay</span>
								<span className="tabular-nums">${quote.buyerTotal ?? quote.amount} + tax</span>
							</div>
						</div>
					) : quoteError ? (
						<div className="alert alert-warning text-sm">
							<span>{quoteError}</span>
						</div>
					) : (
						// Skeleton for the quote box only — the two buttons below are live the
						// whole time, because neither needs the quote: the price is `access.price`,
						// and nothing the quote would say changes whether buying is possible.
						<div className="skeleton h-24 w-full" aria-hidden="true" />
					)}

					<div className="flex flex-wrap items-center gap-2">
						<BuyNow {...basketProps} />
						<AddToBasket {...basketProps} />
					</div>
					<p className="text-xs text-base-content/50">
						Sales tax is calculated from your billing address at checkout — the rate varies by
						location, and Anthers sells to US billing addresses at launch.
					</p>
				</div>
			)}
		</div>
	);
}

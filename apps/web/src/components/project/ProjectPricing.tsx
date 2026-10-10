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
import MerchBuyPanel from "../merch/MerchBuyPanel";

interface ProjectPricingProps {
	workId: number;
	slug: string;
	/**
	 * The viewer's verdict. Absent on the owner's own serialization (the owner's shape
	 * carries the editable rows, which read as no verdict at all) — and the merch path
	 * never reads it, since a goods Work's price is the store's, not an access posture's.
	 */
	access?: AccessResult;
	title: string;
	creatorHandle: string;
	thumbnail?: string | null;
	creatorHasStripe?: boolean;
	/** The Work's type — `physical` renders the merch panel rather than the basket doors. */
	workType?: string;
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
	workType,
}: ProjectPricingProps) {
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteError, setQuoteError] = useState<string | null>(null);

	// The quote is fetched unconditionally — hooks must run in the same order on every
	// render, and the early returns below (free, owned, signed out) would skip one if
	// this sat where it is used. The fetch is wasted on those branches; it was wasted
	// the same way for the session POST this rewrite retired, and that POST is gone.
	//
	// ⚠️ Except for a merch Work, where the fetch isn't just wasted, it's noise: the
	// store panel derives its price from `merch_variants`, the generic quote's
	// verdicts are meaningless on a physical Work (the resolver's goods verdict
	// prices it `null`), and a signed-out visitor got a console 401 on every view.
	// The guard lives INSIDE the effect so the hook order never depends on it.
	useEffect(() => {
		if (workType === "physical") return;
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
	}, [slug, workType]);

	// A merch Work's pricing panel is the merch panel — the size picker and the
	// derived price replace the creator doors entirely (a merch sale has no connected
	// creator and no transfer; `creatorHasStripe` is meaningless on it).
	//
	// 🚨 Before the free check, deliberately: a goods Work is never free by its
	// access row. The row only opens the page; the store's own prices are the
	// price (Parker, 2026-10-09 — one price source, and it is not the access
	// table), so the isFree posture the resolver carries on digital work must
	// never be able to erase the store. The panel also mounts for the owner and a
	// revisiting buyer, whose verdicts are `canAccess` — a goods store is where
	// buying happens again, not a gate that opened once.
	if (workType === "physical") {
		return <MerchBuyPanel workId={workId} slug={slug} title={title} />;
	}

	// Free posts have nothing to sell.
	if (access?.isFree) return null;

	// The listed price arrives as a string in dollars — no client-side money arithmetic
	// happens here; `toFixed(2)` formats, it never computes.
	const price = Number(access?.price ?? "0");
	const basketProps = {
		workId,
		slug,
		title,
		price: access?.price ?? quote?.amount ?? "0",
		creatorHandle,
		thumbnail: thumbnail ?? null,
	};

	return (
		/* The purchase panel: one composed card, paired beside the locked preview on a wide
		   display (`WorkPage`'s grid stretches it to the preview's height; on a phone it
		   stacks). The price is the panel's headline — the row breakdown sits under it on
		   its own quiet ground, and the two doors into the basket anchor the bottom. */
		<div className="card bg-base-200 border border-base-300 h-full">
			<div className="card-body p-5 gap-4 flex flex-col items-start text-start">
				<div>
					<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-1">
						Pricing
					</h2>
					{/* The listed price arrives as a string in dollars — no client-side money
					    arithmetic happens here; `toFixed(2)` formats, it never computes. */}
					<p className="text-3xl font-bold leading-none tabular-nums">${price.toFixed(2)}</p>
				</div>

				{access?.canAccess ? (
					<div className="badge badge-success badge-lg gap-1">Owned</div>
				) : !access?.requiresPurchase ? (
					<p className="text-sm text-base-content/60">Sign in to purchase this Work.</p>
				) : !creatorHasStripe ? (
					<p className="text-sm text-base-content/60">
						Payments not available yet—the creator hasn't connected Stripe.
					</p>
				) : (
					<>
						{quote ? (
							/* The composition of the price, on its own quiet ground. The listed
							   price is the headline above, so the rows start at the card fee. */
							<dl className="w-full rounded-lg bg-base-100 p-3 text-sm space-y-1.5">
								<div className="flex justify-between text-base-content/60">
									<dt>
										Card processing <span className="text-xs">at cost</span>
									</dt>
									<dd className="tabular-nums">−${quote.processingFee}</dd>
								</div>
								<div className="flex justify-between text-base-content/60">
									<dt>Sales tax</dt>
									<dd className="text-xs">calculated at checkout</dd>
								</div>
								<div className="flex justify-between font-semibold border-t border-base-300 pt-1.5">
									<dt>You pay</dt>
									<dd className="tabular-nums">${quote.buyerTotal ?? quote.amount} + tax</dd>
								</div>
							</dl>
						) : quoteError ? (
							<div className="alert alert-warning text-sm">
								<span>{quoteError}</span>
							</div>
						) : (
							// Skeleton for the quote box only — the two buttons below are live the
							// whole time, because neither needs the quote: the price is
							// `access.price`, and nothing the quote would say changes whether
							// buying is possible.
							<div className="skeleton h-24 w-full" aria-hidden="true" />
						)}

						<div className="grid gap-2 w-full mt-auto">
							<BuyNow {...basketProps} />
							<AddToBasket {...basketProps} />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

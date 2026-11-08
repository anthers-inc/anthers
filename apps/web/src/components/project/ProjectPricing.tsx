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
 * through the cart.** Checkout exists once now, embedded on `/cart`
 * (`CartCheckout`) — this component quotes the price, offers the doors into that flow, and
 * renders nothing that touches a card.
 *
 * ⭐ **A signed-out visitor meets the reason, not a server error** (Parker, 2026-11-07).
 * The quote is an authenticated read, so asking it without a session answers 401
 * "Authentication required" — which this card used to print verbatim in a warning box
 * above live Buy Now and Add to Cart buttons. Now the card asks for the account instead:
 * one panel that says what the purchase is tied to, the two doors that provide one, and
 * the price story a signed-out visitor can honestly be told. Add to Cart stays, because a
 * signed-out visitor's scratch cart is real and merges at sign-in (`lib/cart.ts`); Buy Now
 * does not, because it has nowhere to go until there is an account.
 */

import { withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { Link, useLocation } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult } from "@anthers/web-shared/types";
import { UserCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import AddToCart from "../cart/AddToCart";
import BuyNow from "../cart/BuyNow";
import PhysicalStorePanel from "../work/PhysicalStorePanel";

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
	/** The Work's type — `physical` renders the store panel instead of an unlock price. */
	workType?: string;
	/** The creator's own view of a physical good: its fields carry pencils. */
	owner?: boolean;
}

interface Quote {
	amount: string;
	processingFee: string;
	/** Null — the tax is resolved by Stripe Tax at the session, from the buyer's address. */
	salesTax: string | null;
	buyerTotal: string | null;
}

/**
 * The signed-out purchase card: why an account is required, and the two doors that
 * provide one.
 *
 * It stands where the quote breakdown stands for a signed-in buyer and borrows
 * `InlineUnlock`'s `UnlockCard` shape — an icon, a heading, a plain-spoken reason and the
 * doors — so the two places the app asks for an account do not read as two different
 * things. Both doors carry this Work as `next`, so the buyer comes back to the purchase
 * rather than to the feed.
 */
function SignInToBuy({ back }: { back: string }) {
	return (
		<div className="w-full rounded-lg bg-base-100 p-4">
			<div className="flex items-start gap-3">
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-base-300">
					<UserCircleIcon className="h-5 w-5 text-base-content/70" aria-hidden="true" />
				</div>
				<div className="min-w-0">
					<h3 className="font-semibold">Sign in to buy</h3>
					<p className="mt-1 text-sm leading-relaxed text-base-content/60">
						Purchases are tied to your Anthers account: anything you buy stays in your Library, with
						its receipt. Creating an account is free.
					</p>
				</div>
			</div>
			<div className="mt-4 grid gap-2">
				<Link to={withNextPath("/login", back)} className="btn btn-primary w-full">
					Log in
				</Link>
				<Link to={withNextPath("/signup", back)} className="btn btn-ghost btn-sm w-full">
					Create a free account
				</Link>
			</div>
			{/* The fee and the tax are the two things a buyer asks about next, and the
			    quote that itemizes them is the authenticated read this card cannot make.
			    What is true without it is still worth saying. */}
			<p className="mt-3 text-xs leading-relaxed text-base-content/50">
				The listed price includes the at-cost card processing fee. Sales tax is added at checkout.
			</p>
		</div>
	);
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
	owner = false,
}: ProjectPricingProps) {
	const { isAuthenticated, isLoading: authLoading } = useAuth();
	const location = useLocation();
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteError, setQuoteError] = useState<string | null>(null);
	/** The quote answered 401 — a session the server does not accept. */
	const [quoteNeedsAuth, setQuoteNeedsAuth] = useState(false);

	// The quote is fetched in an effect rather than where it is used because hooks must
	// run in the same order on every render, and the branches below return early.
	//
	// 🚨 **It waits for a session.** The quote is an authenticated read, so asking it
	// signed out (or while auth is still resolving) is a guaranteed 401 — the
	// "Authentication required" box this card used to show. A signed-out buyer gets the
	// account panel instead, and the request is never made.
	//
	// ⚠️ Except on a goods Work, where the fetch is noise: the resolver prices a
	// physical Work `null` and checkout refuses it, and a signed-out visitor got a
	// console 401 on every view. The guard lives INSIDE the effect so the hook order
	// never depends on it.
	useEffect(() => {
		if (workType === "physical") return;
		setQuote(null);
		setQuoteError(null);
		setQuoteNeedsAuth(false);
		if (authLoading || !isAuthenticated) return;
		let canceled = false;
		client.api.payments.quote[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (canceled) return;
				if (res.status === 401) {
					// Signed in by the client's account of it, refused by the server: the
					// session is gone, so the card asks for one rather than printing the
					// middleware's own sentence at a buyer.
					setQuoteNeedsAuth(true);
					return;
				}
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
	}, [slug, workType, isAuthenticated, authLoading]);

	// A physical good renders its own panel — the pickers, the count and the shipping —
	// rather than the unlock-price card below. The goods rule still holds: the page reads
	// signed out, and the panel is where the buying happens.
	if (workType === "physical") {
		return (
			<PhysicalStorePanel
				slug={slug}
				workId={workId}
				title={title}
				creatorHandle={creatorHandle}
				thumbnail={thumbnail}
				owner={owner}
			/>
		);
	}

	// Free posts have nothing to sell.
	if (access?.isFree) return null;

	// The listed price arrives as a string in dollars — no client-side money arithmetic
	// happens here; `toFixed(2)` formats, it never computes.
	const price = Number(access?.price ?? "0");
	const cartProps = {
		workId,
		slug,
		title,
		price: access?.price ?? quote?.amount ?? "0",
		creatorHandle,
		thumbnail: thumbnail ?? null,
	};
	const back = `${location.pathname}${location.search}`;

	return (
		/* The purchase panel: one composed card, standing over the Work's cover. The price
		   is the panel's headline — the row breakdown sits under it on its own quiet
		   ground, and the doors into the cart anchor the bottom. */
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
				) : authLoading ? (
					// The account panel and the quote are the two shapes this space takes;
					// neither is known until auth resolves, so the space holds its size.
					<div className="skeleton h-24 w-full" aria-hidden="true" />
				) : !isAuthenticated || quoteNeedsAuth ? (
					<>
						<SignInToBuy back={back} />
						{/* The cart is intent, not a purchase: a signed-out scratch cart is
						    real and merges into the account at sign-in, so its door stays. */}
						<div className="w-full">
							<AddToCart {...cartProps} />
						</div>
					</>
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
							<BuyNow {...cartProps} />
							<AddToCart {...cartProps} />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

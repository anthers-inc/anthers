// SPDX-License-Identifier: Apache-2.0
/**
 * The basket: what you're about to buy, what it costs, and what buying it together saves.
 *
 * 🚨 **The saving is the whole reason this page exists**, so it is stated in money and
 * before the decision rather than after it. Stripe's fixed **$0.30 is per charge, not per
 * item** — five $1 tracks pay $1.65 in card fees bought one at a time and $0.45 bought
 * together — and because Anthers keeps nothing either way, every cent of that difference
 * is the creator's. A basket that merely batched clicks would not be worth building.
 *
 * Every figure here comes from `/basket/quote`, which computes it with the same
 * `calculateFees` that checkout charges from — and, once the checkout's billing address
 * resolves, the session's own tax-inclusive total joins it (reported up through
 * `BasketCheckout`'s `onTotals`). Nothing on this page does money arithmetic: a receipt
 * that derives its own totals stops reconciling the moment a dial moves, which is the
 * failure this codebase has already had twice.
 *
 * **Two columns, from the second live checkout (2026-10-03).** Checkout on the left —
 * the only column with buttons on it; the items and the receipt on the right, so the
 * buyer reads what they're buying beside where they pay for it. The checkout's column
 * never re-renders the checkout's input state: the work ids handed down are derived once
 * per basket content (`useMemo` — see `BasketCheckout`'s header for why that identity
 * was load-bearing), and totals reporting up only re-renders the receipt. Below `lg` the
 * grid stacks to one column in reading order: items, breakdown, checkout — you read
 * what you're buying before you pay for it. On desktop the two columns sit side by side
 * (`lg:grid-cols-2`), which is why the checkout renders FIRST in the JSX (it owns the
 * page's only form) and sits visually right via `lg:order-2`.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { creatorWorkUrl, profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ShoppingBagIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBasket } from "@/lib/basket";
import BasketCheckout, { workIdsKey } from "../components/basket/BasketCheckout";

interface Quote {
	items: { workId: number; slug: string; title: string | null; price: string }[];
	subtotal: string;
	processingFee: string;
	/** Null — the tax is resolved at the session, from the buyer's billing address. */
	salesTax: string | null;
	creatorEarnings: string;
	/** Null for the same reason as `salesTax` — the total lives in the session. */
	buyerTotal: string | null;
	feeSeparately: string;
	creatorGains: string;
}

/** The session's reported totals, in dollars — nulls before the address resolves. */
interface SessionTotals {
	buyerTotal: number | null;
	tax: number | null;
}

export default function BasketPage() {
	const { user } = useAuth();
	const { items, remove, clear, count } = useBasket();
	const [quote, setQuote] = useState<Quote | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	// The checkout's session totals, reported up once the billing address resolves —
	// what turns the receipt's tax line from "coming" into a real number.
	const [sessionTotals, setSessionTotals] = useState<SessionTotals | null>(null);
	// Cleared with the basket, so a completed purchase never leaves stale numbers up.
	const handleTotals = useCallback((t: SessionTotals | null) => setSessionTotals(t), []);

	const creator = items[0]?.creatorHandle ?? null;

	// 🚨 Derived ONCE per basket content, not per render — `items` is re-read from
	// storage on every basket event, so `items.map(...)` inline at the use site was a new
	// array identity on every render, and the checkout's session POST keyed on that
	// identity re-fired on the totals-reporting re-render, remounting the Payment
	// Element mid-fill (the first live checkout's worst defect). Stable identity here is
	// the belt; BasketCheckout keys on sorted CONTENT (the suspenders).
	const workIds = useMemo(() => items.map((i) => i.workId), [items]);
	/** The basket's CONTENT identity — what a re-quote actually keys on. */
	const contentKey = workIdsKey(workIds);

	// The quote's re-fire trigger is the basket's CONTENT — the sorted-id key below —
	// and never the `items` array identity, whose churn is exactly the re-firing the
	// first live checkout paid for. `useExhaustiveDependencies` wants the body's own
	// reads listed; the key is deliberately NOT one of them, so the suppression is the
	// honest form and the deps below carry only `workIds.length` beside it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the trigger is basket CONTENT, not a body value
	const refresh = useCallback(async () => {
		if (items.length === 0) {
			setQuote(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			// The body carries nothing: the server prices the account's own stored basket,
			// never a list the client named — that trust ended with the localStorage
			// design. Which contents this call prices is decided by the effect below —
			// it re-fires on a change of the basket's CONTENT (the sorted ids), not on
			// array identity, so a totals-reporting re-render re-quotes nothing.
			const res = await client.api.payments.basket.quote.$post({ json: {} });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "Couldn't price your basket.");
				setQuote(null);
				return;
			}
			setQuote((await res.json()) as unknown as Quote);
		} catch {
			setError("Couldn't price your basket.");
		} finally {
			setLoading(false);
		}
	}, [contentKey, workIds.length]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (count === 0) {
		return (
			<div className="container mx-auto max-w-2xl px-4 py-12">
				<EmptyState
					icon={<ShoppingBagIcon className="w-12 h-12" />}
					title="Your basket is empty"
					description="Add a few things from one creator and buy them together — the card fee is charged once per purchase, not once per item, so buying together leaves more with them."
				/>
			</div>
		);
	}

	const taxResolved = sessionTotals?.buyerTotal != null;

	// The receipt, in two states of the same set of numbers. From the quote: subtotal
	// and the at-cost card fee, with tax named as coming. From the session (once the
	// billing address resolved the rate): the real tax and the tax-inclusive total —
	// `sessionTotals`' dollars, formatted, never recomputed here. One figure set the
	// buyer reads top to bottom, in any column they find it in.
	const receipt = quote ? (
		<>
			<div className="rounded-lg border border-base-300 p-4 text-sm" data-testid="basket-receipt">
				<div className="flex justify-between py-1">
					<span>Subtotal</span>
					<span className="tabular-nums">${quote.subtotal}</span>
				</div>
				<div className="flex justify-between py-1 text-base-content/60">
					<span>
						Card processing{" "}
						<span className="text-xs">at cost — taken from the price, not added to it</span>
					</span>
					<span className="tabular-nums">−${quote.processingFee}</span>
				</div>
				{taxResolved ? (
					<div className="flex justify-between py-1 text-base-content/60">
						<span>
							Sales tax <span className="text-xs">from your address</span>
						</span>
						<span className="tabular-nums">+${(sessionTotals?.tax ?? 0).toFixed(2)}</span>
					</div>
				) : (
					<div className="flex justify-between py-1 text-base-content/60">
						<span>Sales tax</span>
						<span className="text-xs">calculated from your address</span>
					</div>
				)}
				<div className="mt-2 flex justify-between border-t border-base-300 pt-2 font-semibold">
					<span>You pay</span>
					<span className="tabular-nums" data-testid="basket-total">
						{taxResolved
							? `$${(sessionTotals?.buyerTotal ?? 0).toFixed(2)}`
							: `$${quote.subtotal} + tax`}
					</span>
				</div>
				<div className="mt-1 flex justify-between text-success">
					<span>{creator} receives</span>
					<span className="tabular-nums">${quote.creatorEarnings}</span>
				</div>
			</div>
			{/*
			 * Only shown when it is actually non-zero — a "you saved $0.00" on a
			 * single-item basket would teach the reader to ignore the line that
			 * matters. Anthers keeps nothing either way, so the saving is not ours
			 * to share: it is entirely the creator's, and the copy says so.
			 */}
			{Number(quote.creatorGains) > 0 && (
				<p className="mt-3 rounded-lg bg-success/10 p-3 text-sm text-success-content">
					Buying these together sends <strong>${quote.creatorGains} more</strong> to {creator} than
					buying them one at a time would. The card fee is charged once per purchase rather than
					once per item, and Anthers keeps none of it either way.
				</p>
			)}
		</>
	) : null;

	// The items list carries its remove buttons; removing an item is a basket-content
	// change, which is what legitimately re-runs the checkout's session fetch.
	const itemsList = (
		<ul
			className="divide-y divide-base-300 rounded-lg border border-base-300"
			data-testid="basket-items"
		>
			{items.map((item) => (
				<li key={item.workId} className="flex items-center gap-3 p-3">
					<div className="min-w-0 flex-1">
						<Link to={creatorWorkUrl(item.creatorHandle, item.slug)} className="link-hover">
							<span className="block truncate text-sm font-medium">{item.title}</span>
						</Link>
					</div>
					<span className="shrink-0 text-sm tabular-nums">${item.price}</span>
					<button
						type="button"
						className="btn btn-ghost btn-xs shrink-0"
						onClick={() => remove(item.workId)}
						aria-label={`Remove ${item.title}`}
					>
						<XMarkIcon className="w-4 h-4" />
					</button>
				</li>
			))}
		</ul>
	);

	return (
		<div className="container mx-auto max-w-6xl px-4 py-8">
			<h1 className="text-2xl font-bold mb-1">Your basket</h1>
			{creator && (
				<p className="text-sm text-base-content/60 mb-6">
					Work by{" "}
					<Link to={profileUrl(creator)} className="link link-hover font-medium">
						{creator}
					</Link>
					. A basket holds one creator at a time, because each is paid directly.
				</p>
			)}

			{error && (
				<div className="alert alert-error text-sm mb-4">
					<span className="block">{error}</span>
					{/* No dead ends: the quote can be asked for again in place — a basket page
					    that needed a reload to re-price itself would be one the buyer has to
					    trust on faith. */}
					<button
						type="button"
						className="btn btn-outline btn-xs mt-2"
						onClick={() => void refresh()}
					>
						Try again
					</button>
				</div>
			)}

			{loading && !quote ? (
				<div className="flex justify-center py-6">
					<LoadingSpinner size="sm" />
				</div>
			) : quote ? (
				/*
				 * The two columns. DOM order is checkout first (its form is the page's only
				 * one), visually right at `lg`; on mobile the flex column reads items →
				 * receipt → checkout, in that DOM order via the `order` utilities.
				 */
				<div className="flex flex-col gap-8 lg:grid lg:grid-cols-2 lg:gap-12">
					<section className="order-3 lg:order-2" data-testid="basket-checkout-column">
						{user ? (
							<BasketCheckout
								workIds={workIds}
								buyerTotal={quote.subtotal}
								onTotals={handleTotals}
								onComplete={() => {
									setSessionTotals(null);
									// The server already emptied the stored basket when the checkout
									// session was built; this clears this hook's cache. Awaiting it
									// (async in server mode) before the quote refresh stops the
									// receipt from being re-quoted off a half-cleared basket.
									void Promise.resolve(clear()).then(() => void refresh());
								}}
							/>
						) : (
							<Link to="/login" className="btn btn-primary w-full">
								Log in to buy
							</Link>
						)}
					</section>
					<aside className="order-1 lg:order-1 space-y-4" data-testid="basket-items-column">
						{itemsList}
						{receipt}
					</aside>
				</div>
			) : null}
		</div>
	);
}

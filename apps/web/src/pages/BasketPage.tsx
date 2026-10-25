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
 * **Two columns, from the second live checkout (2026-10-03), flipped by Parker the next
 * day (2026-10-04): the form belongs LEFT and the pricing right.** Checkout on the
 * left — the column the buyer fills out, the only one with buttons on it; the pricing on
 * the right. The right column carries TWO cards (Parker, 2026-10-06): **Payment** — the
 * buyer's statement, subtotal + tax − discounts = the total they pay — and **Basket** —
 * the items grouped by creator, each group topped by what the creator receives with an
 * (i) naming the card fee taken out of their part. The two statements never mix inside
 * one card: the card fee is the price's cost, not the buyer's, and a card that showed
 * both read as a mystery deduction on the buyer's own total. The checkout's column never
 * re-renders the checkout's input state: the work ids handed down are derived once per
 * basket content (`useMemo` — see `BasketCheckout`'s header for why that identity was
 * load-bearing), and totals reporting up only re-renders these cards. Below `lg` the
 * grid stacks to one column in reading order: payment, basket, checkout — you read
 * what you pay, then what you're buying, before you pay for it. On desktop the two
 * columns sit side by side (`lg:grid-cols-2`), which is why the checkout renders FIRST
 * in the JSX (it owns the page's only form) and sits left (`lg:order-1`).
 */

import { CARD_FLAT, CARD_RATE } from "@anthers/shared/constants";
import { withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { creatorWorkUrl, profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ShoppingBagIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { basketContentKey, useBasket } from "@/lib/basket";
import BasketCheckout from "../components/basket/BasketCheckout";

/**
 * The Sales Tax tooltip's sentence, in the two states the derivation can be in: before
 * the address resolves it explains the mechanism; once it does, it names the rate, the
 * address and the figures it produced — read off the session's report, never recomputed.
 */
function salesTaxDerivation(totals: SessionTotals | null, quote: Quote): string {
	const address = totals?.addressSummary;
	if (totals?.tax != null) {
		const head =
			totals.taxPercentage != null
				? `The rate is ${totals.taxPercentage}%, from your billing address${address ? ` (${address})` : ""}: $${quote?.subtotal ?? "0.00"} × ${totals.taxPercentage}% = $${totals.tax.toFixed(2)}.`
				: `The rate is the one Stripe Tax resolved from your billing address${address ? ` (${address})` : ""}: $${totals.tax.toFixed(2)} on this basket.`;
		return `${head} Anthers collects it as marketplace facilitator and remits it; creators receive none of it.`;
	}
	return "Added on top of the price and calculated from your billing address by Stripe Tax once the address above is filled in — never estimated, never pocketed: Anthers remits every cent.";
}

interface Quote {
	/**
	 * The receipt's lines, in basket order — a Work or a Badge rung each, discriminated.
	 * A Badge line carries the rung's monthly price beside the first transaction's, so an
	 * upgrade line can read as the upgrade it is.
	 */
	items: (
		| {
				kind: "work";
				workId: number;
				slug: string;
				title: string | null;
				type: string;
				thumbnail: string | null;
				processingFee: string;
				price: string;
				recurring: null;
		  }
		| {
				kind: "badge";
				badgeId: number;
				title: string | null;
				thumbnail: null;
				processingFee: string;
				price: string;
				recurring: string;
		  }
	)[];
	/** One entry per creator the charge covers, with the server-computed receives figure. */
	creators: {
		handle: string | null;
		itemCount: number;
		receives: string;
	}[];
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

/**
 * The session's reported totals, in dollars — nulls before the address resolves. The
 * accepted address and the rate's percentage ride along so the Payment card's Sales Tax
 * tooltip can name the actual derivation, and any discount joins as its own row — one
 * report rather than a second channel.
 */
interface SessionTotals {
	buyerTotal: number | null;
	tax: number | null;
	discount: number | null;
	taxPercentage: number | null;
	addressSummary: string | null;
}

export default function BasketPage() {
	const { user } = useAuth();
	const { items, remove, clear, count } = useBasket();
	const [quote, setQuote] = useState<Quote | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	// The session's reported state, reported up once the billing address resolves —
	// what turns the Payment card's tax line from "coming" into a real number and its
	// tooltip from generic into the actual derivation.
	const [sessionTotals, setSessionTotals] = useState<SessionTotals | null>(null);
	// Cleared with the basket, so a completed purchase never leaves stale numbers up.
	const handleTotals = useCallback((t: SessionTotals | null) => setSessionTotals(t), []);

	/**
	 * The creator groups the Basket card renders — one per distinct creator, with each
	 * group's receives figure read straight off the quote (server-computed, never derived
	 * here: a receipt that computes its own totals stops reconciling the moment a dial
	 * moves). The lines join their group through the basket's own items, which are what
	 * carry the creator handle; a quote line whose item left the basket mid-render simply
	 * matches no group and renders nowhere.
	 */
	const groups = useMemo(() => {
		if (!quote) return [];
		return quote.creators
			.filter((c) => c.handle != null)
			.map((c) => ({
				handle: c.handle as string,
				receives: c.receives,
				lines: quote.items.filter((line) => {
					const held =
						line.kind === "badge"
							? items.find((i) => i.kind === "badge" && i.badgeId === line.badgeId)
							: items.find((i) => i.kind === "work" && i.workId === line.workId);
					return held?.creatorHandle === c.handle;
				}),
			}));
	}, [items, quote]);

	// 🚨 Derived ONCE per basket content, not per render — `items` is re-read from
	// storage on every basket event, so an inline mapping at the use site was a new
	// array identity on every render, and the checkout's session POST keyed on that
	// identity re-fired on the totals-reporting re-render, remounting the Payment
	// Element mid-fill (the first live checkout's worst defect). Stable identity here is
	// the belt; BasketCheckout keys on sorted CONTENT by the same key (the suspenders).
	const contentKey = basketContentKey(items);

	// The quote's re-fire trigger is the basket's CONTENT — the kind-tagged sorted key above —
	// and never the `items` array identity, whose churn is exactly the re-firing the
	// first live checkout paid for. `useExhaustiveDependencies` wants the body's own
	// reads listed; the key is deliberately NOT one of them, so the suppression is the
	// honest form and the deps below carry only `items.length` beside it.
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
	}, [contentKey, items.length]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (count === 0) {
		return (
			<div className="container mx-auto max-w-2xl px-4 py-12">
				<EmptyState
					icon={<ShoppingBagIcon className="w-12 h-12" />}
					title="Your Basket is empty"
					description="Add a few things — from one creator or many — and buy them together. The card fee is charged once per purchase, not once per item, so buying together leaves more with them."
				/>
			</div>
		);
	}

	const taxResolved = sessionTotals?.buyerTotal != null;

	// The right column's two cards (Parker, 2026-10-06), each a statement that never
	// mixes with the other, in the order he named them — Payment above, Basket under:
	//
	// **Payment** — what the buyer pays: the items' subtotal, plus sales tax once the
	// billing address resolved the rate, less any discount, ending in the tax-inclusive
	// total. From the quote before the address lands; from the session after —
	// `sessionTotals`' dollars, formatted, never recomputed here.
	//
	// **Basket** — what the buyer is buying: the items grouped by creator, one group per
	// creator the charge covers (any number since 2026-10-15), each topped by the
	// creator's receives line — the headline of the
	// group, beside their name — with an (i) naming the card fee taken out of their part
	// of the basket, pro-rata by item value. Anthers keeps none of it: the fee goes to
	// the processor, which is exactly what the tooltip says.
	//
	// The card fee is the price's cost, not the buyer's, so it appears nowhere in the
	// Payment card — its only buyer-visible effect is the smaller receives figure, whose
	// tooltip explains it.
	const paymentCard = quote ? (
		<div className="rounded-lg border border-base-300 p-4" data-testid="basket-receipt">
			<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-base-content/60">
				Payment
			</h2>
			<div className="text-sm">
				<div className="flex justify-between py-1">
					<span>
						Subtotal ({items.length} {items.length === 1 ? "item" : "items"})
					</span>
					<span className="tabular-nums">${quote.subtotal}</span>
				</div>
				{taxResolved ? (
					<div className="flex items-center justify-between py-1 text-base-content/60">
						<span className="flex items-center">
							Sales Tax
							<InfoTip text={salesTaxDerivation(sessionTotals, quote)} />
						</span>
						<span className="tabular-nums" data-testid="basket-tax">
							+${(sessionTotals?.tax ?? 0).toFixed(2)}
						</span>
					</div>
				) : (
					<div className="flex items-center justify-between py-1 text-base-content/60">
						<span className="flex items-center">
							Sales Tax
							<InfoTip text="Added on top of the price and calculated from your billing address by Stripe Tax once the address above is filled in — never estimated, never pocketed: Anthers remits every cent." />
						</span>
						<span className="text-xs">calculated from your address</span>
					</div>
				)}
				{Number(sessionTotals?.discount) > 0 && (
					<div className="flex justify-between py-1 text-base-content/60">
						<span>Discount</span>
						<span className="tabular-nums" data-testid="basket-discount">
							−${(sessionTotals?.discount ?? 0).toFixed(2)}
						</span>
					</div>
				)}
				<div className="mt-2 flex justify-between border-t border-base-300 pt-2 font-semibold">
					<span>Total</span>
					<span className="tabular-nums" data-testid="basket-total">
						{taxResolved
							? `$${(sessionTotals?.buyerTotal ?? 0).toFixed(2)}`
							: `$${quote.subtotal} + tax`}
					</span>
				</div>
			</div>
		</div>
	) : null;

	const basketCard = quote ? (
		<div className="rounded-lg border border-base-300 p-4" data-testid="basket-card">
			<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-base-content/60">
				Basket
			</h2>
			<div className="flex flex-col gap-3">
				{groups.map((group) => (
					<div key={group.handle} className="rounded-lg bg-base-200/50 px-3 py-1">
						{/* The group's header: the creator and what they receive, set apart from
						    the items beneath — larger, semibold, the group's voice — with the
						    (i) riding the same trailing slot the remove buttons do and a
						    divider closing the header off from the list. The (i) names the fee
						    taken OUT of the earnings — the card fee is paid to the processor
						    out of the price, never kept by Anthers and never added for the
						    buyer. */}
						<div className="flex items-center justify-between gap-2 py-2.5">
							<span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
								<Link to={profileUrl(group.handle)} className="link link-hover">
									{group.handle}
								</Link>{" "}
								<span className="text-xs font-normal text-base-content/60">receives</span>
							</span>
							<span className="shrink-0 text-[15px] font-semibold tabular-nums text-success">
								<span data-testid="basket-creator-earns">${group.receives}</span>
							</span>
							<span className="flex w-6 shrink-0 items-center justify-center">
								<InfoTip
									align="right"
									text={`Each price is all-in: card processing (${(CARD_RATE * 100).toFixed(1)}% + $${CARD_FLAT.toFixed(2)}, at cost) is taken out of it, not added on top. This basket's one fee is split pro-rata by item value; Anthers keeps none of it.`}
								/>
							</span>
						</div>
						{/* The items nest under the header: indented beside a rule that hangs
						    off the group's left edge, smaller and quieter than the header —
						    the receipt's detail lines against the header's voice. The dividers
						    and the price column stay aligned with the Payment card's. */}
						<ul
							className="ml-3 divide-y divide-base-300 border-l border-base-300 pl-3"
							data-testid="basket-items"
						>
							{group.lines.map((item) => {
								// The list's own item record — the remove buttons work off the
								// BASKET's items (the source with handles), matched by id.
								const held =
									item.kind === "badge"
										? items.find((i) => i.kind === "badge" && i.badgeId === item.badgeId)
										: items.find((i) => i.kind === "work" && i.workId === item.workId);
								if (!held) return null;
								const isBadge = item.kind === "badge";
								const upgraded = isBadge && item.recurring !== item.price;
								return (
									<li
										key={isBadge ? `b${item.badgeId}` : `w${item.workId}`}
										className="flex items-center justify-between gap-2 py-2"
									>
										{isBadge ? (
											<Link
												to={`${profileUrl(group.handle)}?tab=badges`}
												className="min-w-0 flex-1 truncate text-sm text-base-content/80 link-hover"
											>
												<span className="block truncate">
													{item.title ?? "A Badge"}
													{upgraded && (
														<span className="ml-1.5 text-xs text-base-content/50">
															${item.recurring}/mo after
														</span>
													)}
												</span>
											</Link>
										) : (
											<Link
												to={creatorWorkUrl(group.handle, item.slug)}
												className="min-w-0 flex-1 truncate text-sm text-base-content/80 link-hover"
											>
												<span className="block truncate">{item.title ?? "Untitled"}</span>
											</Link>
										)}
										<span className="shrink-0 text-sm tabular-nums text-base-content/80">
											${item.price}
										</span>
										<span className="flex w-6 shrink-0 items-center justify-center">
											<button
												type="button"
												className="btn btn-ghost btn-xs px-0"
												onClick={() =>
													remove(
														item.kind === "badge"
															? { kind: "badge", badgeId: item.badgeId }
															: { kind: "work", workId: item.workId },
													)
												}
												aria-label={`Remove ${item.title ?? "item"}`}
											>
												<XMarkIcon className="w-4 h-4" />
											</button>
										</span>
									</li>
								);
							})}
						</ul>
					</div>
				))}
				{/*
				 * Only shown when it is actually non-zero — a "you saved $0.00" on a
				 * single-item basket would teach the user to ignore the line that
				 * matters. Anthers keeps nothing either way, so the saving is not ours
				 * to share: it is entirely the creators', and the copy says so.
				 */}
				{Number(quote.creatorGains) > 0 && (
					<p className="rounded-lg bg-success/10 p-3 text-sm text-success-content">
						Buying these together sends{" "}
						<strong>
							${quote.creatorGains} more to{" "}
							{groups.length === 1 ? groups[0].handle : "the creators"}
						</strong>{" "}
						than buying them one at a time would. The card fee is charged once per purchase rather
						than once per item, and Anthers keeps none of it either way.
					</p>
				)}
			</div>
		</div>
	) : null;

	return (
		<div className="container mx-auto max-w-6xl px-4 py-8">
			<h1 className="text-2xl font-bold mb-1">Your Basket</h1>
			{groups.length > 0 && (
				<p className="text-sm text-base-content/60 mb-6">
					Work by{" "}
					{groups.map((group, idx) => (
						<span key={group.handle}>
							{idx > 0 && (idx === groups.length - 1 ? " and " : ", ")}
							<Link to={profileUrl(group.handle)} className="link link-hover font-medium">
								{group.handle}
							</Link>
						</span>
					))}
					. One charge buys the whole basket; each creator receives their part.
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
				 * one), and since 2026-10-04 that column sits LEFT on desktop (`lg:order-1`)
				 * with the pricing cards right (`lg:order-2`); on mobile the flex column
				 * reads basket → payment → checkout via the `order` utilities.
				 */
				<div className="flex flex-col gap-8 lg:grid lg:grid-cols-2 lg:gap-12">
					<section className="order-3 lg:order-1" data-testid="basket-checkout-column">
						{user ? (
							<BasketCheckout
								contentKey={contentKey}
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
							// The signed-out detour, with the return trip attached: the buyer lands
							// back here after signing in or up, one `next` parameter away from the
							// basket they were about to pay for (the generalized purchase-path fix —
							// the same open-redirect-safe pattern the locked-post unlock panel uses).
							<Link to={withNextPath("/login", "/basket")} className="btn btn-primary w-full">
								Log in to buy
							</Link>
						)}
					</section>
					<aside className="order-1 lg:order-2 space-y-4" data-testid="basket-items-column">
						{paymentCard}
						{basketCard}
					</aside>
				</div>
			) : null}
		</div>
	);
}

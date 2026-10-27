// SPDX-License-Identifier: Apache-2.0
/**
 * The store panel on a physical Work's page — the pickers, the count, and what the buyer
 * will pay for it.
 *
 * 🚨 **Nothing here charges anything.** Like every other purchase door since 2026-10-03, the
 * two buttons put the line in the basket and send the buyer to the one checkout that
 * exists. What this panel adds is the choosing: the options the creator offers, how many,
 * and the money those choices come to.
 *
 * The panel reads signed out, which is the goods rule — a visitor may look at a mug exactly
 * as an account may, and an account is required only to buy. The quote is fetched only when
 * somebody is signed in, because its tax estimate resolves from a saved billing address.
 *
 * ⚠️ **Every number shown here is the server's.** The goods figure, the shipping and the tax
 * estimate all arrive from `/physical/:slug/quote`; nothing on this page multiplies, adds
 * or rounds. A panel that computed a total the checkout would not charge is the one defect
 * a store must never ship.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { BoltIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { useBasket } from "@/lib/basket";

interface ListingValue {
	label: string;
	stock: number | null;
}
interface ListingOption {
	name: string;
	values: ListingValue[];
}
interface Storefront {
	work: { id: number; title: string | null; slug: string | null };
	listing: {
		shippingPrice: string;
		handlingBusinessDays: number;
		taxCategory: string;
		options: ListingOption[];
	};
	unitPrice: string;
}
interface Quote {
	quantity: number;
	unitPrice: string;
	goods: string;
	shipping: string;
	salesTax: string | null;
	total: string | null;
	quotedTo: { city: string; state: string; postalCode: string } | null;
	handlingBusinessDays: number;
}

/** How many of one thing an order may carry — the server refuses more than this. */
const MAX_QUANTITY = 10;

function money(value: string): string {
	return `$${value}`;
}

export default function PhysicalStorePanel({
	slug,
	workId,
	title,
	creatorHandle,
	thumbnail,
	creatorHasStripe = false,
}: {
	slug: string;
	workId: number;
	title: string;
	creatorHandle: string;
	thumbnail?: string | null;
	creatorHasStripe?: boolean;
}) {
	const { user } = useAuth();
	const { add } = useBasket();
	const navigate = useNavigate();
	const [storefront, setStorefront] = useState<Storefront | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [quantity, setQuantity] = useState(1);
	const [picks, setPicks] = useState<Record<string, string>>({});
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteError, setQuoteError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	// The listing: what the creator offers, and the price of one.
	useEffect(() => {
		let stale = false;
		void (async () => {
			const res = await client.api.payments.physical[":slug"].$get({ param: { slug } });
			const body = (await res.json().catch(() => null)) as (Storefront & { error?: string }) | null;
			if (stale) return;
			if (!res.ok || !body) {
				setError(body?.error ?? "This good isn't for sale right now.");
				return;
			}
			setStorefront(body);
			// The first value of each choice, so the panel opens priced rather than blank.
			const initial: Record<string, string> = {};
			for (const option of body.listing.options) {
				const first = option.values.find((value) => value.stock !== 0);
				if (first) initial[option.name] = first.label;
			}
			setPicks(initial);
		})();
		return () => {
			stale = true;
		};
	}, [slug]);

	// The quote: the goods, the shipping and the estimated tax for exactly this pick.
	useEffect(() => {
		if (!storefront || !user) return;
		// Every choice must have a value before anything can be priced.
		if (storefront.listing.options.some((option) => !picks[option.name])) return;
		let stale = false;
		setQuoteError(null);
		void (async () => {
			const res = await client.api.payments.physical[":slug"].quote.$post({
				param: { slug },
				json: {
					quantity,
					options: Object.entries(picks).map(([name, label]) => ({ name, label })),
				},
			});
			const body = (await res.json().catch(() => null)) as (Quote & { error?: string }) | null;
			if (stale) return;
			if (!res.ok || !body) {
				// A sold-out value or a count past the shelf is the server's sentence, and
				// it replaces the last quote rather than sitting beside a stale one.
				setQuote(null);
				setQuoteError(body?.error ?? "That choice can't be priced right now.");
				return;
			}
			setQuote(body);
		})();
		return () => {
			stale = true;
		};
	}, [slug, storefront, user, picks, quantity]);

	if (error) {
		return (
			<div className="card bg-base-200 border border-base-300 h-full">
				<div className="card-body p-5">
					<p className="text-sm text-base-content/70">{error}</p>
				</div>
			</div>
		);
	}

	if (!storefront) {
		return (
			<div className="card bg-base-200 border border-base-300 h-full">
				<div className="card-body p-5">
					<div className="skeleton h-40 w-full" aria-hidden="true" />
				</div>
			</div>
		);
	}

	const { listing, unitPrice } = storefront;
	// The public read already prices at the viewer's own Access row, so this only covers the
	// window where the quote has resolved and the read has not kept up.
	const shownPrice = quote?.unitPrice ?? unitPrice;
	const soldOutPick = listing.options.some((option) => {
		const chosen = option.values.find((value) => value.label === picks[option.name]);
		return !chosen || chosen.stock === 0;
	});

	const basketItem = {
		kind: "work" as const,
		workId,
		slug,
		title,
		// The basket's own display price; the checkout re-resolves it either way.
		price: quote?.goods ?? unitPrice,
		creatorHandle,
		thumbnail: thumbnail ?? null,
		quantity,
		options: Object.entries(picks).map(([name, label]) => ({ name, label })),
	};

	const toBasket = async (thenBuy: boolean) => {
		if (!user) {
			navigate(`/login?next=${encodeURIComponent(`/works/${slug}`)}`);
			return;
		}
		setAdding(true);
		try {
			const result = await add(basketItem);
			if (!result.ok) {
				setQuoteError(result.error);
				return;
			}
			if (thenBuy) navigate("/basket");
		} finally {
			setAdding(false);
		}
	};

	return (
		<div className="card bg-base-200 border border-base-300 h-full">
			<div className="card-body p-5 gap-4 flex flex-col items-start text-start">
				<div>
					<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-1">
						Price
					</h2>
					<p className="text-3xl font-bold leading-none tabular-nums">{money(shownPrice)}</p>
					{Number(listing.shippingPrice) > 0 ? (
						<p className="text-sm text-base-content/60 mt-1">
							plus {money(listing.shippingPrice)} shipping
						</p>
					) : (
						<p className="text-sm text-base-content/60 mt-1">free shipping</p>
					)}
				</div>

				{listing.options.map((option) => (
					<fieldset key={option.name} className="w-full">
						<legend className="text-sm font-medium mb-1">{option.name}</legend>
						<div className="flex flex-wrap gap-1.5">
							{option.values.map((value) => {
								const chosen = picks[option.name] === value.label;
								return (
									<button
										key={value.label}
										type="button"
										aria-pressed={chosen}
										disabled={value.stock === 0}
										className={`btn btn-sm ${chosen ? "btn-primary" : "btn-outline"} ${
											value.stock === 0 ? "btn-disabled" : ""
										}`}
										onClick={() =>
											setPicks((current) => ({ ...current, [option.name]: value.label }))
										}
									>
										{value.label}
										{value.stock === 0 ? " — sold out" : ""}
									</button>
								);
							})}
						</div>
					</fieldset>
				))}

				<div className="flex items-center gap-2">
					<label className="text-sm font-medium" htmlFor="physical-quantity">
						How many
					</label>
					<div className="join">
						<button
							type="button"
							className="btn btn-sm join-item"
							aria-label="One fewer"
							disabled={quantity <= 1}
							onClick={() => setQuantity((n) => Math.max(1, n - 1))}
						>
							−
						</button>
						<input
							id="physical-quantity"
							className="input input-bordered input-sm join-item w-16 text-center tabular-nums"
							value={quantity}
							inputMode="numeric"
							onChange={(e) => {
								const next = Number(e.target.value);
								if (Number.isFinite(next) && next >= 1 && next <= MAX_QUANTITY)
									setQuantity(Math.trunc(next));
							}}
						/>
						<button
							type="button"
							className="btn btn-sm join-item"
							aria-label="One more"
							disabled={quantity >= MAX_QUANTITY}
							onClick={() => setQuantity((n) => Math.min(MAX_QUANTITY, n + 1))}
						>
							+
						</button>
					</div>
				</div>

				{!creatorHasStripe ? (
					<p className="text-sm text-base-content/60">
						Payments not available yet—the creator hasn't connected Stripe.
					</p>
				) : (
					<>
						{quote ? (
							<dl className="w-full rounded-lg bg-base-100 p-3 text-sm space-y-1.5">
								<div className="flex justify-between text-base-content/60">
									<dt>Goods{quote.quantity > 1 ? ` × ${quote.quantity}` : ""}</dt>
									<dd className="tabular-nums">{money(quote.goods)}</dd>
								</div>
								<div className="flex justify-between text-base-content/60">
									<dt>Shipping</dt>
									<dd className="tabular-nums">
										{Number(quote.shipping) > 0 ? money(quote.shipping) : "Free"}
									</dd>
								</div>
								<div className="flex justify-between text-base-content/60">
									<dt>Sales tax</dt>
									<dd className="text-xs">
										{quote.salesTax ? money(quote.salesTax) : "calculated at checkout"}
									</dd>
								</div>
								<div className="flex justify-between font-semibold border-t border-base-300 pt-1.5">
									<dt>You pay</dt>
									<dd className="tabular-nums">
										{quote.total ? money(quote.total) : `${money(quote.goods)} + shipping + tax`}
									</dd>
								</div>
							</dl>
						) : quoteError ? (
							<div className="alert alert-warning text-sm">
								<span>{quoteError}</span>
							</div>
						) : (
							<div className="skeleton h-24 w-full" aria-hidden="true" />
						)}

						<p className="text-xs text-base-content/50">
							{user
								? `Ships within ${quote?.handlingBusinessDays ?? listing.handlingBusinessDays} business ${
										(quote?.handlingBusinessDays ?? listing.handlingBusinessDays) === 1
											? "day"
											: "days"
									}.`
								: "Sign in to buy — you'll see the total with tax before you pay."}
						</p>

						<div className="grid gap-2 w-full mt-auto">
							<button
								type="button"
								className="btn btn-primary w-full"
								disabled={adding || soldOutPick}
								onClick={() => void toBasket(true)}
							>
								<BoltIcon className="w-4 h-4" /> Buy Now
							</button>
							<button
								type="button"
								className="btn btn-outline btn-sm w-full"
								disabled={adding || soldOutPick}
								onClick={() => void toBasket(false)}
							>
								<ShoppingBagIcon className="w-4 h-4" /> Add to basket
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

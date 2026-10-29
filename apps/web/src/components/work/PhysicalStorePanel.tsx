// SPDX-License-Identifier: Apache-2.0
/**
 * The store panel on a physical Work's page — the pictures, the pickers, the count, and
 * what the buyer will pay for it.
 *
 * ⭐ **The composition is the pre-fulfillment one** (Parker, 2026-10-29): the product's
 * pictures own the left column, the variants and the price box own the right, and the buy
 * door spans both at the foot. The store panel used to read that way before the Printful
 * integration was retired, and the fulfillment swap did not need to take it.
 *
 * 🚨 **Nothing here charges anything.** Like every other purchase door since 2026-10-03, the
 * two buttons put the line in the basket and send the buyer to the one checkout that
 * exists. What this panel adds is the choosing: the pictures, the options the creator
 * offers, how many, and the money those choices come to.
 *
 * ⚠️ **Every number shown here is the server's.** The goods figure, the shipping and the tax
 * estimate all arrive from `/physical/:slug/quote`; nothing on this page multiplies, adds
 * or rounds. A panel that computed a total the checkout would not charge is the one defect
 * a store must never ship. The signed-out box shows the listing's own unit price and
 * shipping and says tax is calculated at checkout, because there is no address to resolve
 * it against yet.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { keyToPreview } from "@anthers/web-shared/post/mediaUpload";
import { useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { PhotoIcon } from "@heroicons/react/24/outline";
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
interface StorefrontImage {
	url: string;
	alt: string;
}
interface Storefront {
	work: { id: number; title: string | null; slug: string | null };
	listing: {
		shippingPrice: string;
		handlingBusinessDays: number;
		taxCategory: string;
		options: ListingOption[];
		images: StorefrontImage[];
	};
	unitPrice: string;
	/** Whether the Work carries a sellable price; an owner's own unpriced draft still reads. */
	priced: boolean;
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

/**
 * The good's pictures, as a square carousel on a neutral mount.
 *
 * A product photo is composed on its own background, so the mount is the page's neutral
 * ground rather than a second frame: `object-contain` keeps the whole object visible and
 * the square keeps a set of them one consistent shape. The Work's old 16:9 thumbnail is
 * the fallback while a creator has not uploaded a gallery yet; the first gallery picture
 * is the catalog cover, so a good's art has one source.
 */
function ProductGallery({
	images,
	title,
	fallback,
}: {
	images: StorefrontImage[];
	title: string;
	fallback?: string | null;
}) {
	const [index, setIndex] = useState(0);
	const shown: StorefrontImage[] =
		images.length > 0 ? images : fallback ? [{ url: keyToPreview(fallback), alt: title }] : [];
	if (shown.length === 0) {
		return (
			<div className="flex aspect-square w-full items-center justify-center rounded-xl border border-base-300 bg-base-100">
				<PhotoIcon className="size-8 text-base-content/25" />
			</div>
		);
	}
	const active = shown[Math.min(index, shown.length - 1)];
	const step = (delta: number) =>
		setIndex((current) => Math.min(shown.length - 1, Math.max(0, current + delta)));
	return (
		<div className="flex flex-col gap-2">
			<div className="relative aspect-square w-full overflow-hidden rounded-xl border border-base-300 bg-base-100">
				<img
					src={active.url}
					alt={active.alt || title}
					className="h-full w-full object-contain"
					loading="lazy"
				/>
				{shown.length > 1 && (
					<>
						<button
							type="button"
							className="btn btn-circle btn-sm absolute top-1/2 left-2 -translate-y-1/2 border-base-300 bg-base-100/85"
							aria-label="Previous photo"
							disabled={index === 0}
							onClick={() => step(-1)}
						>
							‹
						</button>
						<button
							type="button"
							className="btn btn-circle btn-sm absolute top-1/2 right-2 -translate-y-1/2 border-base-300 bg-base-100/85"
							aria-label="Next photo"
							disabled={index === shown.length - 1}
							onClick={() => step(1)}
						>
							›
						</button>
					</>
				)}
			</div>
			{shown.length > 1 && (
				<div className="flex flex-wrap justify-center gap-2">
					{shown.map((image, i) => (
						<button
							key={image.url}
							type="button"
							aria-label={`Show photo ${i + 1}`}
							aria-pressed={i === index}
							className={`size-12 overflow-hidden rounded-md border-2 ${
								i === index ? "border-primary" : "border-base-300"
							}`}
							onClick={() => setIndex(i)}
						>
							<img src={image.url} alt="" className="h-full w-full object-cover" loading="lazy" />
						</button>
					))}
				</div>
			)}
		</div>
	);
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
		if (!storefront || !user || !storefront.priced) return;
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
					<div className="skeleton aspect-square w-full max-w-md" aria-hidden="true" />
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
			<div className="card-body flex flex-col gap-4 p-5 text-start">
				<div className="grid flex-1 items-stretch gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
					<ProductGallery images={listing.images ?? []} title={title} fallback={thumbnail} />

					<div className="flex min-w-0 flex-col gap-4">
						<div>
							<h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50">
								Variants
							</h2>
							{listing.options.length > 0 ? (
								<div className="flex w-full flex-col gap-3">
									{listing.options.map((option) => (
										<div key={option.name} className="flex items-start gap-3">
											<span className="w-20 shrink-0 pt-1.5 text-sm text-base-content/70">
												{option.name}:
											</span>
											<fieldset
												className="m-0 flex flex-wrap gap-2 border-0 p-0"
												aria-label={option.name}
											>
												<legend className="sr-only">{option.name}</legend>
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
																setPicks((current) => ({
																	...current,
																	[option.name]: value.label,
																}))
															}
														>
															{value.label}
															{value.stock === 0 ? " — sold out" : ""}
														</button>
													);
												})}
											</fieldset>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-base-content/60">
									This good comes as it is; there is nothing to choose.
								</p>
							)}
						</div>

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

						{/* The price box is visible from the moment the panel is, so picking a
						    variant never moves the layout: a signed-out visitor sees the unit
						    price and shipping, and tax waits for the checkout's address. */}
						<div className="flex min-h-0 flex-1" data-testid="physical-quote-box">
							{!storefront.priced ? (
								<div className="w-full rounded-lg border border-base-300 bg-base-100 p-3 text-sm text-base-content/60">
									This good isn't priced yet. Set its Access row to start selling it.
								</div>
							) : quote ? (
								<dl className="flex h-full w-full flex-col rounded-lg border border-base-300 bg-base-100 p-3 text-sm">
									<div className="space-y-1.5">
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
									</div>
									<div className="mt-auto flex justify-between border-t border-base-300 pt-1.5 font-semibold">
										<dt>You pay</dt>
										<dd className="tabular-nums">
											{quote.total ? money(quote.total) : `${money(quote.goods)} + shipping + tax`}
										</dd>
									</div>
								</dl>
							) : quoteError ? (
								<div className="alert alert-warning w-full text-sm">
									<span>{quoteError}</span>
								</div>
							) : user ? (
								<div
									className="w-full space-y-1.5 rounded-lg border border-base-300 bg-base-100 p-3"
									aria-hidden="true"
								>
									<div className="skeleton h-4 w-full" />
									<div className="skeleton h-4 w-4/5" />
									<div className="skeleton h-4 w-3/5" />
								</div>
							) : (
								<div className="flex h-full w-full flex-col justify-between gap-1.5 rounded-lg border border-base-300 bg-base-100 p-3 text-sm">
									<dl className="space-y-1.5">
										<div className="flex justify-between text-base-content/60">
											<dt>Price</dt>
											<dd className="tabular-nums">{money(shownPrice)}</dd>
										</div>
										<div className="flex justify-between text-base-content/60">
											<dt>Shipping</dt>
											<dd className="tabular-nums">
												{Number(listing.shippingPrice) > 0 ? money(listing.shippingPrice) : "Free"}
											</dd>
										</div>
										<div className="flex justify-between text-base-content/60">
											<dt>Sales tax</dt>
											<dd className="text-xs">calculated at checkout</dd>
										</div>
									</dl>
									<p className="border-t border-base-300 pt-1.5 text-xs text-base-content/50">
										Sign in to see the total with tax before you pay.
									</p>
								</div>
							)}
						</div>
					</div>
				</div>

				<div className="w-full">
					{!creatorHasStripe ? (
						<p className="text-sm text-base-content/60">
							Payments not available yet—the creator hasn't connected Stripe.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<button
								type="button"
								className="btn btn-primary w-full"
								disabled={!storefront.priced || adding || soldOutPick}
								onClick={() => void toBasket(true)}
							>
								{adding ? "Adding…" : user ? "Buy Now" : "Sign in to buy"}
							</button>
							<button
								type="button"
								className="btn btn-outline btn-sm w-full"
								disabled={!storefront.priced || adding || soldOutPick}
								onClick={() => void toBasket(false)}
							>
								Add to basket
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

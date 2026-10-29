// SPDX-License-Identifier: Apache-2.0
/**
 * The store panel on a physical Work's page — the pictures, the pickers, the count, the
 * parcel facts, and what the buyer will pay for it.
 *
 * ⭐ **The buyer view is the editor** (Parker, 2026-10-29): a physical good does not open a
 * media manager. The creator's own view of this panel carries a pencil on each variant row,
 * one on the quantity row, and one on the carousel; the shipping, handling and tax facts sit
 * under the price box, and a buyer sees them without the pencils. The Manage tab keeps only
 * what a buyer never sees.
 *
 * ⭐ **The composition is the pre-fulfillment one**: the product's pictures own the left
 * column, the variants and the price box own the right, and the buy door spans both at the
 * foot. The fulfillment swap did not need to take the composition with it.
 *
 * 🚨 **Nothing here charges anything.** Like every other purchase door since 2026-10-03, the
 * two buttons put the line in the basket and send the buyer to the one checkout that
 * exists. What this panel adds is the choosing: the pictures, the options the creator
 * offers, how many, and the money those choices come to.
 *
 * ⚠️ **Every number shown here is the server's.** The goods figure, the shipping and the tax
 * estimate all arrive from `/physical/:slug/quote`; nothing on this page multiplies, adds
 * or rounds. The signed-out box shows the listing's own unit price and shipping and says
 * tax is calculated at checkout, because there is no address to resolve it against yet.
 */

import type { PhysicalTaxCategory } from "@anthers/shared/tax-codes";
import { useAuth } from "@anthers/web-shared/auth";
import { keyToPreview } from "@anthers/web-shared/post/mediaUpload";
import { useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { PencilSquareIcon, PhotoIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { useBasket } from "@/lib/basket";
import { InlineField } from "./Editing";
import { PhysicalImagesEditor } from "./PhysicalImagesSection";
import { MAX_OPTIONS, PhysicalPolicyFields, PhysicalVariantEditor } from "./PhysicalListingFields";
import { type ListingOption, useListing } from "./physical-listing";

interface StorefrontImage {
	url: string;
	alt: string;
}
interface ViewListing {
	shippingPrice: string;
	handlingBusinessDays: number;
	minQuantity: number;
	maxQuantity: number;
	taxCategory: PhysicalTaxCategory;
	options: ListingOption[];
	images: StorefrontImage[];
}
interface Storefront {
	work: { id: number; title: string | null; slug: string | null };
	listing: {
		shippingPrice: string;
		handlingBusinessDays: number;
		minQuantity: number;
		maxQuantity: number;
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
	onEdit,
}: {
	images: StorefrontImage[];
	title: string;
	fallback?: string | null;
	onEdit?: () => void;
}) {
	const [index, setIndex] = useState(0);
	const shown: StorefrontImage[] =
		images.length > 0 ? images : fallback ? [{ url: keyToPreview(fallback), alt: title }] : [];
	const active = shown[Math.min(index, shown.length - 1)];
	const step = (delta: number) =>
		setIndex((current) => Math.min(shown.length - 1, Math.max(0, current + delta)));

	return (
		<div className="flex flex-col gap-2">
			<div className="relative aspect-square w-full overflow-hidden rounded-xl border border-base-300 bg-base-100">
				{shown.length === 0 ? (
					<div className="flex h-full w-full items-center justify-center">
						<PhotoIcon className="size-8 text-base-content/25" />
					</div>
				) : (
					<img
						src={active.url}
						alt={active.alt || title}
						className="h-full w-full object-contain"
						loading="lazy"
					/>
				)}
				{onEdit && (
					<button
						type="button"
						className="btn btn-ghost btn-sm btn-circle absolute right-2 top-2 z-10 bg-base-100/85 text-base-content/70 backdrop-blur hover:text-base-content"
						aria-label="Edit photos"
						onClick={onEdit}
					>
						<PencilSquareIcon className="size-4" />
					</button>
				)}
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

/** The row's own pencil: a compact variant summary with a trash button beside it. */
function VariantRow({
	option,
	chosen,
	onPick,
}: {
	option: ListingOption;
	chosen: string | undefined;
	onPick: (label: string) => void;
}) {
	return (
		<fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
			<legend className="sr-only">{option.name}</legend>
			<span className="w-20 shrink-0 text-sm text-base-content/70">{option.name}:</span>
			{option.values.map((value) => (
				<button
					key={value.label}
					type="button"
					aria-pressed={chosen === value.label}
					disabled={value.stock === 0}
					className={`btn btn-sm ${chosen === value.label ? "btn-primary" : "btn-outline"} ${
						value.stock === 0 ? "btn-disabled" : ""
					}`}
					onClick={() => onPick(value.label)}
				>
					{value.label}
					{value.stock === 0 ? " — sold out" : ""}
				</button>
			))}
		</fieldset>
	);
}

export default function PhysicalStorePanel({
	slug,
	workId,
	title,
	creatorHandle,
	thumbnail,
	owner = false,
}: {
	slug: string;
	workId: number;
	title: string;
	creatorHandle: string;
	thumbnail?: string | null;
	/** The creator's own view: pencils appear on the fields a buyer reads. */
	owner?: boolean;
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
	const [editingImages, setEditingImages] = useState(false);
	const [newVariant, setNewVariant] = useState<ListingOption | null>(null);
	const [editError, setEditError] = useState<string | null>(null);
	const { listing: editorListing, loadError: editorError, save } = useListing(workId, owner);

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
			setQuantity(body.listing.minQuantity ?? 1);
		})();
		return () => {
			stale = true;
		};
	}, [slug]);

	// The creator's own listing is the editing copy; the storefront is the buyer's. The
	// owner reads the same row through the content route so a save lands on the same data
	// the panel is showing, and the public read never asks for it.
	const shownListing: ViewListing | null = useMemo(() => {
		if (owner && editorListing) {
			return {
				...editorListing,
				images: editorListing.images.map((image) => ({
					url: keyToPreview(image.key),
					alt: image.alt,
				})),
			};
		}
		if (!storefront) return null;
		return {
			...storefront.listing,
			taxCategory: storefront.listing.taxCategory as PhysicalTaxCategory,
		};
	}, [owner, editorListing, storefront]);
	const options = useMemo(() => shownListing?.options ?? [], [shownListing]);
	const minQuantity = shownListing?.minQuantity ?? 1;
	const maxQuantity = Math.min(MAX_QUANTITY, shownListing?.maxQuantity ?? MAX_QUANTITY);

	// A creator's new bounds clamp the count in front of them rather than leaving a stale
	// number that the next quote refuses.
	useEffect(() => {
		setQuantity((current) => Math.min(maxQuantity, Math.max(minQuantity, current)));
	}, [minQuantity, maxQuantity]);

	// The quote: the goods, the shipping and the estimated tax for exactly this pick.
	useEffect(() => {
		if (!storefront || !user || !storefront.priced) return;
		// Every choice must have a value before anything can be priced.
		if (
			options.some((option) => !option.values.some((value) => value.label === picks[option.name]))
		)
			return;
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
	}, [slug, storefront, user, picks, quantity, options]);

	if (error) {
		return (
			<div className="card bg-base-200 border border-base-300 h-full">
				<div className="card-body p-5">
					<p className="text-sm text-base-content/70">{error}</p>
				</div>
			</div>
		);
	}

	if (!storefront || !shownListing) {
		return (
			<div className="card bg-base-200 border border-base-300 h-full">
				<div className="card-body p-5">
					<div className="skeleton aspect-square w-full max-w-md" aria-hidden="true" />
				</div>
			</div>
		);
	}

	const { unitPrice } = storefront;
	// The public read already prices at the viewer's own Access row, so this only covers the
	// window where the quote has resolved and the read has not kept up.
	const shownPrice = quote?.unitPrice ?? unitPrice;
	const soldOutPick = options.some((option) => {
		const chosen = option.values.find((value) => value.label === picks[option.name]);
		return !chosen || chosen.stock === 0;
	});

	const adoptOptions = (nextOptions: ListingOption[]) => {
		setPicks((current) => {
			const next: Record<string, string> = {};
			for (const option of nextOptions) {
				const existing = current[option.name];
				const chosen =
					option.values.find((value) => value.label === existing) ??
					option.values.find((value) => value.stock !== 0);
				if (chosen) next[option.name] = chosen.label;
			}
			return next;
		});
	};

	const saveOption = async (index: number, next: ListingOption) => {
		const nextOptions = options.map((option, i) => (i === index ? next : option));
		await save({ options: nextOptions });
		adoptOptions(nextOptions);
	};

	const removeOption = async (index: number) => {
		const nextOptions = options.filter((_, i) => i !== index);
		setEditError(null);
		try {
			await save({ options: nextOptions });
			adoptOptions(nextOptions);
		} catch (err) {
			setEditError(err instanceof Error ? err.message : "That variant didn't come out.");
		}
	};

	const addVariant = async () => {
		if (!newVariant) return;
		const nextOptions = [...options, newVariant];
		setEditError(null);
		try {
			await save({ options: nextOptions });
			adoptOptions(nextOptions);
			setNewVariant(null);
		} catch (err) {
			setEditError(err instanceof Error ? err.message : "That variant didn't save.");
		}
	};

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

	const quantityEditor = (
		<InlineField<{ min: number; max: number }>
			label="quantity"
			saved={{ min: minQuantity, max: maxQuantity }}
			renderRead={() => null}
			renderEdit={(draft, setDraft) => (
				<div className="flex flex-wrap items-end gap-2">
					<div>
						<label className="text-xs text-base-content/60" htmlFor="physical-min-quantity">
							Smallest order
						</label>
						<input
							id="physical-min-quantity"
							type="number"
							min="1"
							max={MAX_QUANTITY}
							step="1"
							aria-label="Smallest order"
							className="input input-bordered input-sm w-28"
							value={draft.min}
							onChange={(e) => setDraft({ ...draft, min: Number(e.target.value) })}
						/>
					</div>
					<div>
						<label className="text-xs text-base-content/60" htmlFor="physical-max-quantity">
							Largest order
						</label>
						<input
							id="physical-max-quantity"
							type="number"
							min="1"
							max={MAX_QUANTITY}
							step="1"
							aria-label="Largest order"
							className="input input-bordered input-sm w-28"
							value={draft.max}
							onChange={(e) => setDraft({ ...draft, max: Number(e.target.value) })}
						/>
					</div>
				</div>
			)}
			disabledSave={(draft) =>
				!Number.isInteger(draft.min) ||
				!Number.isInteger(draft.max) ||
				draft.min < 1 ||
				draft.max > MAX_QUANTITY ||
				draft.max < draft.min
					? "Choose a whole range from 1 to 10, smallest first."
					: undefined
			}
			save={async (draft) => {
				await save({ minQuantity: draft.min, maxQuantity: draft.max });
				setQuantity((current) => Math.min(draft.max, Math.max(draft.min, current)));
			}}
		/>
	);

	return (
		<div className="card bg-base-200 border border-base-300 h-full">
			<div className="card-body flex flex-col gap-4 p-5 text-start">
				<div className="grid flex-1 items-stretch gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
					<div className="min-w-0">
						{editingImages && owner && editorListing ? (
							<PhysicalImagesEditor
								images={editorListing.images}
								onChange={(images) => save({ images })}
								onDone={() => setEditingImages(false)}
							/>
						) : (
							<ProductGallery
								images={shownListing.images}
								title={title}
								fallback={thumbnail}
								onEdit={owner ? () => setEditingImages(true) : undefined}
							/>
						)}
					</div>

					<div className="flex min-w-0 flex-col gap-4">
						<div>
							<h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50">
								Variants
							</h2>
							{options.length > 0 ? (
								<div className="flex w-full flex-col gap-3">
									{options.map((option, index) => (
										<div key={option.name} className="flex items-start gap-1">
											<div className="min-w-0 flex-1">
												{owner && editorListing ? (
													<InlineField<ListingOption>
														label={`${option.name} variant`}
														saved={option}
														renderRead={() => (
															<VariantRow
																option={option}
																chosen={picks[option.name]}
																onPick={(label) =>
																	setPicks((current) => ({
																		...current,
																		[option.name]: label,
																	}))
																}
															/>
														)}
														renderEdit={(draft, setDraft) => (
															<PhysicalVariantEditor
																options={[draft]}
																onChange={(next) => setDraft(next[0] ?? draft)}
																showAddVariant={false}
																showRemove={false}
															/>
														)}
														save={(next) => saveOption(index, next)}
													/>
												) : (
													<VariantRow
														option={option}
														chosen={picks[option.name]}
														onPick={(label) =>
															setPicks((current) => ({
																...current,
																[option.name]: label,
															}))
														}
													/>
												)}
											</div>
											{owner && editorListing && (
												<button
													type="button"
													className="btn btn-ghost btn-xs text-error"
													aria-label={`Remove ${option.name} variant`}
													onClick={() => void removeOption(index)}
												>
													<TrashIcon className="size-4" />
												</button>
											)}
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-base-content/60">
									This good comes as it is; there is nothing to choose.
								</p>
							)}
							{owner && editorListing && options.length < MAX_OPTIONS && !newVariant && (
								<button
									type="button"
									className="btn btn-ghost btn-sm mt-2 self-start"
									onClick={() => setNewVariant({ name: "", values: [{ label: "", stock: null }] })}
								>
									Add a variant
								</button>
							)}
							{newVariant && (
								<div className="mt-3 rounded-box border border-primary/40 p-3">
									<PhysicalVariantEditor
										options={[newVariant]}
										onChange={(next) => setNewVariant(next[0] ?? newVariant)}
										showAddVariant={false}
										showRemove={false}
									/>
									<div className="mt-2 flex justify-end gap-2">
										<button
											type="button"
											className="btn btn-ghost btn-sm"
											onClick={() => setNewVariant(null)}
										>
											Cancel
										</button>
										<button
											type="button"
											className="btn btn-primary btn-sm"
											onClick={() => void addVariant()}
										>
											Save variant
										</button>
									</div>
								</div>
							)}
							{editError && <p className="mt-2 text-sm text-error">{editError}</p>}
						</div>

						<div className="flex items-center gap-2">
							<span className="text-sm font-medium">How many</span>
							<div className="join">
								<button
									type="button"
									className="btn btn-sm join-item"
									aria-label="One fewer"
									disabled={quantity <= minQuantity}
									onClick={() => setQuantity((n) => Math.max(minQuantity, n - 1))}
								>
									−
								</button>
								<input
									aria-label="How many"
									className="input input-bordered input-sm join-item w-16 text-center tabular-nums"
									value={quantity}
									inputMode="numeric"
									onChange={(e) => {
										const next = Number(e.target.value);
										if (Number.isFinite(next) && next >= 1 && next <= maxQuantity)
											setQuantity(Math.min(maxQuantity, Math.max(minQuantity, Math.trunc(next))));
									}}
								/>
								<button
									type="button"
									className="btn btn-sm join-item"
									aria-label="One more"
									disabled={quantity >= maxQuantity}
									onClick={() => setQuantity((n) => Math.min(maxQuantity, n + 1))}
								>
									+
								</button>
							</div>
							{owner && editorListing && quantityEditor}
						</div>

						{/* The price box is visible from the moment the panel is, and stays short:
						    the policy facts below it are the rest of the right column. */}
						<div className="flex min-h-0" data-testid="physical-quote-box">
							{!storefront.priced ? (
								<div className="w-full rounded-lg border border-base-300 bg-base-100 p-3 text-sm text-base-content/60">
									This good isn't priced yet. Set its Access row to start selling it.
								</div>
							) : quote ? (
								<dl className="w-full rounded-lg border border-base-300 bg-base-100 p-3 text-sm">
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
									<div className="mt-1.5 flex justify-between border-t border-base-300 pt-1.5 font-semibold">
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
								<div className="flex w-full flex-col gap-1.5 rounded-lg border border-base-300 bg-base-100 p-3 text-sm">
									<div className="flex justify-between text-base-content/60">
										<dt>Price</dt>
										<dd className="tabular-nums">{money(shownPrice)}</dd>
									</div>
									<div className="flex justify-between text-base-content/60">
										<dt>Shipping</dt>
										<dd className="tabular-nums">
											{Number(shownListing.shippingPrice) > 0
												? money(shownListing.shippingPrice)
												: "Free"}
										</dd>
									</div>
									<div className="flex justify-between text-base-content/60">
										<dt>Sales tax</dt>
										<dd className="text-xs">calculated at checkout</dd>
									</div>
									<p className="border-t border-base-300 pt-1.5 text-xs text-base-content/50">
										Sign in to see the total with tax before you pay.
									</p>
								</div>
							)}
						</div>

						<PhysicalPolicyFields
							listing={owner && editorListing ? editorListing : shownListing}
							onSave={owner && editorListing ? save : undefined}
							editable={Boolean(owner && editorListing)}
						/>
						{owner && editorError && <p className="text-sm text-error">{editorError}</p>}
					</div>
				</div>

				<div className="w-full">
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
				</div>
			</div>
		</div>
	);
}

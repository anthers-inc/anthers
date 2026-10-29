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
import { PencilSquareIcon, PhotoIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { useBasket } from "@/lib/basket";
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
	const [picks, setPicks] = useState<Record<string, string>>({});
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoteError, setQuoteError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [editingImages, setEditingImages] = useState(false);
	const [variantDraft, setVariantDraft] = useState<{
		index: number | null;
		draft: ListingOption;
	} | null>(null);
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
				images: [...editorListing.images]
					.sort((a, b) => Number(b.cover) - Number(a.cover))
					.map((image) => ({
						url: image.url ?? "",
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
	// The storefront adds the smallest order the listing allows; the buyer changes the count
	// in the basket, where the line's quantity already lives.
	const quantity = minQuantity;

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

	const removeOption = async (index: number): Promise<boolean> => {
		const nextOptions = options.filter((_, i) => i !== index);
		setEditError(null);
		try {
			await save({ options: nextOptions });
			adoptOptions(nextOptions);
			return true;
		} catch (err) {
			setEditError(err instanceof Error ? err.message : "That variant didn't come out.");
			return false;
		}
	};

	const startVariant = (index: number | null, option?: ListingOption) => {
		setEditingImages(false);
		setEditError(null);
		setVariantDraft({
			index,
			draft: option
				? { ...option, values: option.values.map((value) => ({ ...value })) }
				: { name: "", values: [{ label: "", stock: null }] },
		});
	};

	const openPhotos = () => {
		setVariantDraft(null);
		setEditError(null);
		setEditingImages(true);
	};

	const saveVariantDraft = async () => {
		if (!variantDraft) return;
		setEditError(null);
		try {
			if (variantDraft.index == null) {
				const nextOptions = [...options, variantDraft.draft];
				await save({ options: nextOptions });
				adoptOptions(nextOptions);
			} else {
				await saveOption(variantDraft.index, variantDraft.draft);
			}
			setVariantDraft(null);
		} catch (err) {
			setEditError(err instanceof Error ? err.message : "That variant didn't save.");
		}
	};

	const removeDraft = async () => {
		if (!variantDraft || variantDraft.index == null) return;
		if (await removeOption(variantDraft.index)) setVariantDraft(null);
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

	return (
		<div className="card bg-base-200 border border-base-300 h-full">
			<div className="card-body flex flex-col gap-4 p-5 text-start">
				{editingImages && owner && editorListing ? (
					<PhysicalImagesEditor
						images={editorListing.images}
						onChange={(images) => save({ images })}
						onDone={() => setEditingImages(false)}
					/>
				) : (
					<>
						<div className="grid flex-1 items-stretch gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
							<div className="min-w-0">
								<ProductGallery
									images={shownListing.images}
									title={title}
									fallback={thumbnail}
									onEdit={owner ? openPhotos : undefined}
								/>
							</div>

							<div className="flex min-w-0 flex-col gap-4">
								<div>
									<div className="mb-2 flex items-center justify-between gap-2">
										<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
											Variants
										</h2>
										{owner && editorListing && !variantDraft && options.length < MAX_OPTIONS && (
											<button
												type="button"
												className="btn btn-ghost btn-xs btn-circle"
												aria-label="Add a variant"
												onClick={() => startVariant(null)}
											>
												<PlusIcon className="size-4" />
											</button>
										)}
									</div>
									{variantDraft ? (
										<div className="flex flex-col gap-3">
											<PhysicalVariantEditor
												options={[variantDraft.draft]}
												onChange={(next) =>
													setVariantDraft((current) =>
														current ? { ...current, draft: next[0] ?? current.draft } : current,
													)
												}
											/>
											<div className="flex flex-wrap items-center justify-between gap-2">
												{variantDraft.index != null ? (
													<button
														type="button"
														className="btn btn-ghost btn-sm text-error"
														onClick={() => void removeDraft()}
													>
														Remove variant
													</button>
												) : (
													<span />
												)}
												<div className="flex gap-2">
													<button
														type="button"
														className="btn btn-ghost btn-sm"
														onClick={() => {
															setVariantDraft(null);
															setEditError(null);
														}}
													>
														Cancel
													</button>
													<button
														type="button"
														className="btn btn-primary btn-sm"
														onClick={() => void saveVariantDraft()}
													>
														Save variant
													</button>
												</div>
											</div>
											{editError && <p className="text-sm text-error">{editError}</p>}
										</div>
									) : options.length > 0 ? (
										<div className="flex w-full flex-col gap-3">
											{options.map((option, index) => (
												<div key={option.name} className="flex items-start gap-1">
													<div className="min-w-0 flex-1">
														<VariantRow
															option={option}
															chosen={picks[option.name]}
															onPick={(label) =>
																setPicks((current) => ({ ...current, [option.name]: label }))
															}
														/>
													</div>
													{owner && editorListing && (
														<>
															<button
																type="button"
																className="btn btn-ghost btn-xs"
																aria-label={`Edit ${option.name} variant`}
																onClick={() => startVariant(index, option)}
															>
																<PencilSquareIcon className="size-4" />
															</button>
															<button
																type="button"
																className="btn btn-ghost btn-xs text-error"
																aria-label={`Remove ${option.name} variant`}
																onClick={() => void removeOption(index)}
															>
																<TrashIcon className="size-4" />
															</button>
														</>
													)}
												</div>
											))}
										</div>
									) : (
										<p className="text-sm text-base-content/60">
											This good comes as it is; there is nothing to choose.
										</p>
									)}
									{!variantDraft && editError && (
										<p className="mt-2 text-sm text-error">{editError}</p>
									)}
								</div>

								{!variantDraft && (
									<>
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
															{quote.total
																? money(quote.total)
																: `${money(quote.goods)} + shipping + tax`}
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
									</>
								)}
							</div>
						</div>

						{!variantDraft && (
							<div className="mx-auto w-full sm:w-1/2">
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
										Add to Basket
									</button>
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

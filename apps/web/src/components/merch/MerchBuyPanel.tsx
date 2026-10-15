// SPDX-License-Identifier: Apache-2.0
/**
 * The buy panel for a merch Work — the size picker and the derived price, and the
 * checkout door.
 *
 * 🚨 **No payment form on the Work page** — the ruling ProjectPricing's header records.
 * This panel holds the picker, POSTs the merch checkout to get a client secret, and
 * mounts the session on an in-page checkout surface that is the ONLY CheckoutElements
 * provider of the merch flow, rendering nothing of its own but the form.
 *
 * The price lines are the decision's transparency rule as the buyer sees it, in two
 * places: the picker's size buttons carry the discounted price, and, once a pick is
 * made, the quote box below them shows the checkout's own figures before it starts —
 * the discounted goods, Printful's live shipping rate, and, when the buyer has saved a
 * billing address (the 2026-10-11 opt-in), Stripe Tax quoted against it. **The print
 * cost is never a buyer-visible figure** — the transparency prose ("about $20 to print,
 * the rest funds Anthers' programs") lives in the wiki's copy, not in a checkout.
 * The checkout form remains the authority: it re-resolves every figure from the session,
 * whose tax the address the buyer delivers to settles.
 */

import { withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { Link, useLocation } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import {
	CheckoutElementsProvider,
	PaymentElement,
	type StripeUseCheckoutElementsResult,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { StripeCheckoutContact } from "@stripe/stripe-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { getStripe } from "../../lib/stripe";
import CheckoutBillingAddressBlock from "../payments/CheckoutBillingAddressBlock";
import UsBillingAddressForm, {
	EMPTY_ADDRESS,
	isAddressComplete,
	toCheckoutContact,
	type UsAddressInput,
} from "../payments/UsBillingAddressForm";
import { useSavedBillingAddress } from "../payments/useSavedBillingAddress";
import {
	mayConfirm,
	sessionTotalsFrom,
	TAX_RESOLVE_DEBOUNCE_MS,
	useSessionBillingAddress,
} from "../payments/useSessionBillingAddress";

interface MerchBuyPanelProps {
	workId: number;
	slug: string;
	title: string;
}

interface MerchVariant {
	size: string;
	listPrice: string;
	amount: string;
	discount: string | null;
	inStock: boolean;
}

/** One color row of the variants answer — the Work's pickers are color, then size. */
interface MerchColorGroup {
	color: string;
	/** The color's mockup from the store's binding — null and the picker shows no picture. */
	mockupUrl: string | null;
	sizes: MerchVariant[];
}

interface MerchQuote {
	amount: string;
	listPrice: string;
	goodsPrice: string;
	discount: { badge: string; percent: string; saved: string } | null;
	shipping: string;
	size: string;
	salesTax: null;
	buyerTotal: null;
	clientSecret: string;
}

/**
 * The store panel's live estimate for the picked pick — the quote route's answer. The
 * figures are the same lines the checkout will charge (the shared server derivation);
 * `tax` and `buyerTotal` are null when the buyer has no saved billing address (or the
 * tax estimate could not resolve), where the box falls back to the checkout's own
 * authority rather than a guessed figure.
 */
interface MerchEstimate {
	color: string;
	size: string;
	listPrice: string;
	goodsPrice: string;
	discount: { badge: string; percent: string; saved: string } | null;
	shipping: string;
	shippingName: string;
	tax: string | null;
	buyerTotal: string | null;
	quotedTo: { city: string; state: string; postalCode: string } | null;
}

export default function MerchBuyPanel({ slug, title }: MerchBuyPanelProps) {
	const { isAuthenticated } = useAuth();
	const location = useLocation();
	const [colors, setColors] = useState<MerchColorGroup[] | null>(null);
	const [variantsError, setVariantsError] = useState<string | null>(null);
	const [color, setColor] = useState<string | null>(null);
	const [size, setSize] = useState<string | null>(null);
	const [session, setSession] = useState<MerchQuote | null>(null);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	// The store panel's live estimate, one per settled pick — the quote box below.
	const [estimate, setEstimate] = useState<MerchEstimate | null>(null);
	const [estimateLoading, setEstimateLoading] = useState(false);

	// The color/size list, per Work — fetched unconditionally (hooks order), read by
	// the branches below.
	useEffect(() => {
		let canceled = false;
		client.api.payments.merch[":slug"].variants
			.$get({ param: { slug } })
			.then(async (res) => {
				if (canceled) return;
				const body = (await res.json().catch(() => null)) as {
					colors?: MerchColorGroup[];
					error?: string;
				} | null;
				if (!res.ok) {
					setVariantsError(body?.error ?? "We couldn't load the options right now.");
					return;
				}
				setColors(body?.colors ?? []);
				// The first color is picked from the start (Parker, 2026-10-10): the sizes
				// row is visible on load and the size buttons carry prices, which need a
				// color's rows to price from. An existing pick survives a re-read.
				if (body?.colors?.length) {
					const first = body.colors[0];
					setColor((c) => (body.colors?.some((g) => g.color === c) ? c : first.color));
				}
			})
			.catch(() => {
				if (!canceled) setVariantsError("We couldn't load the options right now.");
			});
		return () => {
			canceled = true;
		};
	}, [slug]);

	const pickedGroup = colors?.find((g) => g.color === color) ?? null;
	// The mockup the panel opens with: the picked color's once one is picked — never
	// some other color's shirt — and the first color's before a pick, because a
	// product page opens on its image.
	const mockupUrl =
		color == null
			? (colors?.find((g) => g.mockupUrl)?.mockupUrl ?? null)
			: (pickedGroup?.mockupUrl ?? null);

	// Every size the Work carries, across all its colors (Parker, 2026-10-10 — the
	// sizes row shows from the start). One with no row in the picked color greys out
	// rather than vanishing: the shape of the range stays visible.
	const allSizes = [...new Set((colors ?? []).flatMap((g) => g.sizes.map((v) => v.size)))];

	// The live estimate, one settled pick at a time. A pick is a discrete click, so one
	// fetch per click — the latest response wins (an earlier fetch's cleanup marks it
	// canceled), and a failed estimate degrades to no box: the checkout POST is the
	// authority and carries its own refusals. Signed out, the box waits — the Badge
	// discount and the saved billing zip it quotes from are account facts.
	useEffect(() => {
		if (!isAuthenticated || !color || !size) {
			setEstimate(null);
			setEstimateLoading(false);
			return;
		}
		let canceled = false;
		setEstimateLoading(true);
		client.api.payments.merch.quote[":slug"]
			.$get({ param: { slug }, query: { color, size } })
			.then(async (res) => {
				if (canceled) return;
				const body = (await res.json().catch(() => null)) as
					| (MerchEstimate & { error?: string })
					| null;
				setEstimate(res.ok && body ? body : null);
			})
			.catch(() => {
				if (!canceled) setEstimate(null);
			})
			.finally(() => {
				if (!canceled) setEstimateLoading(false);
			});
		return () => {
			canceled = true;
		};
	}, [isAuthenticated, color, size, slug]);

	const createSession = async () => {
		if (!size || !color) return;
		setCreating(true);
		setSessionError(null);
		try {
			const res = await client.api.payments.merch.checkout[":slug"].$post({
				param: { slug },
				json: { color, size },
			});
			const body = (await res.json().catch(() => null)) as (MerchQuote & { error?: string }) | null;
			if (!res.ok || !body?.clientSecret) {
				setSessionError(body?.error ?? "Checkout couldn't start — please try again.");
				return;
			}
			setSession(body);
		} catch {
			setSessionError("Checkout couldn't start — please try again.");
		} finally {
			setCreating(false);
		}
	};

	if (session) {
		// The session quote carries the goods line's breakdown; the color and size are
		// rendered from the picked state (the session is keyed to the pair it was
		// created for).
		const pickedSize = session.size ?? size ?? "";
		return (
			<div className="card bg-base-200 border border-base-300 h-full">
				<div className="card-body p-5 gap-4">
					<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
						Checkout — {color}, size {pickedSize}
					</h2>
					<CheckoutElementsProvider
						stripe={getStripe()}
						options={{ clientSecret: session.clientSecret }}
					>
						<MerchCheckoutForm
							quote={{
								size: pickedSize,
								color,
								listPrice: session.listPrice,
								goodsPrice: session.goodsPrice,
								discount: session.discount,
								shipping: session.shipping,
							}}
							onCancel={() => setSession(null)}
						/>
					</CheckoutElementsProvider>
				</div>
			</div>
		);
	}

	return (
		<div className="card bg-base-200 border border-base-300 h-full">
			<div className="card-body p-5 gap-4 flex flex-col items-start text-start">
				{/*
				    The color's mockup — Printful's own product image for the picked color,
				    from the store's binding (the setup script stamps it; the dashboard is
				    its source). One image, not a gallery: the shirt the buyer is pointing
				    at, and it changes when they change color. Shown before the price so
				    the card opens on the thing, as a shop does; a color bound without a
				    mockup shows none rather than some other color's shirt.
				*/}
				{mockupUrl && (
					<img
						src={mockupUrl}
						alt={color ? `${title} in ${color}` : title}
						// Capped, not full-bleed (Parker, 2026-10-10): the picture is the
						// card's opening line, not its whole body.
						className="w-full max-w-sm rounded-xl border border-base-300 bg-base-100"
						loading="lazy"
					/>
				)}
				<div>
					<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-2">
						Variants
					</h2>
					{/* The pickers ARE the price display on a merch Work — each variant's
					    price is Printful's own retail price for it (stamped at setup),
					    discounted when this buyer holds a Badge, so the picker and the
					    price are one control. Color first, then size. */}
					{colors ? (
						colors.length > 0 ? (
							/* Rows are labeled and spaced (Parker, 2026-10-10): "Colors:" and
							    "Sizes:" open each row at a fixed width so the left-most
							    buttons align, and every size the Work carries shows from the
							    start — one the picked color doesn't make greys out rather
							    than vanishing. */
							<div className="space-y-3 w-full">
								<div className="flex items-center gap-3">
									<span className="w-16 shrink-0 text-sm text-base-content/70">Colors:</span>
									<fieldset className="flex flex-wrap gap-2 border-0 p-0 m-0" aria-label="Color">
										<legend className="sr-only">Color</legend>
										{colors.map((g) => (
											<button
												key={g.color}
												type="button"
												aria-pressed={color === g.color}
												className={`btn btn-sm ${color === g.color ? "btn-primary" : "btn-outline"}`}
												onClick={() => {
													// A picked size survives a color change when the new
													// color makes it — the shirt the user means doesn't
													// reset because they adjusted the shade first.
													setColor(g.color);
													setSize((s) =>
														s != null && g.sizes.some((v) => v.size === s) ? s : null,
													);
													setSession(null);
												}}
											>
												<span>{g.color}</span>
											</button>
										))}
									</fieldset>
								</div>
								<div className="flex items-start gap-3">
									<span className="w-16 shrink-0 pt-1.5 text-sm text-base-content/70">Sizes:</span>
									<fieldset className="flex flex-wrap gap-2 border-0 p-0 m-0" aria-label="Size">
										<legend className="sr-only">Size</legend>
										{allSizes.map((s) => {
											const variantInColor = pickedGroup?.sizes.find((v) => v.size === s);
											return variantInColor ? (
												<button
													key={s}
													type="button"
													aria-pressed={size === variantInColor.size}
													className={`btn btn-sm justify-between ${size === variantInColor.size ? "btn-primary" : "btn-outline"}`}
													onClick={() => {
														setSize(variantInColor.size);
														setSession(null);
													}}
												>
													<span>{variantInColor.size}</span>
													<span className="tabular-nums ml-2">${variantInColor.amount}</span>
												</button>
											) : (
												<button
													key={s}
													type="button"
													disabled
													aria-label={`${s} — not offered in this color`}
													title={`Not offered in ${color ?? "this color"}`}
													className="btn btn-sm btn-outline opacity-40 cursor-not-allowed"
												>
													<span>{s}</span>
												</button>
											);
										})}
									</fieldset>
								</div>
							</div>
						) : (
							<p className="text-sm text-base-content/60">This item isn't in the store yet.</p>
						)
					) : variantsError ? (
						<div className="alert alert-warning text-sm">
							<span>{variantsError}</span>
						</div>
					) : (
						<div className="skeleton h-10 w-40" aria-hidden="true" />
					)}
				</div>

				{/* The quote box's better form (the 2026-10-10 stopgap retired): once a
				    pick is made, the panel quotes the checkout's real figures live — the
				    discounted goods, Printful's own shipping rate, and, from the buyer's
				    saved billing address (the 2026-10-11 opt-in), Stripe Tax itself. The
				    checkout remains the authority: its session resolves tax from the
				    address the buyer delivers to, which this estimate stands in with
				    billing. Signed out, the discount and the saved zip it quotes from
				    are account facts, so the box waits for the account. */}
				{isAuthenticated && (
					<MerchQuoteBox color={color} size={size} estimate={estimate} loading={estimateLoading} />
				)}

				{sessionError && (
					<div className="alert alert-error text-sm w-full">
						<span>{sessionError}</span>
					</div>
				)}

				<div className="grid gap-2 w-full mt-auto">
					{/*
					    🚨 The door is the account's, not the button's: buying requires an
					    account (the same ruling that put the signed-out wall in front of
					    streaming), and the honest way to say so is a door that leads TO the
					    account, carrying the Work they were looking at with it — not a 401
					    discovered after the press. The picker above stays fully readable
					    signed out; only the purchase asks.
					*/}
					{isAuthenticated ? (
						<button
							type="button"
							className="btn btn-primary w-full"
							disabled={!size || !color || creating}
							onClick={() => void createSession()}
						>
							{creating ? "Starting checkout…" : "Buy this shirt"}
						</button>
					) : (
						<Link
							to={withNextPath("/signup", `${location.pathname}${location.search}`)}
							className="btn btn-primary w-full"
						>
							Create an account to buy
						</Link>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * The store panel's estimate for the currently picked (color, size) — the quote route's
 * answer rendered as the shop's price box. Renders nothing while there is no pick to
 * price, nothing signed out, and nothing on a failed estimate: the buy door and the
 * checkout POST carry the honest errors. With no saved billing address the tax line
 * says where it resolves instead of showing a figure.
 */
function MerchQuoteBox({
	color,
	size,
	estimate,
	loading,
}: {
	color: string | null;
	size: string | null;
	estimate: MerchEstimate | null;
	loading: boolean;
}) {
	// No pick (or signed out) — the box prices nothing yet, by design.
	if (!color || !size) return null;
	if (loading && !estimate) {
		return (
			<div className="w-full rounded-lg bg-base-100 p-3 space-y-1.5" aria-hidden="true">
				<div className="skeleton h-4 w-full" />
				<div className="skeleton h-4 w-4/5" />
				<div className="skeleton h-4 w-3/5" />
			</div>
		);
	}
	if (!estimate) return null;
	const taxed = estimate.tax != null;
	return (
		<div
			className="w-full rounded-lg bg-base-100 border border-base-300 p-3 text-sm space-y-1.5"
			data-testid="merch-quote-box"
		>
			<dl className="space-y-1.5">
				<div className="flex justify-between text-base-content/60">
					<dt>
						The shirt{estimate.color ? `, ${estimate.color}` : ""}, size {estimate.size}
					</dt>
					<dd className="tabular-nums">
						{estimate.discount ? <s>${estimate.listPrice}</s> : null} ${estimate.goodsPrice}
					</dd>
				</div>
				{estimate.discount && (
					<div className="flex justify-between text-success">
						<dt>
							Badge discount <span className="text-xs">({estimate.discount.percent}% off)</span>
						</dt>
						<dd className="tabular-nums">−${estimate.discount.saved}</dd>
					</div>
				)}
				<div className="flex justify-between text-base-content/60">
					<dt>Shipping (Printful's)</dt>
					<dd className="tabular-nums">${estimate.shipping}</dd>
				</div>
				{taxed ? (
					<div className="flex justify-between">
						<dt>Sales tax</dt>
						<dd className="tabular-nums">${estimate.tax}</dd>
					</div>
				) : (
					<div className="flex justify-between text-base-content/60">
						<dt>Sales tax</dt>
						<dd className="text-xs">calculated at checkout</dd>
					</div>
				)}
			</dl>
			{estimate.buyerTotal != null && (
				<div className="flex justify-between border-t border-base-300 pt-1.5 font-semibold">
					<span>Estimated total</span>
					<span className="tabular-nums">${estimate.buyerTotal}</span>
				</div>
			)}
			{estimate.quotedTo ? (
				<p className="text-base-content/60 text-xs" data-testid="merch-quote-source">
					Quoted live to your saved address in {estimate.quotedTo.city}, {estimate.quotedTo.state} —
					checkout recalculates from the address you deliver to.
				</p>
			) : (
				<p className="text-base-content/60 text-xs">
					{/* No saved address (or a rate that couldn't resolve just now): the
					    checkout's own session is where tax resolves, and the settings card
					    is where the address that quotes here comes from. */}
					Checkout calculates tax from your delivery address.{" "}
					<Link to="/settings" className="link text-xs pointer-events-auto">
						Save a billing address
					</Link>{" "}
					to quote your total here.
				</p>
			)}
		</div>
	);
}

/** The stable identity of an address value sent to the session — the resolve dedupe's key. */
function contactKey(contact: StripeCheckoutContact): string {
	return JSON.stringify(contact);
}

function MerchCheckoutForm({
	quote,
	onCancel,
}: {
	quote: {
		size: string;
		listPrice: string;
		goodsPrice: string;
		discount: { badge: string; percent: string; saved: string } | null;
		shipping: string;
		/** Rendered in the line's label when this panel picked one. */
		color?: string | null;
	};
	onCancel: () => void;
}) {
	const checkoutState = useCheckoutElements();
	const savedPrefill = useSavedBillingAddress();
	const billing = useSessionBillingAddress(checkoutState, savedPrefill);
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);
	const onCancelStable = useRef(onCancel).current;

	// ── The delivery address ─────────────────────────────────────────────
	// The merch session collects a SHIPPING address — the delivery destination, which
	// tax resolves from and Printful ships to. **Stripe's form renders no shipping
	// fields at all in elements mode** (found live 2026-10-15: the Payment Element
	// shows the card and nothing else) — so the session's delivery address exists only
	// through the headless `updateShippingAddress` write, which is Anthers' own UI's
	// job. The 2026-10-11 decision keeps shipping per-order: the checkbox (defaulting
	// checked once a saved billing address exists, step 5 of that decision) delivers to
	// the address the billing form put on the session; unchecking shows Anthers' own
	// US-only form, which resolves on settle into the same headless write.
	const [sameAsBilling, setSameAsBilling] = useState(false);
	const decidedRef = useRef(false);
	useEffect(() => {
		if (decidedRef.current || savedPrefill === undefined) return;
		// The defaulting moment happens once: a saved address checks the box; nothing
		// saved leaves it unchecked. A later-toggle is always the buyer's.
		decidedRef.current = true;
		if (savedPrefill !== null) setSameAsBilling(true);
	}, [savedPrefill]);

	// Whether the session has ACCEPTED the delivery address — the confirm gate's
	// shipping half, so a buyer cannot pay against a session that carries no
	// destination (or one they abandoned mid-edit). The accepted value's key is what
	// re-arms a resolve after an edit, exactly as the billing half does.
	const [shippingAcceptedKey, setShippingAcceptedKey] = useState<string | null>(null);
	const [shippingError, setShippingError] = useState<string | null>(null);
	// The override form's typed value; null while the checkbox is checked (the push
	// owns the session's address then).
	const [typedShipping, setTypedShipping] = useState<UsAddressInput | null>(null);

	// The current session object, read through a ref — the hook above records why: the
	// session object's identity churns, and a resolve must arm on the address, not
	// the tick.
	const checkoutRef = useRef<
		Extract<StripeUseCheckoutElementsResult, { type: "success" }>["checkout"] | null
	>(null);
	useEffect(() => {
		checkoutRef.current = checkoutState.type === "success" ? checkoutState.checkout : null;
	});

	// One headless write: `updateShippingAddress` on the session, with Stripe's own
	// answer deciding accepted (false = refused; the error surfaces beside the form).
	const pushShipping = useCallback(async (contact: StripeCheckoutContact) => {
		const checkout = checkoutRef.current;
		if (!checkout) return false;
		const result = await checkout.updateShippingAddress(contact).catch(() => null);
		if (!result || result.type === "error") {
			setShippingError(result?.type === "error" ? result.error.message || null : null);
			return false;
		}
		setShippingError(null);
		return true;
	}, []);

	useEffect(() => {
		if (!sameAsBilling) return;
		if (checkoutState.type !== "success") return;
		if (!billing.accepted || billing.acceptedAddress == null) return;
		let canceled = false;
		const contact = toCheckoutContact(billing.acceptedAddress);
		const key = contactKey(contact);
		if (shippingAcceptedKey === key) return;
		const timer = setTimeout(() => {
			void (async () => {
				// A resolved re-fire after an edit re-runs this same shape; a stale push
				// (the box untoggled mid-flight) is dropped by its cleanup flag.
				const ok = await pushShipping(contact);
				if (ok && !canceled) setShippingAcceptedKey(key);
			})();
		}, TAX_RESOLVE_DEBOUNCE_MS);
		return () => {
			canceled = true;
			clearTimeout(timer);
		};
		// `checkoutState.type` is the session's arrival flip, not a value the body
		// tracks beyond the guard; `billing.acceptedAddress`'s settlement is the event
		// a push answers, and `shippingAcceptedKey` the dedupe.
	}, [
		sameAsBilling,
		billing.accepted,
		billing.acceptedAddress,
		checkoutState.type,
		shippingAcceptedKey,
		pushShipping,
	]);

	useEffect(() => {
		// Unchecking hands the delivery address to the override form: nothing is
		// withdrawn from the session (a session that requires shipping refuses a null
		// address), so the buyer's next settled resolve replaces the value instead.
		if (!sameAsBilling) setTypedShipping((t) => t ?? EMPTY_ADDRESS);
	}, [sameAsBilling]);

	// The override form's resolve — every settled complete US address lands on the
	// session (one accepted value per change, the billing resolve's own shape).
	useEffect(() => {
		if (sameAsBilling || typedShipping == null) return;
		if (!isAddressComplete(typedShipping)) return;
		const contact = toCheckoutContact(typedShipping);
		const key = contactKey(contact);
		if (shippingAcceptedKey === key) return;
		const timer = setTimeout(() => {
			void (async () => {
				const ok = await pushShipping(contact);
				if (ok) setShippingAcceptedKey(key);
			})();
		}, TAX_RESOLVE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [sameAsBilling, typedShipping, shippingAcceptedKey, pushShipping]);

	const totals =
		checkoutState.type === "success"
			? sessionTotalsFrom(
					checkoutState.checkout.total?.total?.minorUnitsAmount ?? null,
					checkoutState.checkout.taxAmounts ?? null,
				)
			: null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (checkoutState.type !== "success" || !billing.accepted || shippingAcceptedKey == null)
			return;
		setProcessing(true);
		setError(null);
		try {
			const result = await checkoutState.checkout.confirm();
			if (result.type === "error") {
				setError(result.error.message || "Payment failed — please try again.");
				return;
			}
			// The Printful order is placed by the webhook's completion path; a shirt
			// ships rather than landing in a Library, so the success copy says the
			// truthful thing about what happens next.
			setSucceeded(true);
		} catch (err) {
			setError(
				err instanceof Error && err.message ? err.message : "Payment failed — please try again.",
			);
		} finally {
			setProcessing(false);
		}
	};

	if (succeeded) {
		return (
			<div className="alert alert-success">
				<span>Order placed — your shirt is being printed and will ship once it's ready.</span>
			</div>
		);
	}

	if (checkoutState.type === "error") {
		return (
			<div className="alert alert-error text-sm">
				<span>{checkoutState.error.message || "Checkout couldn't load — please try again."}</span>
			</div>
		);
	}

	const canConfirm =
		checkoutState.type === "success" &&
		mayConfirm(checkoutState.checkout.canConfirm, billing.accepted) &&
		// The session's delivery address is accepted by SOME resolve (the checkbox's
		// push or the override form's) — without it, Stripe's readiness alone would let
		// a buyer pay a session that carries no destination at all.
		shippingAcceptedKey != null &&
		totals?.buyerTotal != null;

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			<CheckoutBillingAddressBlock billing={billing} />
			{/*
			    "Ship to my billing address" — the delivery address collected by Stripe's
			    rendered shipping fields, filled headlessly from the address the billing
			    form put on the session while this is checked (the defaulting rule:
			    checked once a saved address exists, per the 2026-10-11 decision's step 5).
			*/}
			{/*
			    The delivery address — the checkbox is its two modes: same as billing (the
			    session's address is the billing form's, pushed headlessly), or the
			    override form below (Anthers' own US-only form, the same shape the billing
			    block renders, resolving onto the session the same way tax does).
			*/}
			<div className="bg-base-100 border border-base-300 rounded-lg p-3">
				<label
					className="flex items-center gap-2 text-sm cursor-pointer"
					data-testid="shipping-same-as-billing"
				>
					<input
						type="checkbox"
						className="checkbox checkbox-sm"
						checked={sameAsBilling}
						onChange={(e) => {
							setShippingError(null);
							setSameAsBilling(e.target.checked);
						}}
					/>
					<span>Ship to my billing address</span>
				</label>
				{!sameAsBilling && (
					<div className="mt-3" data-testid="shipping-address-form">
						<p className="font-semibold text-sm mb-2">Delivery address</p>
						<UsBillingAddressForm
							kind="shipping"
							value={typedShipping ?? EMPTY_ADDRESS}
							onChange={setTypedShipping}
						/>
						<p className="text-base-content/60 text-xs mt-2">
							Where the shirt ships — tax resolves from this address, and Printful delivers to it.
						</p>
					</div>
				)}
				{shippingError && (
					<p className="text-error text-xs mt-2" data-testid="shipping-address-error">
						{shippingError}
					</p>
				)}
			</div>
			<div className="rounded-lg border border-base-300 p-3">
				<PaymentElement options={{ fields: { billingDetails: "never" } }} />
			</div>
			<dl className="w-full rounded-lg bg-base-100 p-3 text-sm space-y-1.5">
				<div className="flex justify-between text-base-content/60">
					<dt>
						The shirt{quote.color ? `, ${quote.color}` : ""}, size {quote.size}
					</dt>
					<dd className="tabular-nums">
						{quote.discount ? <s>${quote.listPrice}</s> : null} ${quote.goodsPrice}
					</dd>
				</div>
				{quote.discount && (
					<div className="flex justify-between text-success">
						<dt>
							Badge discount <span className="text-xs">({quote.discount.percent}% off)</span>
						</dt>
						<dd className="tabular-nums">−${quote.discount.saved}</dd>
					</div>
				)}
				<div className="flex justify-between text-base-content/60">
					<dt>Shipping (Printful's)</dt>
					<dd className="tabular-nums">${quote.shipping}</dd>
				</div>
				<div className="flex justify-between text-base-content/60">
					<dt>Sales tax</dt>
					{/* The figure, once the session has resolved it from the delivery
					    address; before that, where it comes from. `totals.tax` is the
					    session's own exclusive-tax figure (see `sessionTotalsFrom`). */}
					<dd className="tabular-nums">
						{totals?.tax != null ? (
							`$${totals.tax.toFixed(2)}`
						) : (
							<span className="text-xs">from your address</span>
						)}
					</dd>
				</div>
			</dl>
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}
			<button type="submit" className="btn btn-primary w-full" disabled={!canConfirm || processing}>
				{processing
					? "Processing…"
					: totals?.buyerTotal != null
						? `Pay $${totals.buyerTotal.toFixed(2)}`
						: `Pay + shipping + tax`}
			</button>
			<button type="button" className="btn btn-ghost btn-sm w-full" onClick={onCancelStable}>
				Back
			</button>
		</form>
	);
}

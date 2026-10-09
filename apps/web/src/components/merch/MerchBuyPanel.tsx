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
 * The price rows are the decision's transparency rule as the buyer sees it: the list
 * price (Printful's own retail price for the variant), the Badge discount beside it when
 * the buyer holds one, Printful's shipping added at checkout, and tax resolved at the
 * session. **The print cost is never a buyer-visible figure** — the transparency prose
 * ("about $20 to print, the rest funds Anthers' programs") lives in the wiki's copy, not
 * in a checkout.
 */
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult } from "@anthers/web-shared/types";
import {
	CheckoutElementsProvider,
	PaymentElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { useEffect, useRef, useState } from "react";
import { getStripe } from "../../lib/stripe";
import CheckoutBillingAddressBlock from "../payments/CheckoutBillingAddressBlock";
import {
	mayConfirm,
	sessionTotalsFrom,
	useSessionBillingAddress,
} from "../payments/useSessionBillingAddress";

interface MerchBuyPanelProps {
	workId: number;
	slug: string;
	access: AccessResult;
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

export default function MerchBuyPanel({ slug, access }: MerchBuyPanelProps) {
	const [colors, setColors] = useState<MerchColorGroup[] | null>(null);
	const [variantsError, setVariantsError] = useState<string | null>(null);
	const [color, setColor] = useState<string | null>(null);
	const [size, setSize] = useState<string | null>(null);
	const [session, setSession] = useState<MerchQuote | null>(null);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

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
				// A single-color item skips the color picker entirely — the row is
				// preselected, and only the size asks.
				if (body?.colors?.length === 1) setColor(body.colors[0].color);
			})
			.catch(() => {
				if (!canceled) setVariantsError("We couldn't load the options right now.");
			});
		return () => {
			canceled = true;
		};
	}, [slug]);

	const pickedGroup = colors?.find((g) => g.color === color) ?? null;

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

	if (access.isFree) return null;

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
				<div>
					<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-2">
						Pricing
					</h2>
					{/* The pickers ARE the price display on a merch Work — each variant's
					    price is Printful's own retail price for it (stamped at setup),
					    discounted when this buyer holds a Badge, so the picker and the
					    price are one control. Color first, then size; a one-color item
					    renders only the size row. */}
					{colors ? (
						colors.length > 0 ? (
							<div className="space-y-2 w-full">
								{colors.length > 1 && (
									<fieldset className="flex flex-wrap gap-2 border-0 p-0 m-0" aria-label="Color">
										<legend className="sr-only">Color</legend>
										{colors.map((g) => (
											<button
												key={g.color}
												type="button"
												aria-pressed={color === g.color}
												className={`btn btn-sm ${color === g.color ? "btn-primary" : "btn-outline"}`}
												onClick={() => {
													setColor(g.color);
													setSize(null);
													setSession(null);
												}}
											>
												<span>{g.color}</span>
											</button>
										))}
									</fieldset>
								)}
								<fieldset
									className="flex flex-wrap gap-2 border-0 p-0 m-0"
									aria-label="Size"
									disabled={!color}
								>
									<legend className="sr-only">Size</legend>
									{(pickedGroup?.sizes ?? []).map((v) => (
										<button
											key={v.size}
											type="button"
											aria-pressed={size === v.size}
											className={`btn btn-sm justify-between ${size === v.size ? "btn-primary" : "btn-outline"}`}
											onClick={() => {
												setSize(v.size);
												setSession(null);
											}}
										>
											<span>{v.size}</span>
											<span className="tabular-nums ml-2">${v.amount}</span>
										</button>
									))}
								</fieldset>
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

				{size && color && (
					<dl className="w-full rounded-lg bg-base-100 p-3 text-sm space-y-1.5">
						<MerchPriceRows variant={pickedGroup?.sizes.find((v) => v.size === size)} />
					</dl>
				)}

				{sessionError && (
					<div className="alert alert-error text-sm w-full">
						<span>{sessionError}</span>
					</div>
				)}

				<div className="grid gap-2 w-full mt-auto">
					<button
						type="button"
						className="btn btn-primary w-full"
						disabled={!size || !color || creating}
						onClick={() => void createSession()}
					>
						{creating ? "Starting checkout…" : "Buy this shirt"}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * The price rows for one chosen size. Every figure is the server's own quote — the
 * client renders the discount's arithmetic as dollars beside the undiscounted list,
 * both of which the server computed with decimal arithmetic; no money is computed here.
 */
function MerchPriceRows({ variant }: { variant: MerchVariant | undefined }) {
	if (!variant) return null;
	return (
		<>
			<div className="flex justify-between text-base-content/60">
				<dt>List price</dt>
				<dd className="tabular-nums">
					{variant.discount ? <s>${variant.listPrice}</s> : `$${variant.listPrice}`}
				</dd>
			</div>
			{variant.discount && (
				<div className="flex justify-between text-success">
					<dt>
						Badge discount <span className="text-xs">({variant.discount}% off)</span>
					</dt>
					{/* Both figures are the server's quote; this renders their difference. */}
					<dd className="tabular-nums">
						−${(Number(variant.listPrice) - Number(variant.amount)).toFixed(2)}
					</dd>
				</div>
			)}
			<div className="flex justify-between text-base-content/60">
				<dt>
					Shipping <span className="text-xs">(Printful's charge)</span>
				</dt>
				<dd className="text-xs">added at checkout</dd>
			</div>
			<div className="flex justify-between text-base-content/60">
				<dt>Sales tax</dt>
				<dd className="text-xs">calculated at checkout</dd>
			</div>
		</>
	);
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
	const billing = useSessionBillingAddress(checkoutState);
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);
	const onCancelStable = useRef(onCancel).current;

	const totals =
		checkoutState.type === "success"
			? sessionTotalsFrom(
					checkoutState.checkout.total?.total?.minorUnitsAmount ?? null,
					checkoutState.checkout.taxAmounts ?? null,
				)
			: null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (checkoutState.type !== "success" || !billing.accepted) return;
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
		totals?.buyerTotal != null;

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			<CheckoutBillingAddressBlock billing={billing} />
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
					<dd className="text-xs">from your address</dd>
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

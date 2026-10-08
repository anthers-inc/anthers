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
 * The price decomposition is the decision's transparency rule, verbatim: the print cost
 * is Printful's, the margin is Anthers', shipping is Printful's, tax is resolved at the
 * session. The quote renders the four.
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
	printCost: string;
	amount: string;
	inStock: boolean;
}

interface MerchQuote {
	amount: string;
	printCost: string;
	margin: string;
	shipping: string;
	size: string;
	salesTax: null;
	buyerTotal: null;
	clientSecret: string;
}

export default function MerchBuyPanel({ slug, access }: MerchBuyPanelProps) {
	const [variants, setVariants] = useState<MerchVariant[] | null>(null);
	const [variantsError, setVariantsError] = useState<string | null>(null);
	const [size, setSize] = useState<string | null>(null);
	const [session, setSession] = useState<MerchQuote | null>(null);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	// The size list, per Work — fetched unconditionally (hooks order), read by the
	// branches below.
	useEffect(() => {
		let canceled = false;
		client.api.payments.merch[":slug"].variants
			.$get({ param: { slug } })
			.then(async (res) => {
				if (canceled) return;
				const body = (await res.json().catch(() => null)) as {
					variants?: MerchVariant[];
					error?: string;
				} | null;
				if (!res.ok) {
					setVariantsError(body?.error ?? "We couldn't load the sizes right now.");
					return;
				}
				setVariants(body?.variants ?? []);
			})
			.catch(() => {
				if (!canceled) setVariantsError("We couldn't load the sizes right now.");
			});
		return () => {
			canceled = true;
		};
	}, [slug]);

	const createSession = async () => {
		if (!size) return;
		setCreating(true);
		setSessionError(null);
		try {
			const res = await client.api.payments.merch.checkout[":slug"].$post({
				param: { slug },
				json: { size },
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
		// The session quote carries the goods line's breakdown; the size is rendered
		// from the picked state (the session is keyed to the size it was created for).
		const pickedSize = session.size ?? size ?? "";
		return (
			<div className="card bg-base-200 border border-base-300 h-full">
				<div className="card-body p-5 gap-4">
					<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
						Checkout — size {pickedSize}
					</h2>
					<CheckoutElementsProvider
						stripe={getStripe()}
						options={{ clientSecret: session.clientSecret }}
					>
						<MerchCheckoutForm
							quote={{ amount: session.amount, shipping: session.shipping }}
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
					{/* The size picker IS the price display on a merch Work — each size's
					    price is derived from Printful's print cost for that size, so the
					    picker and the price are one control. */}
					{variants ? (
						variants.length > 0 ? (
							<fieldset className="flex flex-wrap gap-2 border-0 p-0 m-0" aria-label="Size">
								<legend className="sr-only">Size</legend>
								{variants.map((v) => (
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

				{size && (
					<dl className="w-full rounded-lg bg-base-100 p-3 text-sm space-y-1.5">
						<MerchPriceRows variant={variants?.find((v) => v.size === size)} />
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
						disabled={!size || creating}
						onClick={() => void createSession()}
					>
						{creating ? "Starting checkout…" : "Buy this size"}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * The price rows for one chosen size. The margin is the SERVER's derived figure — the
 * client renders `amount − printCost` only because both are renders of one quote the
 * server computed with decimal arithmetic; no money figure is computed client-side.
 */
function MerchPriceRows({ variant }: { variant: MerchVariant | undefined }) {
	if (!variant) return null;
	const margin = (Number(variant.amount) - Number(variant.printCost)).toFixed(2);
	return (
		<>
			<div className="flex justify-between text-base-content/60">
				<dt>
					Print cost <span className="text-xs">(Printful's)</span>
				</dt>
				<dd className="tabular-nums">${variant.printCost}</dd>
			</div>
			<div className="flex justify-between text-base-content/60">
				<dt>
					Margin <span className="text-xs">(to Anthers' funds)</span>
				</dt>
				<dd className="tabular-nums">${margin}</dd>
			</div>
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
	quote: { amount: string; shipping: string };
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
					<dt>The shirt</dt>
					<dd className="tabular-nums">${quote.amount}</dd>
				</div>
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
						: `Pay $${quote.amount} + shipping + tax`}
			</button>
			<button type="button" className="btn btn-ghost btn-sm w-full" onClick={onCancelStable}>
				Back
			</button>
		</form>
	);
}

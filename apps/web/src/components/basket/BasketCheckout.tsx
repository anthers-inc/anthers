// SPDX-License-Identifier: Apache-2.0
/**
 * Paying for a basket — **the one checkout, embedded on Anthers' own page** (Parker,
 * 2026-10-03: payments are the one place that cannot be rough around the edges).
 *
 * Since the Work page's inline checkout was retired, this is the ONLY place in the app
 * where `CheckoutElementsProvider` mounts and the only purchase form that exists. A
 * single Work bought with "Buy Now" lands here exactly as a five-item basket does — the
 * flow is one flow, exercised at every count.
 *
 * The session is created server-side (`POST /basket/checkout`) and confirmed in place
 * with Stripe's Checkout-flavored Payment Element. The billing address is Anthers' own
 * US-only form (`CheckoutBillingAddressBlock`) writing to the session as the buyer types
 * (no address button — see `useSessionBillingAddress`), so Stripe Tax resolves the rate
 * and the buyer sees the tax-inclusive total BEFORE confirming. Nothing here prices
 * anything: the server builds the line items, the tax codes and the transfer; this
 * component reports what they resolved to.
 *
 * 🚨 **The session POST fires once per basket content — never per render.** The first
 * live checkout remounted this whole subtree every time the parent re-rendered (totals
 * reporting up, the quote refreshing), because a fresh `workIds` array identity reached
 * the fetch effect and re-fired it: the address the buyer had typed was wiped mid-fill.
 * See `workIdsKey` for how the identity is pinned now, and the failing case the session
 * remount test exists to keep out.
 *
 * 🚨 **Reliability rules this file owns** (each paid for by the first live checkout,
 * 2026-10-03):
 * - Every failing request surfaces the server's (or Stripe's) own message — no
 *   generic-only banner stands where a specific refusal exists.
 * - No dead ends: a failed session fetch offers a retry in place, without a reload.
 * - Every field autofills (see `UsBillingAddressForm`) — a password manager that
 *   cannot fill the address is a failure, not a quirk.
 */
import { client } from "@anthers/web-shared/rpc";
import {
	CheckoutElementsProvider,
	PaymentElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { useCallback, useEffect, useRef, useState } from "react";
import { getStripe } from "../../lib/stripe";
import CheckoutBillingAddressBlock from "../payments/CheckoutBillingAddressBlock";
import {
	mayConfirm,
	sessionTotals,
	useSessionBillingAddress,
} from "../payments/useSessionBillingAddress";

interface BasketCheckoutProps {
	workIds: number[];
	/** Server-quoted subtotal, shown until the session's real total resolves. */
	buyerTotal: string;
	/**
	 * The session's own totals, reported up as they resolve — the tax-inclusive total
	 * and the tax, nulls before the address lands. The receipt beside the checkout
	 * renders from the quote before they exist and from them once they do, so the
	 * buyer reads one set of numbers that grows rather than two sets that disagree.
	 */
	onTotals?: (totals: { buyerTotal: number | null; tax: number | null } | null) => void;
	onComplete: () => void;
}

/**
 * A content identity for the basket the session is being created for: the ids sorted and
 * joined. Two arrays of the same ids are the same basket, whatever their identity — this
 * is the value the fetch effect keys on, because the page renders from `localStorage`
 * reads whose array identity churns on every render.
 */
export function workIdsKey(workIds: number[]): string {
	return [...workIds].sort((a, b) => a - b).join(",");
}

function CheckoutForm({ buyerTotal, onComplete, onTotals }: Omit<BasketCheckoutProps, "workIds">) {
	const checkoutState = useCheckoutElements();
	const billing = useSessionBillingAddress(checkoutState);
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [succeeded, setSucceeded] = useState(false);

	// Every change of what the session totals goes up to the receipt — including back to
	// null, when the address is edited and the rate re-resolves. The dependency array
	// names the VALUES the totals derive from rather than the session object itself,
	// which `useCheckoutElements` re-renders with a fresh identity on every tick.
	const totals = checkoutState.type === "success" ? sessionTotals(checkoutState.checkout) : null;
	const totalCents =
		checkoutState.type === "success"
			? (checkoutState.checkout.total?.total?.minorUnitsAmount ?? null)
			: null;
	const taxAmounts =
		checkoutState.type === "success" ? (checkoutState.checkout.taxAmounts ?? null) : null;
	const onTotalsStable = useRef(onTotals).current;
	useEffect(() => {
		if (!onTotalsStable) return;
		// Same read as below — one derivation, reported, not two that can drift.
		onTotalsStable(
			totalCents == null
				? null
				: {
						buyerTotal: totalCents / 100,
						tax:
							taxAmounts?.find((t) => !t.inclusive)?.minorUnitsAmount ??
							taxAmounts?.[0]?.minorUnitsAmount ??
							null,
					},
		);
		return () => onTotalsStable(null);
	}, [onTotalsStable, totalCents, taxAmounts]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		// The address must already be on the session — writing it as the buyer types is
		// what resolved the tax. Confirming without one would charge a total whose rate
		// was never resolved.
		if (checkoutState.type !== "success" || !billing.accepted) return;
		setProcessing(true);
		setError(null);

		try {
			// The session was already created by the provider's client secret fetch — the
			// server built its line items, tax codes and transfer when that happened, so
			// confirming is all that is left. Stripe's own message is shown on failure —
			// "Your card was declined", "insufficient funds" — never a paraphrase.
			const result = await checkoutState.checkout.confirm();
			if (result.type === "error") {
				setError(result.error.message || "Payment failed — please try again.");
				return;
			}

			// The purchases are written `pending` at checkout and flipped by the webhook,
			// so access follows within moments rather than instantly. Say that plainly
			// instead of showing a download link that might 403 for a second.
			setSucceeded(true);
			onComplete();
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
				<span>Purchase complete — everything in this basket is yours, in your Library.</span>
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

	// 🚨 Two gates, and neither implies the other: Stripe's `canConfirm` tracks the
	// Payment Element, `accepted` is our own record that the session took a US address —
	// and the session's own total is null until the tax lands, so a third read of the
	// truth agrees with both. A buyer cannot confirm past any one of them.
	const canConfirm =
		checkoutState.type === "success" &&
		mayConfirm(checkoutState.checkout.canConfirm, billing.accepted) &&
		totals?.buyerTotal != null;

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			{/* Anthers' own US-only form, not Stripe's Billing Address Element — the element
			    offers no country allow-list, so this form is US by construction. Address
			    edits resolve the session's tax automatically as they settle — this form's
			    submit is the Pay button and nothing else. */}
			<CheckoutBillingAddressBlock billing={billing} />
			<div className="rounded-lg border border-base-300 p-3">
				{/* `fields.billingDetails: "never"` because the address above already
				    collected everything AVS would check — asking twice on one screen is
				    the double collection this option exists to prevent, and the card's
				    own AVS check runs against the session's address. */}
				<PaymentElement options={{ fields: { billingDetails: "never" } }} />
			</div>
			<p className="text-xs text-base-content/50">
				Sales tax is calculated from your billing address — the rate varies by location, and Anthers
				sells to US billing addresses at launch.
			</p>
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
						: `Pay $${buyerTotal} + tax`}
			</button>
		</form>
	);
}

/**
 * Fetch the basket's session client secret from the server — exactly once per basket
 * content — and hand back the means to try again.
 *
 * 🚨 **A failure is a state with a Retry button, not a tombstone.** The first live
 * checkout stranded buyers on a skeleton when the session POST refused, and the only
 * road back was a reload — which on the page holding the money reads as "the payment
 * broke". The server's own `{ error }` text renders verbatim, and retrying re-fires
 * the same POST without touching anything else on the page.
 */
function useBasketClientSecret(workIds: number[]) {
	const [secret, setSecret] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [fetching, setFetching] = useState(true);

	// 🚨 The POST fires once per basket content, by CONTENT rather than by dependency
	// identity. The first live checkout keyed this effect on `workIds` — a fresh array
	// from `items.map(...)` on every render — so the totals-reporting re-render that
	// follows a tax resolution re-fired the POST and remounted the Element tree from
	// scratch: card cleared, address reset, resolved tax discarded. The buyer read that
	// as "the page refreshed and wiped my form". The ref pin means the parent may render
	// a fresh array as often as it likes; the effect below re-runs on every re-render
	// (so a genuinely NEW basket — an id added or removed — is still picked up the
	// moment it arrives) but fires only when the sorted contents actually changed.
	const workIdsRef = useRef(workIds);
	const sentKeyRef = useRef<string | null>(null);

	const fetchSecret = useCallback(async () => {
		setFetching(true);
		setFailed(null);
		try {
			// The body carries nothing: the server buys the account's own stored basket —
			// the same ids this page displayed and the quote priced. A client-named list
			// was the localStorage design's trust; the server-side basket does not accept
			// it, and the empty body is the honest request.
			const res = await client.api.payments.basket.checkout.$post({ json: {} });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setFailed(body?.error ?? "Couldn't start checkout — please try again.");
				setSecret(null);
				return;
			}
			const checkout = (await res.json()) as unknown as { clientSecret?: string | null };
			if (!checkout.clientSecret) {
				setFailed("Couldn't start checkout — please try again.");
				return;
			}
			setSecret(checkout.clientSecret);
		} catch {
			setFailed("Couldn't reach the payment server — check your connection and try again.");
		} finally {
			setFetching(false);
		}
	}, []);

	useEffect(() => {
		workIdsRef.current = workIds;
		const key = workIdsKey(workIds);
		if (sentKeyRef.current === key) return;
		sentKeyRef.current = key;
		void fetchSecret();
	});

	return { secret, failed, fetching, retry: fetchSecret };
}

export default function BasketCheckout(props: BasketCheckoutProps) {
	const { secret, failed, fetching, retry } = useBasketClientSecret(props.workIds);
	if (failed) {
		return (
			<div className="alert alert-warning text-sm">
				<span className="block">{failed}</span>
				<button type="button" className="btn btn-outline btn-xs mt-2" onClick={() => void retry()}>
					Try again
				</button>
			</div>
		);
	}
	if (!secret) {
		return fetching ? <div className="skeleton h-64 w-full" aria-hidden="true" /> : null;
	}
	return (
		<CheckoutElementsProvider stripe={getStripe()} options={{ clientSecret: secret }}>
			<CheckoutForm
				buyerTotal={props.buyerTotal}
				onTotals={props.onTotals}
				onComplete={props.onComplete}
			/>
		</CheckoutElementsProvider>
	);
}

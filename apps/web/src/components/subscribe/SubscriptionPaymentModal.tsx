// SPDX-License-Identifier: Apache-2.0

import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import { client } from "@anthers/web-shared/rpc";
import type { BadgeOwner, SavedBillingAddress } from "@anthers/web-shared/types";
import Modal from "@anthers/web-shared/ui/Modal";
import {
	AddressElement,
	Elements,
	PaymentElement,
	useElements,
	useStripe,
} from "@stripe/react-stripe-js";
import type { StripeAddressElementChangeEvent } from "@stripe/stripe-js";
import { useEffect, useMemo, useState } from "react";
import { getStripe } from "../../lib/stripe";
import { stripeAppearance } from "../../lib/stripeCard";

/** What the confirmation modal needs — computed server-side by /subscriptions/preview. */
export interface SubscriptionPreview {
	isChange: boolean;
	recurring: { amount: string; interval: string };
	chargeNow: string;
	nextBillingUnix: number | null;
	savedCard: { id: string; brand: string; last4: string } | null;
}

interface Props {
	/** Kept mounted while this is false so the shared wrapper can play the exit. */
	open: boolean;
	/**
	 * ⚠️ **Dollars a month, not a count.** It is `number` either way, so a caller passing a
	 * count typechecks and bills the wrong amount — a defect this guard exists for because
	 * it shipped once, silently.
	 */
	anthersSupport: number;
	/**
	 * Support pointed at creators, riding on the same charge.
	 *
	 * The subscription carries ONE ITEM PER DESTINATION — `anthersSupport` and each of
	 * these — because everything a user gives arrives on one monthly charge, which is also
	 * what amortizes the fixed card fee across the creators on it.
	 */
	directed?: { creatorId: number; amount: number }[];
	badgeName: string;
	/** The Badge's owners, publisher first; more than one adds the shared-support line. */
	owners?: BadgeOwner[];
	preview: SubscriptionPreview;
	/** Called after the change is confirmed — the webhook then applies the new amount. */
	onComplete: () => void;
	onClose: () => void;
}

/** The invoice that already exists when a new card is being confirmed. */
interface PendingPayment {
	clientSecret: string;
	/** The address saved before the subscription was created, for the card's AVS details. */
	billingAddress: SavedBillingAddress | null;
	/** The first invoice's tax-inclusive amount due, when Stripe reported it. */
	amountDue: string | null;
}

function formatDate(unix: number | null): string | null {
	if (!unix) return null;
	return new Date(unix * 1000).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Whether what the user was quoted differs from what the POST would bill.
 *
 * Compared in whole cents, because both sides arrive as floats and a cent is the finest
 * grain anything can actually be charged at.
 */
export function quoteDisagrees(
	quotedAmount: string,
	anthersSupport: number,
	directed?: { amount: number }[],
): boolean {
	const quoted = Number(quotedAmount);
	if (!Number.isFinite(quoted)) return true;
	const billed = (directed ?? []).reduce((sum, d) => sum + d.amount, anthersSupport);
	return Math.round(quoted * 100) !== Math.round(billed * 100);
}

/** The Address Element's value in the shape the subscription route saves to the Customer. */
function savedAddressFrom(value: StripeAddressElementChangeEvent["value"]): SavedBillingAddress {
	return {
		name: value.name.trim(),
		line1: value.address.line1.trim(),
		line2: value.address.line2?.trim() ? value.address.line2.trim() : null,
		city: value.address.city.trim(),
		state: value.address.state.trim(),
		postalCode: value.address.postal_code.trim(),
	};
}

/** The saved address in the shape the Payment Element's billing details take. */
function billingDetailsFrom(address: SavedBillingAddress) {
	return {
		name: address.name,
		address: {
			line1: address.line1,
			...(address.line2 ? { line2: address.line2 } : {}),
			city: address.city,
			state: address.state,
			postal_code: address.postalCode,
			country: "US" as const,
		},
	};
}

function PaymentForm({
	open,
	anthersSupport,
	directed,
	badgeName,
	owners,
	preview,
	pending,
	onPending,
	onComplete,
	onClose,
}: Props & {
	pending: PendingPayment | null;
	onPending: (payment: PendingPayment) => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [processing, setProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// New subscriptions can choose saved vs new card; a change always uses the
	// subscription's card on file. Default to the saved card when there is one.
	const [useNewCard, setUseNewCard] = useState(!preview.savedCard);

	/**
	 * The billing address a new supporter enters, collected because the subscription's
	 * automatic tax resolves the rate from it. Anthers sells to US billing addresses at
	 * launch, so the element offers only the US; the address rides on the payment method's
	 * `billing_details` at confirm, which is what Stripe Tax reads.
	 */
	const [billingAddress, setBillingAddress] = useState<
		StripeAddressElementChangeEvent["value"] | null
	>(null);

	const nextDate = formatDate(preview.nextBillingUnix);
	const { savedCard, isChange } = preview;

	// A kept-mounted dialog keeps its last attempt, so a second open starts clean.
	useEffect(() => {
		if (!open) return;
		setProcessing(false);
		setError(null);
		setUseNewCard(!preview.savedCard);
		setBillingAddress(null);
	}, [open, preview.savedCard]);

	/**
	 * 🚨 **The quote and the charge must be the same number**, checked at the last point
	 * before money moves. This modal is the only place that holds both: the quote the user
	 * just read and the amount the POST will bill.
	 */
	const mismatch = quoteDisagrees(preview.recurring.amount, anthersSupport, directed);

	const needsNewAddress = !isChange && (!savedCard || useNewCard);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (mismatch) {
			// Never silently charge the other number. A refusal a user can retry past is a
			// worse outcome than the one this prevents, so it stops here.
			setError("This doesn't add up — we won't charge you. Please reload and try again.");
			return;
		}
		if (needsNewAddress && !billingAddress) {
			setError("Enter your billing address — sales tax is calculated from it.");
			return;
		}
		const address = needsNewAddress && billingAddress ? savedAddressFrom(billingAddress) : null;
		setProcessing(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.account.$post({
				json: {
					anthersSupport,
					...(directed?.length ? { directed } : {}),
					...(address ? { billingAddress: address } : {}),
				},
			});
			if (!res.ok) {
				setError("Couldn't update your support. Please try again.");
				setProcessing(false);
				return;
			}
			const data = (await res.json()) as {
				pending?: boolean;
				clientSecret?: string | null;
				amountDue?: string | null;
			};

			if (data.pending && data.clientSecret) {
				// A new subscription returns a client secret. The card on file path confirms
				// the first invoice without showing a card form; a new card moves to the
				// Payment Element step, where the invoice's confirmation secret is mounted.
				if (savedCard && !useNewCard) {
					if (!stripe) {
						setError("Payments aren't ready. Please try again.");
						setProcessing(false);
						return;
					}
					const { error: err } = await stripe.confirmCardPayment(data.clientSecret, {
						payment_method: savedCard.id,
					});
					if (err) {
						setError(err.message ?? "Payment failed.");
						setProcessing(false);
						return;
					}
				} else {
					onPending({
						clientSecret: data.clientSecret,
						billingAddress: address,
						amountDue: data.amountDue ?? null,
					});
					setProcessing(false);
					return;
				}
			}
			onComplete();
		} catch {
			setError("Couldn't update your support. Please try again.");
			setProcessing(false);
		}
	};

	const confirmNewCard = async () => {
		if (!stripe || !elements || !pending || processing) return;
		setProcessing(true);
		setError(null);
		try {
			const submitted = await elements.submit();
			if (submitted.error) {
				setError(submitted.error.message ?? "Check the card details and try again.");
				setProcessing(false);
				return;
			}
			const { error: err } = await stripe.confirmPayment({
				elements,
				clientSecret: pending.clientSecret,
				confirmParams: {
					return_url: `${window.location.origin}${STRIPE_RETURN_PATHS.billingPortalReturn}`,
					...(pending.billingAddress
						? {
								payment_method_data: {
									billing_details: billingDetailsFrom(pending.billingAddress),
								},
							}
						: {}),
				},
				// Cards confirm in place; the return URL is only ever navigated by a
				// redirect-based method, which the account's card-only configuration
				// does not offer.
				redirect: "if_required",
			});
			if (err) {
				setError(err.message ?? "Payment failed.");
				setProcessing(false);
				return;
			}
			onComplete();
		} catch {
			setError("Payment failed — please try again.");
			setProcessing(false);
		}
	};

	const quoteBlock = (
		<div className="rounded-lg bg-base-200 p-4 my-3 text-sm flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<span>
					{isChange
						? "Due today (prorated)"
						: pending
							? "Charged today"
							: "Charged today, before tax"}
				</span>
				<strong>${pending?.amountDue ?? preview.chargeNow}</strong>
			</div>
			<div className="flex items-center justify-between text-base-content/70">
				<span>Then</span>
				<span>
					${preview.recurring.amount}/{preview.recurring.interval}
				</span>
			</div>
			{nextDate && (
				<div className="flex items-center justify-between text-base-content/70">
					<span>Next charge</span>
					<span>{nextDate}</span>
				</div>
			)}
		</div>
	);

	if (pending) {
		return (
			<Modal open={open}>
				<div className="modal-box max-w-md">
					<h3 className="font-bold text-lg mb-1">Confirm your card</h3>
					{owners && owners.length > 1 && (
						<p className="text-xs text-base-content/50 mb-2">
							Shared with{" "}
							{owners.map((owner) => owner.displayName || `@${owner.handle}`).join(", ")}. The
							support is split evenly between them.
						</p>
					)}
					<p className="text-xs text-base-content/50 mb-3">
						Your billing address is saved. Nothing else is charged until you confirm.
					</p>
					{quoteBlock}
					<div className="border border-base-300 rounded-lg p-3 bg-base-100 mb-3">
						<PaymentElement options={{ fields: { billingDetails: "never" } }} />
					</div>
					{error && (
						<div className="alert alert-error text-sm">
							<span>{error}</span>
						</div>
					)}
					<div className="flex gap-2 justify-end mt-1">
						<button type="button" className="btn btn-ghost" onClick={onClose} disabled={processing}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void confirmNewCard()}
							disabled={processing || !stripe || !elements}
						>
							{processing ? "Processing…" : `Pay $${pending.amountDue ?? preview.chargeNow}`}
						</button>
					</div>
				</div>
				<button
					type="button"
					className="modal-backdrop"
					onClick={onClose}
					aria-label="Close"
					disabled={processing}
				/>
			</Modal>
		);
	}

	return (
		<Modal open={open}>
			<div className="modal-box max-w-md">
				<h3 className="font-bold text-lg mb-1">
					{isChange ? `Switch to ${badgeName}` : `Give ${badgeName}`}
				</h3>
				{owners && owners.length > 1 && (
					<p className="text-xs text-base-content/50 mb-2">
						Shared with {owners.map((owner) => owner.displayName || `@${owner.handle}`).join(", ")}.
						The support is split evenly between them.
					</p>
				)}

				{quoteBlock}
				<p className="text-xs text-base-content/50 mb-3">
					Renews automatically. Stop anytime — your support stays active through the period you've
					paid for.
				</p>

				<form onSubmit={submit} className="flex flex-col gap-3">
					{/* Payment method */}
					{isChange ? (
						savedCard && (
							<div className="text-sm text-base-content/70">
								Charged to your saved <span className="capitalize">{savedCard.brand}</span> ••••{" "}
								{savedCard.last4}.
							</div>
						)
					) : savedCard && !useNewCard ? (
						<div className="flex items-center justify-between rounded-lg border border-base-300 px-3 py-2 text-sm">
							<span className="capitalize">
								{savedCard.brand} •••• {savedCard.last4}
							</span>
							<button
								type="button"
								className="link link-primary text-xs"
								onClick={() => setUseNewCard(true)}
							>
								Use a different card
							</button>
						</div>
					) : (
						<div>
							{/* The billing address the subscription's tax is calculated from.
							    Offered to the US only — that is the posture's launch market, and a
							    saved card's address is already on the customer for the saved-card
							    path. */}
							<div className="border border-base-300 rounded-lg p-3 bg-base-100 mb-3">
								<AddressElement
									options={{
										mode: "billing",
										allowedCountries: ["US"],
										fields: { phone: "never" },
									}}
									onChange={(e) => setBillingAddress(e.complete ? e.value : null)}
								/>
							</div>
							<p className="text-xs text-base-content/50">
								The card is entered on the next step, after the subscription is prepared.
							</p>
							{savedCard && (
								<button
									type="button"
									className="link link-primary text-xs mt-1"
									onClick={() => setUseNewCard(false)}
								>
									Use saved {savedCard.brand} •••• {savedCard.last4}
								</button>
							)}
						</div>
					)}

					{error && (
						<div className="alert alert-error text-sm">
							<span>{error}</span>
						</div>
					)}

					<div className="flex gap-2 justify-end mt-1">
						<button type="button" className="btn btn-ghost" onClick={onClose} disabled={processing}>
							Cancel
						</button>
						<button type="submit" className="btn btn-primary" disabled={processing || mismatch}>
							{processing
								? "Processing…"
								: isChange
									? "Confirm change"
									: savedCard && !useNewCard
										? `Subscribe · $${preview.chargeNow}`
										: "Continue to card"}
						</button>
					</div>
				</form>
			</div>
			<button
				type="button"
				className="modal-backdrop"
				onClick={onClose}
				aria-label="Close"
				disabled={processing}
			/>
		</Modal>
	);
}

export default function SubscriptionPaymentModal(props: Props) {
	const [pending, setPending] = useState<PendingPayment | null>(null);
	const appearance = useMemo(stripeAppearance, []);

	// A closed modal starts fresh; the incomplete subscription, if one was created, is
	// Stripe's to expire, and the next open begins at the address step.
	useEffect(() => {
		if (!props.open) setPending(null);
	}, [props.open]);

	return (
		<Elements
			key={pending?.clientSecret ?? "address"}
			stripe={getStripe()}
			options={pending ? { clientSecret: pending.clientSecret, appearance } : { appearance }}
		>
			<PaymentForm {...props} pending={pending} onPending={setPending} />
		</Elements>
	);
}

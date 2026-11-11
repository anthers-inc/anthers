// SPDX-License-Identifier: Apache-2.0
/**
 * The account's **one saved payment method** — the card and the full US billing address
 * together, on the Stripe Customer the app already keeps.
 *
 * ⭐ **One object, one card** (Parker, 2026-11-07). The settings section used to save only
 * an address; it now saves the card with it, because a saved card is a normal thing to have
 * and the Adult control reads it. A live subscription that renews on the card is stated
 * with a chip and the card can be replaced, but not removed: the renewal must always have
 * a card, and the account does not keep a second one beside it.
 *
 * ⭐ **Both halves are Stripe's own Elements** (Parker, 2026-11-11). The card and the
 * address are collected by one Elements group — an `AddressElement` in billing mode,
 * restricted to the US, beside a `PaymentElement` that asks for no billing details of its
 * own — so the ZIP is typed once. The address attaches to the SetupIntent at confirmation
 * and `finalizePaymentInfo` reads it off the confirmed payment method, which is what makes
 * the saved object one thing rather than an address that can disagree with the card.
 *
 * 🚨 **The address is Stripe's, and so is the record.** The saved address is the Customer's
 * `address`/`name`; checkout prefills from it and writes the address it collected back to
 * it (`customer_update.address: "auto"` in `routes/payments.ts`). Nothing here stores an
 * address in Anthers' database.
 *
 * 🚨 **Cards only, and nothing is charged.** The SetupIntent saves the card so the Adult
 * rung can read its funding type; replacing the card moves the subscription to the new one
 * before the old card is detached.
 */
import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import { apiFetch } from "@anthers/web-shared/rpc";
import type { SavedBillingAddress } from "@anthers/web-shared/types";
import {
	AddressElement,
	Elements,
	PaymentElement,
	useElements,
	useStripe,
} from "@stripe/react-stripe-js";
import type { StripeAddressElementChangeEvent } from "@stripe/stripe-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getStripe } from "../../lib/stripe";
import { stripeAppearance } from "../../lib/stripeCard";
import { formatAddress } from "../payments/UsBillingAddressForm";

interface SavedCard {
	id: string;
	brand: string;
	last4: string;
	funding: string | null;
}

interface PaymentInfo {
	address: SavedBillingAddress | null;
	card: SavedCard | null;
	subscriptionAttached: boolean;
}

/** The Address Element's `value`, as its own change event carries it. */
type AddressValue = StripeAddressElementChangeEvent["value"];

/**
 * The saved address as the Address Element's mount-time defaults.
 *
 * The element has no imperative prefill — `defaultValues` is applied when it mounts — so the
 * card and address forms are remounted from the saved address each time they open.
 */
function addressDefaults(address: SavedBillingAddress | null) {
	if (!address) return undefined;
	return {
		name: address.name,
		address: {
			line1: address.line1,
			line2: address.line2 ?? "",
			city: address.city,
			state: address.state,
			postal_code: address.postalCode,
			country: "US",
		},
	};
}

/** The element's value in the shape the billing-address route accepts. */
function savedFromValue(value: AddressValue): SavedBillingAddress {
	return {
		name: value.name.trim(),
		line1: value.address.line1.trim(),
		line2: value.address.line2?.trim() ? value.address.line2.trim() : null,
		city: value.address.city.trim(),
		state: value.address.state.trim(),
		postalCode: value.address.postal_code.trim(),
	};
}

/** The saved address, as one line for the idle card. */
function displayAddress(address: SavedBillingAddress): string {
	return formatAddress({
		name: address.name,
		line1: address.line1,
		line2: address.line2 ?? "",
		city: address.city,
		state: address.state,
		postalCode: address.postalCode,
	});
}

/** Tell the Adult control on the Content tab that the proof it reads has changed. */
function announcePaymentInfoChanged() {
	window.dispatchEvent(new Event("anthers:payment-info-changed"));
}

/**
 * The billing address, shared by both forms.
 *
 * This is the advanced Address Element, whose billing mode supports `allowedCountries` —
 * the Checkout-flavored `BillingAddressElement` does not, which is why checkout keeps
 * Anthers' own US-only form (`UsBillingAddressForm`). The phone field is hidden because
 * nothing here reads one.
 */
function BillingAddress({ saved }: { saved: SavedBillingAddress | null }) {
	return (
		<AddressElement
			options={{
				mode: "billing",
				allowedCountries: ["US"],
				fields: { phone: "never" },
				defaultValues: addressDefaults(saved),
			}}
		/>
	);
}

/**
 * The card + address form, inside the SetupIntent's `Elements`.
 *
 * The address is not posted separately: it rides the SetupIntent at confirmation, and the
 * finalize call reads it off the payment method, makes the card the default, moves a
 * subscription onto it, and drops the old cards.
 */
function CardSetupForm({
	savedAddress,
	onSaved,
	onCancel,
}: {
	savedAddress: SavedBillingAddress | null;
	onSaved: (info: PaymentInfo) => void;
	onCancel: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		if (!stripe || !elements || busy) return;
		setBusy(true);
		setError(null);
		try {
			const address = await elements.getElement(AddressElement)?.getValue();
			if (!address?.complete) {
				setError("Enter your billing address — it is what the saved card is filed under.");
				return;
			}
			// Stripe's own validation for the card half; the address was checked above.
			const submitted = await elements.submit();
			if (submitted.error) {
				setError(submitted.error.message ?? "Check the card details and try again.");
				return;
			}
			const { error: stripeError, setupIntent } = await stripe.confirmSetup({
				elements,
				confirmParams: {
					return_url: `${window.location.origin}${STRIPE_RETURN_PATHS.paymentInfoReturn}`,
				},
				// Cards confirm in place; the return URL is only ever navigated by a
				// redirect-based method, which this account's card-only configuration
				// does not offer.
				redirect: "if_required",
			});
			// Stripe's own message says which thing about the card was wrong.
			if (stripeError) {
				setError(stripeError.message ?? "That card couldn't be added.");
				return;
			}
			if (!setupIntent) {
				setError("That card setup didn't complete. Please try again.");
				return;
			}

			const finalized = await apiFetch("/api/accounts/me/payment-info/finalize", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ setupIntentId: setupIntent.id }),
			});
			if (!finalized.ok) {
				const body = (await finalized.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "That card couldn't be saved.");
			}
			onSaved((await finalized.json()) as PaymentInfo);
		} catch (err) {
			setError(err instanceof Error ? err.message : "That card couldn't be saved.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<BillingAddress saved={savedAddress} />
			<div className="rounded-box border border-base-300 bg-base-100 px-3 py-3">
				<PaymentElement options={{ fields: { billingDetails: "never" } }} />
			</div>
			<p className="text-xs text-base-content/50">
				Nothing is charged. The card is stored at Stripe with the address, and replacing it later
				keeps your subscription on the new card.
			</p>
			{error && <p className="text-sm text-error">{error}</p>}
			<div className="flex gap-2">
				<button
					type="button"
					className="btn btn-primary btn-sm"
					disabled={busy || !stripe || !elements}
					onClick={() => void save()}
				>
					{busy ? "Saving…" : "Save payment info"}
				</button>
				<button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	);
}

/** The address alone, for editing the prefill without touching the card. */
function AddressForm({
	savedAddress,
	onSaved,
	onCancel,
}: {
	savedAddress: SavedBillingAddress | null;
	onSaved: (address: SavedBillingAddress) => void;
	onCancel: () => void;
}) {
	const elements = useElements();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		if (!elements || busy) return;
		setBusy(true);
		setError(null);
		try {
			const address = await elements.getElement(AddressElement)?.getValue();
			if (!address?.complete) {
				setError("Enter the full address before saving.");
				return;
			}
			const res = await apiFetch("/api/accounts/me/billing-address", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(savedFromValue(address.value)),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "That address didn't work. Please check it and retry.");
			}
			onSaved(((await res.json()) as { address: SavedBillingAddress }).address);
		} catch (err) {
			setError(err instanceof Error ? err.message : "That address didn't work.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<BillingAddress saved={savedAddress} />
			{error && <p className="text-sm text-error">{error}</p>}
			<div className="flex gap-2">
				<button
					type="button"
					className="btn btn-primary btn-sm"
					disabled={busy || !elements}
					onClick={() => void save()}
				>
					{busy ? "Saving…" : "Save address"}
				</button>
				<button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	);
}

export default function PaymentInfoSection() {
	const [info, setInfo] = useState<PaymentInfo | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [mode, setMode] = useState<"idle" | "card" | "address">("idle");
	const [setupSecret, setSetupSecret] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedJustNow, setSavedJustNow] = useState(false);
	const appearance = useMemo(stripeAppearance, []);

	const load = useCallback(async () => {
		try {
			const res = await apiFetch("/api/accounts/me/payment-info");
			if (res.ok) setInfo((await res.json()) as PaymentInfo);
		} finally {
			setLoaded(true);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const startCard = async () => {
		setError(null);
		setSavedJustNow(false);
		setBusy(true);
		try {
			const res = await apiFetch("/api/accounts/me/payment-info/setup", { method: "POST" });
			if (!res.ok) throw new Error();
			const { clientSecret } = (await res.json()) as { clientSecret: string };
			setSetupSecret(clientSecret);
			setMode("card");
		} catch {
			setError("We couldn't start the card setup. Please try again shortly.");
		} finally {
			setBusy(false);
		}
	};

	const startAddress = () => {
		setError(null);
		setSavedJustNow(false);
		setMode("address");
	};

	const remove = async () => {
		if (info?.subscriptionAttached || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/payment-info", { method: "DELETE" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "We couldn't remove the saved card.");
			}
			// The address is part of the same saved object; clearing the card clears it too.
			await apiFetch("/api/accounts/me/billing-address", { method: "DELETE" });
			announcePaymentInfoChanged();
			setSavedJustNow(false);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "We couldn't remove the saved card.");
		} finally {
			setBusy(false);
		}
	};

	if (!loaded) return null;

	const onCardSaved = (next: PaymentInfo) => {
		setInfo(next);
		setMode("idle");
		setSetupSecret(null);
		setSavedJustNow(true);
		announcePaymentInfoChanged();
	};

	const onAddressSaved = (address: SavedBillingAddress) => {
		setInfo((current) =>
			current ? { ...current, address } : { address, card: null, subscriptionAttached: false },
		);
		setMode("idle");
		setSavedJustNow(true);
	};

	const hasCard = Boolean(info?.card);
	const hasAddress = Boolean(info?.address);
	const subscriptionAttached = info?.subscriptionAttached === true;

	return (
		<div className="card bg-base-200 mb-6" data-testid="payment-info-section">
			<div className="card-body gap-3">
				<h3 className="card-title text-lg">Save payment info</h3>
				<p className="text-sm text-base-content/60">
					Save a card and billing address for faster checkout. Both are stored at Stripe, with your
					payment records rather than on Anthers' servers; checkout prefills from them, and the
					address you enter there updates the saved one.
				</p>
				{savedJustNow && (
					<p className="text-success text-sm" data-testid="payment-info-saved">
						Saved — your next checkout will use it.
					</p>
				)}
				{error && <p className="text-error text-sm">{error}</p>}

				{mode === "card" && setupSecret ? (
					<Elements stripe={getStripe()} options={{ clientSecret: setupSecret, appearance }}>
						<CardSetupForm
							savedAddress={info?.address ?? null}
							onSaved={onCardSaved}
							onCancel={() => {
								setMode("idle");
								setSetupSecret(null);
								setError(null);
							}}
						/>
					</Elements>
				) : mode === "address" ? (
					<Elements stripe={getStripe()} options={{ appearance }}>
						<AddressForm
							savedAddress={info?.address ?? null}
							onSaved={onAddressSaved}
							onCancel={() => {
								setMode("idle");
								setError(null);
							}}
						/>
					</Elements>
				) : hasCard || hasAddress ? (
					<div className="flex flex-col gap-3">
						{hasCard && info?.card && (
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<span className="font-medium capitalize">
									{info.card.brand} •••• {info.card.last4}
								</span>
								{subscriptionAttached && (
									<span className="badge badge-primary badge-sm">Used for your subscription</span>
								)}
								{info.card.funding !== "credit" && (
									<span className="text-xs text-base-content/50">
										Debit — works for purchases, not Adult content.
									</span>
								)}
							</div>
						)}
						{info?.address && (
							<p className="text-sm" data-testid="payment-info-address">
								{displayAddress(info.address)}
							</p>
						)}
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => void startCard()}
								disabled={busy}
								data-testid="payment-info-card-button"
							>
								{hasCard ? "Replace card" : "Add a card"}
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={startAddress}
								disabled={busy}
								data-testid="payment-info-address-button"
							>
								Edit address
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm text-error"
								onClick={() => void remove()}
								disabled={busy || subscriptionAttached}
								title={
									subscriptionAttached
										? "Your subscription renews on this card. Replace it, or cancel the subscription first."
										: undefined
								}
								data-testid="payment-info-remove"
							>
								Remove
							</button>
						</div>
					</div>
				) : (
					<button
						type="button"
						className="btn btn-sm w-fit"
						onClick={() => void startCard()}
						disabled={busy}
						data-testid="payment-info-add"
					>
						Add payment info
					</button>
				)}
			</div>
		</div>
	);
}

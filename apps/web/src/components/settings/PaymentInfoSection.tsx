// SPDX-License-Identifier: Apache-2.0
/**
 * The account's saved payment information — the card at Stripe and the US billing address
 * here.
 *
 * ⭐ **The split is deliberate** (Parker, 2026-11-13). Stripe's Billing Portal owns the
 * card: adding, replacing and removing one happen on its payment-method page, reached by
 * the deep link this card opens. Settings owns the billing address, because it is the only
 * surface that can enforce the US-only boundary the purchase surfaces require, and it
 * keeps the read-only summary — the card in use, whether a subscription renews on it, and
 * the Adult-proof note — beside that address.
 *
 * 🚨 **The address is Stripe's, and so is the record.** The saved address is the Customer's
 * `address`/`name`; checkout prefills from it and writes the address it collected back to
 * it (`customer_update.address: "auto"` in `routes/payments.ts`). Nothing here stores an
 * address in Anthers' database.
 *
 * 🚨 **Nothing here charges anything.** The portal's card page is a card-management flow,
 * not a payment; the Adult rung reads the saved card's funding type, and a debit card works
 * for purchases but cannot unlock Adult content.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import type { SavedBillingAddress } from "@anthers/web-shared/types";
import { AddressElement, Elements, useElements } from "@stripe/react-stripe-js";
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
 * address form is remounted from the saved address each time it opens.
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
 * The billing address, shared by the summary and the edit form.
 *
 * This is the advanced Address Element, whose billing mode supports `allowedCountries` —
 * the Checkout-flavored `BillingAddressElement` does not, which is why checkout's address
 * element is this one too. The phone field is hidden because nothing here reads one.
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

/** The address alone; the card is managed at Stripe. */
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
	const [mode, setMode] = useState<"idle" | "address">("idle");
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

	/**
	 * Open the Portal's payment-method page.
	 *
	 * 🚨 **A failure is the server's sentence, not a silent dead end.** The Portal is the
	 * only place a card is added or replaced now, so a 503 or a Stripe refusal has to say
	 * what happened and leave the button retryable.
	 */
	const openCardPortal = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/subscriptions/payment-method-portal", { method: "POST" });
			const body = (await res.json().catch(() => null)) as {
				portalUrl?: string;
				error?: string;
			} | null;
			if (!res.ok || !body?.portalUrl) {
				throw new Error(body?.error ?? "We couldn't open the card page. Please try again.");
			}
			window.location.assign(body.portalUrl);
		} catch (err) {
			setError(err instanceof Error ? err.message : "We couldn't open the card page.");
			setBusy(false);
		}
	};

	const startAddress = () => {
		setError(null);
		setSavedJustNow(false);
		setMode("address");
	};

	if (!loaded) {
		return (
			<div className="card bg-base-200 mb-6" data-testid="payment-info-section">
				<div className="card-body gap-3" aria-busy="true">
					<div className="skeleton h-6 w-44" />
					<div className="skeleton h-4 w-full" />
					<div className="skeleton h-10 w-56" />
				</div>
			</div>
		);
	}

	const onAddressSaved = (address: SavedBillingAddress) => {
		setInfo((current) =>
			current ? { ...current, address } : { address, card: null, subscriptionAttached: false },
		);
		setMode("idle");
		setSavedJustNow(true);
		announcePaymentInfoChanged();
	};

	const hasCard = Boolean(info?.card);
	const hasAddress = Boolean(info?.address);
	const subscriptionAttached = info?.subscriptionAttached === true;

	return (
		<div className="card bg-base-200 mb-6" data-testid="payment-info-section">
			<div className="card-body gap-3">
				<h3 className="card-title text-lg">Save payment info</h3>
				<p className="text-sm text-base-content/60">
					Your saved card and billing address, stored at Stripe. Checkout uses them, and nothing
					here charges anything.
				</p>
				{savedJustNow && (
					<p className="text-success text-sm" data-testid="payment-info-saved">
						Saved — your next checkout will use it.
					</p>
				)}
				{error && <p className="text-error text-sm">{error}</p>}

				{mode === "address" ? (
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
				) : (
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap items-center gap-2 text-sm">
							{hasCard && info?.card ? (
								<>
									<span className="font-medium capitalize">
										{info.card.brand} •••• {info.card.last4}
									</span>
									{subscriptionAttached && (
										<span className="badge badge-primary badge-sm">Used for your subscription</span>
									)}
									{info.card.funding !== "credit" && (
										<span className="text-xs text-base-content/50">
											Debit card: works for purchases, not Adult content.
										</span>
									)}
								</>
							) : (
								<span className="text-base-content/60">No card saved.</span>
							)}
						</div>
						{info?.address ? (
							<p className="text-sm" data-testid="payment-info-address">
								{displayAddress(info.address)}
							</p>
						) : (
							<p className="text-sm text-base-content/60">No billing address saved.</p>
						)}
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => void openCardPortal()}
								disabled={busy}
								data-testid="payment-info-card-button"
							>
								{busy ? "Opening…" : hasCard ? "Manage card at Stripe" : "Add a card at Stripe"}
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={startAddress}
								disabled={busy}
								data-testid="payment-info-address-button"
							>
								{hasAddress ? "Edit address" : "Add billing address"}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

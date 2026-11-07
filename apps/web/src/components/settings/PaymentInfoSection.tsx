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
 * 🚨 **The card is saved with a SetupIntent, so nothing is charged.** The same check the
 * Adult rung reads is the card's funding type; the address is stored on the Customer for
 * checkout prefill and tax. Replacing the card moves the subscription to the new one before
 * the old card is detached.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import type { SavedBillingAddress } from "@anthers/web-shared/types";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useCallback, useEffect, useState } from "react";
import { getStripe } from "../../lib/stripe";
import { cardElementStyle } from "../../lib/stripeCard";
import UsBillingAddressForm, {
	EMPTY_ADDRESS,
	formatAddress,
	isAddressComplete,
	type UsAddressInput,
} from "../payments/UsBillingAddressForm";

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

function addressDraft(address: SavedBillingAddress | null): UsAddressInput {
	return address
		? {
				name: address.name,
				line1: address.line1,
				line2: address.line2 ?? "",
				city: address.city,
				state: address.state,
				postalCode: address.postalCode,
			}
		: EMPTY_ADDRESS;
}

/** Tell the Adult control on the Content tab that the proof it reads has changed. */
function announcePaymentInfoChanged() {
	window.dispatchEvent(new Event("anthers:payment-info-changed"));
}

/**
 * The card + address form, inside the SetupIntent's `Elements`.
 *
 * The address is saved on the Customer first; the card confirmation carries the same
 * billing details, and the finalize call makes the card the default, moves a subscription
 * onto it, and drops the old cards.
 */
function CardSetupForm({
	clientSecret,
	draft,
	onDraft,
	onSaved,
	onCancel,
}: {
	clientSecret: string;
	draft: UsAddressInput;
	onDraft: (next: UsAddressInput) => void;
	onSaved: (info: PaymentInfo) => void;
	onCancel: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		if (!stripe || !elements || !isAddressComplete(draft) || busy) return;
		const card = elements.getElement(CardElement);
		if (!card) {
			setError("The card field isn't ready. Please try again.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const addressRes = await apiFetch("/api/accounts/me/billing-address", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: draft.name.trim(),
					line1: draft.line1.trim(),
					line2: draft.line2.trim() ? draft.line2.trim() : null,
					city: draft.city.trim(),
					state: draft.state,
					postalCode: draft.postalCode.trim(),
				}),
			});
			if (!addressRes.ok) {
				const body = (await addressRes.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "That address didn't work. Please check it and retry.");
			}

			const { error: stripeError, setupIntent } = await stripe.confirmCardSetup(clientSecret, {
				payment_method: {
					card,
					billing_details: {
						name: draft.name.trim(),
						address: {
							line1: draft.line1.trim(),
							...(draft.line2.trim() ? { line2: draft.line2.trim() } : {}),
							city: draft.city.trim(),
							state: draft.state,
							postal_code: draft.postalCode.trim(),
							country: "US",
						},
					},
				},
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
			<UsBillingAddressForm value={draft} onChange={onDraft} />
			<div className="rounded-box border border-base-300 bg-base-100 px-3 py-2">
				<CardElement options={{ style: cardElementStyle() }} />
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
					disabled={busy || !stripe || !isAddressComplete(draft)}
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
	draft,
	onDraft,
	onSaved,
	onCancel,
}: {
	draft: UsAddressInput;
	onDraft: (next: UsAddressInput) => void;
	onSaved: (address: SavedBillingAddress) => void;
	onCancel: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		if (!isAddressComplete(draft) || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/billing-address", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: draft.name.trim(),
					line1: draft.line1.trim(),
					line2: draft.line2.trim() ? draft.line2.trim() : null,
					city: draft.city.trim(),
					state: draft.state,
					postalCode: draft.postalCode.trim(),
				}),
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
			<UsBillingAddressForm value={draft} onChange={onDraft} />
			{error && <p className="text-sm text-error">{error}</p>}
			<div className="flex gap-2">
				<button
					type="button"
					className="btn btn-primary btn-sm"
					disabled={busy || !isAddressComplete(draft)}
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
	const [draft, setDraft] = useState<UsAddressInput>(EMPTY_ADDRESS);
	const [setupSecret, setSetupSecret] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedJustNow, setSavedJustNow] = useState(false);

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
		setDraft(addressDraft(info?.address ?? null));
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
		setDraft(addressDraft(info?.address ?? null));
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
					payment records rather than on Anthers' servers, and checkout only ever reads them.
				</p>
				{savedJustNow && (
					<p className="text-success text-sm" data-testid="payment-info-saved">
						Saved — your next checkout will use it.
					</p>
				)}
				{error && <p className="text-error text-sm">{error}</p>}

				{mode === "card" && setupSecret ? (
					<Elements stripe={getStripe()} options={{ clientSecret: setupSecret }}>
						<CardSetupForm
							clientSecret={setupSecret}
							draft={draft}
							onDraft={setDraft}
							onSaved={onCardSaved}
							onCancel={() => {
								setMode("idle");
								setSetupSecret(null);
								setError(null);
							}}
						/>
					</Elements>
				) : mode === "address" ? (
					<AddressForm
						draft={draft}
						onDraft={setDraft}
						onSaved={onAddressSaved}
						onCancel={() => {
							setMode("idle");
							setError(null);
						}}
					/>
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
							<p className="whitespace-pre-line text-sm" data-testid="payment-info-address">
								{formatAddress(addressDraft(info.address))}
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

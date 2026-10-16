// SPDX-License-Identifier: Apache-2.0
/**
 * The **saved billing address** — the one opt-in address Anthers offers, per the
 * 2026-10-11 decision. This settings section is the ONLY surface that saves, edits or
 * clears it: checkout prefills from what is saved here and never offers to save, a buyer
 * who wants the convenience decides here, and clearing erases the address from Stripe
 * immediately. The address itself is stored on the buyer's Stripe Customer record and
 * never in Anthers' database; this section is also the honest place to say so.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import type { SavedBillingAddress } from "@anthers/web-shared/types";
import { useEffect, useState } from "react";
import UsBillingAddressForm, {
	EMPTY_ADDRESS,
	formatAddress,
	isAddressComplete,
	type UsAddressInput,
} from "../payments/UsBillingAddressForm";

export default function BillingAddressSection() {
	const [saved, setSaved] = useState<SavedBillingAddress | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<UsAddressInput>(EMPTY_ADDRESS);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedJustNow, setSavedJustNow] = useState(false);

	// 🚨 Rendered only once the read has answered. A settings card that renders empty then
	// fills in reads as "the saved address was lost"; the loading silence is quieter.
	useEffect(() => {
		let canceled = false;
		apiFetch("/api/accounts/me/billing-address")
			.then(async (res) => {
				if (canceled) return;
				if (res.ok) {
					const data = (await res.json()) as { address: SavedBillingAddress | null };
					setSaved(data.address);
				}
				setLoaded(true);
			})
			.catch(() => {
				if (!canceled) setLoaded(true);
			});
		return () => {
			canceled = true;
		};
	}, []);

	if (!loaded) return null;

	async function save() {
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
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? "That address didn't work. Please check it and retry.");
			}
			setSaved(((await res.json()) as { address: SavedBillingAddress }).address ?? null);
			setEditing(false);
			setSavedJustNow(true);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "That address didn't work. Please check it and retry.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function clear() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/billing-address", { method: "DELETE" });
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? "We couldn't clear your saved address. Please try again.");
			}
			setSaved(null);
			setSavedJustNow(false);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "We couldn't clear your saved address. Please try again.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="card bg-base-200 mb-6" data-testid="billing-address-section">
			<div className="card-body">
				<h3 className="card-title text-lg">Billing Address</h3>
				<p className="text-sm text-base-content/60">
					Save an address and future checkouts fill it in for you. It is stored at Stripe, with your
					payment records rather than on Anthers' servers, and checkout only ever reads it.
				</p>
				{savedJustNow && !editing && saved && (
					<p className="text-success text-sm" data-testid="billing-address-saved">
						Saved — your next checkout will use this address.
					</p>
				)}
				{!saved && !editing && (
					<button
						type="button"
						className="btn btn-sm w-fit"
						onClick={() => {
							setDraft(EMPTY_ADDRESS);
							setSavedJustNow(false);
							setEditing(true);
						}}
						data-testid="billing-address-add"
					>
						Save a billing address
					</button>
				)}
				{saved && !editing && (
					<>
						<p className="text-sm" data-testid="billing-address-current">
							{formatAddress({
								name: saved.name,
								line1: saved.line1,
								line2: saved.line2 ?? "",
								city: saved.city,
								state: saved.state,
								postalCode: saved.postalCode,
							})}
						</p>
						<div className="flex gap-2">
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => {
									setDraft({
										name: saved.name,
										line1: saved.line1,
										line2: saved.line2 ?? "",
										city: saved.city,
										state: saved.state,
										postalCode: saved.postalCode,
									});
									setSavedJustNow(false);
									setEditing(true);
								}}
								data-testid="billing-address-edit"
							>
								Edit
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm text-error"
								onClick={clear}
								disabled={busy}
								data-testid="billing-address-clear"
							>
								Clear saved address
							</button>
						</div>
					</>
				)}
				{editing && (
					<>
						<div data-testid="billing-address-edit-form">
							<UsBillingAddressForm value={draft} onChange={setDraft} />
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={save}
								disabled={!isAddressComplete(draft) || busy}
								data-testid="billing-address-save"
							>
								{busy ? "Saving…" : "Save address"}
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									setEditing(false);
									setError(null);
								}}
							>
								Cancel
							</button>
						</div>
					</>
				)}
				{error && (
					<p className="text-error text-sm" data-testid="billing-address-error">
						{error}
					</p>
				)}
			</div>
		</div>
	);
}

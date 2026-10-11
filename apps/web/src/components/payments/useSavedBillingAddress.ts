// SPDX-License-Identifier: Apache-2.0
/**
 * The buyer's saved billing address, fetched once on mount — what a purchase surface
 * prefills its address form from.
 *
 * 🚨 **Undefined means still loading; null means loaded, and nothing is saved.** The
 * distinction is the prefill's guard against two failures at once: a surface must not
 * hydrate a form from nothing (and so must not treat "still fetching" as "nothing
 * saved", which would let a hydrate effect fire on a null that was only ever a loader),
 * and it must not keep fetching or re-hydrate over a buyer who has already started
 * typing. The API is the same GET settings reads (`/api/accounts/me/billing-address`);
 * a refusal is swallowed on purpose — prefill is a convenience, and a failed read must
 * never block a purchase.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import type { SavedBillingAddress } from "@anthers/web-shared/types";
import { useEffect, useState } from "react";
import type { UsAddressInput } from "./UsBillingAddressForm";

/** The saved address a checkout prefills from, as form state — or undefined while loading. */
export type SavedPrefill = UsAddressInput | null | undefined;

/** The exact same address, as the Checkout session's billing form takes it. */
export function savedPrefillFrom(saved: SavedBillingAddress): UsAddressInput {
	return {
		name: saved.name,
		line1: saved.line1,
		line2: saved.line2 ?? "",
		city: saved.city,
		state: saved.state,
		postalCode: saved.postalCode,
	};
}

export function useSavedBillingAddress(): SavedPrefill {
	const [saved, setSaved] = useState<SavedPrefill>(undefined);
	useEffect(() => {
		let cancelled = false;
		apiFetch("/api/accounts/me/billing-address")
			.then(async (res) => {
				if (cancelled) return;
				if (!res.ok) {
					setSaved(null);
					return;
				}
				const data = (await res.json()) as { address: SavedBillingAddress | null };
				setSaved(data.address ? savedPrefillFrom(data.address) : null);
			})
			.catch(() => {
				if (!cancelled) setSaved(null);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return saved;
}

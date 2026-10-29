// SPDX-License-Identifier: Apache-2.0
/**
 * One physical good's listing row, and the two surfaces that edit it.
 *
 * ⭐ **The Manage tab keeps the parcel facts and the media area keeps the storefront's**
 * (Parker, 2026-10-29): shipping, handling and tax stay in Selling, while the variants and
 * the pictures live in Goods Management beside the panel they configure. Both surfaces read
 * the same row, so the save here re-reads it immediately before writing and applies only its
 * caller's slice. A component holding a copy from before the other surface saved would
 * otherwise undo that save, because the route replaces the whole listing.
 */

import type { PhysicalTaxCategory } from "@anthers/shared/tax-codes";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** One value a buyer can pick under a variant. */
export interface ListingValue {
	label: string;
	/** How many are left, or null for as many as the creator can make. */
	stock: number | null;
}

/** One choice a buyer makes: its name and the values under it. */
export interface ListingOption {
	name: string;
	values: ListingValue[];
}

/** One picture of the good, in the order the storefront shows them. */
export interface PhysicalImage {
	key: string;
	alt: string;
	/** Exactly one picture is the cover; the storefront shows it first. */
	cover: boolean;
	/**
	 * The address storage mints for this picture, from the listing read.
	 *
	 * Never rebuilt from the key here: a key alone only names a file inside whichever storage
	 * backend the deployment runs, and a browser that guessed `/content/<key>` would get the
	 * web app's own shell back on a deployed host rather than the picture.
	 */
	url: string | null;
}

export interface Listing {
	shippingPrice: string;
	handlingBusinessDays: number;
	minQuantity: number;
	maxQuantity: number;
	taxCategory: PhysicalTaxCategory;
	options: ListingOption[];
	images: PhysicalImage[];
}

/** Reads the good's one listing row, and writes a slice of it over the row as it stands. */
export function useListing(workId: number, enabled = true) {
	const [listing, setListing] = useState<Listing | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) return;
		let stale = false;
		void (async () => {
			const res = await client.api.content.works[":id"].physical.$get({
				param: { id: String(workId) },
			});
			if (stale) return;
			if (!res.ok) {
				setLoadError("Couldn't read this good's selling details.");
				return;
			}
			const body = (await res.json()) as { listing: Listing };
			setListing(body.listing);
		})();
		return () => {
			stale = true;
		};
	}, [workId, enabled]);

	/**
	 * Save the caller's slice over a fresh read of the row.
	 *
	 * The server validates; a refusal's message reads in the field, in its own words
	 * rather than a generic one.
	 */
	const save = async (patch: Partial<Listing>): Promise<void> => {
		if (!enabled) throw new Error("This listing is not yours to edit.");
		const read = await client.api.content.works[":id"].physical.$get({
			param: { id: String(workId) },
		});
		if (!read.ok) throw new Error("Couldn't read this good's selling details.");
		const { listing: current } = (await read.json()) as { listing: Listing };

		const next = { ...current, ...patch };
		const res = await client.api.content.works[":id"].physical.$put({
			param: { id: String(workId) },
			json: {
				shippingPrice: next.shippingPrice,
				handlingBusinessDays: next.handlingBusinessDays,
				minQuantity: next.minQuantity,
				maxQuantity: next.maxQuantity,
				taxCategory: next.taxCategory,
				options: next.options,
				// The address is the read's, not the row's; a save names only what it stores.
				images: next.images.map(({ key, alt, cover }) => ({ key, alt, cover })),
			},
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? "That listing didn't save.");
		}
		const body = (await res.json()) as { listing: Listing };
		setListing(body.listing);
	};

	return { listing, loadError, save };
}

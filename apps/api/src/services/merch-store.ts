// SPDX-License-Identifier: Apache-2.0
/**
 * The store facts a listing shows of a goods Work — the artwork and the ask.
 *
 * 🚨 **Why these facts belong in a listing at all:** the goods-works rule (`services/access.ts`,
 * Parker 2026-10-09) keeps a buyable physical Work off the locked presentation — the purchase
 * gates RECEIVING the shirt, never SEEING it, so a card's gate chip never stands in for a store.
 * What the card shows instead is the store's own face: the first color's mockup (the same
 * hot-linked Printful image the store panel opens with) and the cheapest variant's stamped
 * list price, rendered "from".
 *
 * Both facts are public by the store's own rules — the variants route
 * (`/merch/:slug/variants`) shows them to a signed-out visitor — so a listing carrying them
 * leaks nothing. They are per-Work batch facts by construction (one query, ids in the `where`),
 * mirroring `loadWorkBundles`'s shape, because almost every caller serializes a batch and a
 * per-Work lookup would be an N+1 on every Catalog page.
 *
 * ⚠️ **A Work with no merch variants is not a defect.** A physical Work whose store is not
 * set up (or not yet priced) stamps no facts and the card says nothing about a buy — a null
 * fact is the store's absence, never an error to paper over.
 */
import { db } from "@anthers/db/client";
import { merchVariants } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { inArray } from "drizzle-orm";

export interface MerchStoreFacts {
	/** The first color's mockup, in variant-id order; null when none stamps one. */
	mockupUrl: string | null;
	/** The cheapest variant's stamped list price, raw ("12.00"); null with no variants. */
	fromPrice: string | null;
}

/**
 * The store facts for a batch of goods Work ids. Pass only works of a goods kind
 * (physical today — the one with a live store); the query is scoped to what arrives.
 */
export async function merchStoreFactsByWork(
	workIds: number[],
): Promise<Map<number, MerchStoreFacts>> {
	const out = new Map<number, MerchStoreFacts>();
	if (workIds.length === 0) return out;

	// In variant-id order on purpose: that is the setup script's own order, which is
	// the picker's color-group ordering — "first color" means first in the dashboard's
	// own list, the same mockup the store panel opens on.
	const rows = await db
		.select({
			workId: merchVariants.workId,
			mockupUrl: merchVariants.mockupUrl,
			listPrice: merchVariants.listPrice,
		})
		.from(merchVariants)
		.where(inArray(merchVariants.workId, workIds))
		.orderBy(merchVariants.id);

	for (const v of rows) {
		let entry = out.get(v.workId);
		if (!entry) {
			entry = { mockupUrl: null, fromPrice: null };
			out.set(v.workId, entry);
		}
		if (!entry.mockupUrl && v.mockupUrl) entry.mockupUrl = v.mockupUrl;
		// numeric reads back as string; the minimum is decimal, never float
		if (entry.fromPrice === null || new Decimal(v.listPrice).lt(new Decimal(entry.fromPrice))) {
			entry.fromPrice = v.listPrice;
		}
	}
	return out;
}

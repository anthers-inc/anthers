// SPDX-License-Identifier: Apache-2.0
/**
 * Physical sales — what a good costs, what its shipping costs, and what a pick resolves to
 * before any session exists.
 *
 * The store panel, the quote route and the checkout all price the same pick, so the
 * arithmetic lives here and nowhere else: one derived figure shown three ways that
 * disagrees with itself is how a store loses a buyer's trust.
 *
 * 🚨 **The price is the Work's own baseline offer, never the listing's.** A physical Work is
 * priced by the same access row every Work is priced by — the row with no badge threshold,
 * the "Everyone" door — so the existing price editor edits it and no second pricing
 * mechanism exists. A badge-gated row on a good gates the *page*; it never prices the
 * goods, because a supporter's rung is a way in rather than a discount on a parcel.
 *
 * ⚠️ **Shipping is flat, per order, and the creator's to set.** There is no rate source any
 * more: a creator charges what a parcel costs them, and two of one good still go in one
 * box. A basket carrying goods from several creators charges each creator's shipping once
 * — the most expensive of their lines, so nobody is underpaid for a parcel and nobody is
 * charged twice for one.
 */
import { db } from "@anthers/db/client";
import { type PhysicalOption, physicalListings, works } from "@anthers/db/schema";
import {
	isPhysicalTaxCategory,
	PHYSICAL_TAX_CATEGORIES,
	type PhysicalTaxCategory,
	SHIPPING_TAX_CODE,
} from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { createTaxCalculation } from "../lib/processor.js";
import type { SavedBillingAddress } from "./billing.js";
import { type PhysicalPick, validatePhysicalPick } from "./physical-stock.js";
import { clampHandlingDays } from "./shipments.js";

/** The listing as a buyer sees it: what is offered, what shipping costs, how long it takes. */
export interface BuyerListing {
	shippingPrice: string;
	handlingBusinessDays: number;
	taxCategory: PhysicalTaxCategory;
	options: Array<{ name: string; values: Array<{ label: string; stock: number | null }> }>;
}

/** The defaults a good carries before its creator has answered anything. */
const DEFAULT_LISTING: BuyerListing = {
	shippingPrice: "0.00",
	handlingBusinessDays: 3,
	taxCategory: "general",
	options: [],
};

/** The listing a buyer reads. Public by design — it is the panel they are choosing from. */
export async function buyerListingFor(workId: number): Promise<BuyerListing> {
	const [row] = await db
		.select()
		.from(physicalListings)
		.where(eq(physicalListings.workId, workId))
		.limit(1);
	if (!row) return { ...DEFAULT_LISTING, options: [] };
	const options: PhysicalOption[] = row.options ?? [];
	return {
		shippingPrice: row.shippingPrice,
		handlingBusinessDays: row.handlingBusinessDays,
		taxCategory: isPhysicalTaxCategory(row.taxCategory) ? row.taxCategory : "general",
		options: options.map((option) => ({
			name: option.name,
			values: option.values.map((value) => ({ label: value.label, stock: value.stock })),
		})),
	};
}

export type PhysicalSaleRefusal =
	| { ok: false; status: 400 | 404 | 409; error: string }
	| {
			ok: false;
			status: 400;
			error: string;
			/** The service's own problem list, so a surface can name every field at once. */
			problems: Array<{ field: string; message: string }>;
	  };

export type PhysicalSale =
	| {
			ok: true;
			work: typeof works.$inferSelect;
			listing: BuyerListing;
			picks: PhysicalPick[];
			quantity: number;
			/** What one of the good costs — the Work's baseline offer, as it was priced. */
			unitPrice: Decimal;
			/** Goods only, already multiplied out. */
			goodsPrice: Decimal;
			/** The listing's flat shipping, charged once for the order. */
			shippingPrice: Decimal;
			taxCategory: PhysicalTaxCategory;
			handlingBusinessDays: number;
	  }
	| PhysicalSaleRefusal;

/**
 * The price a physical good sells for: its baseline (no-threshold) allowed offer.
 *
 * Returns null when the good has no such row — which is the same shape as a gated Work,
 * where the gate is the whole story and there is nothing to sell to this viewer.
 */
function baselinePrice(access: unknown): Decimal | null {
	if (!Array.isArray(access)) return null;
	for (const row of access as Array<{ allow?: unknown; threshold?: unknown; price?: unknown }>) {
		if (!row?.allow) continue;
		if (Number(row.threshold ?? 0) > 0) continue;
		const price = new Decimal(String(row.price ?? "0"));
		if (price.isFinite()) return price;
	}
	return null;
}

/**
 * Resolve a buyer's pick on a physical Work into money, or refuse it in words.
 *
 * The work is looked up by slug because every buy surface addresses a Work that way, and
 * the resolved row is returned with the sale so a caller never re-reads it.
 */
export async function resolvePhysicalSale(
	slug: string,
	userId: number | null,
	pick: { quantity?: unknown; options?: unknown },
): Promise<PhysicalSale> {
	const [work] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
	if (work?.type !== "physical") return { ok: false, status: 404, error: "Work not found" };
	if (work.visibility !== "released" && work.creatorId !== userId)
		return { ok: false, status: 404, error: "Work not found" };
	if (work.creatorId == null)
		return { ok: false, status: 409, error: "This work is no longer for sale." };

	const unitPrice = baselinePrice(work.access);
	if (!unitPrice || unitPrice.lte(0)) {
		return {
			ok: false,
			status: 400,
			error: "This good isn't priced for sale yet.",
		};
	}

	const listing = await buyerListingFor(work.id);
	const checked = validatePhysicalPick(listing, pick);
	if (!checked.ok) {
		return {
			ok: false,
			status: 400,
			error: checked.problems[0]?.message ?? "That choice isn't available.",
			problems: checked.problems,
		};
	}

	return {
		ok: true,
		work,
		listing,
		picks: checked.picks,
		quantity: checked.quantity,
		unitPrice,
		goodsPrice: unitPrice.times(checked.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
		shippingPrice: new Decimal(listing.shippingPrice),
		taxCategory: listing.taxCategory,
		handlingBusinessDays: clampHandlingDays(listing.handlingBusinessDays),
	};
}

/**
 * The buyer's live tax figure for a physical pick, against their saved billing address.
 *
 * ⚠️ **An estimate, never the charge.** The session resolves tax from the address the
 * buyer actually ships to; this stands in with billing as what "same as billing" delivers
 * to. A provider failure degrades to a null figure, which the panel shows as "calculated
 * at checkout" — the honest shape of a tax no address exists to resolve.
 */
export async function quotePhysicalTax(
	saved: SavedBillingAddress | null,
	lines: { goodsPrice: Decimal; shippingPrice: Decimal; taxCategory: PhysicalTaxCategory },
): Promise<{
	tax: string | null;
	quotedTo: { city: string; state: string; postalCode: string } | null;
}> {
	if (!saved) return { tax: null, quotedTo: null };
	const quotedTo = { city: saved.city, state: saved.state, postalCode: saved.postalCode };
	try {
		const calc = await createTaxCalculation({
			currency: "usd",
			line_items: [
				{
					amount: Math.round(lines.goodsPrice.toNumber() * 100),
					reference: "goods",
					tax_behavior: "exclusive",
					tax_code: taxCodeFor(lines.taxCategory),
				},
			],
			shipping_cost: lines.shippingPrice.gt(0)
				? {
						amount: Math.round(lines.shippingPrice.toNumber() * 100),
						tax_behavior: "exclusive",
						tax_code: SHIPPING_TAX_CODE,
					}
				: undefined,
			customer_details: {
				address: {
					line1: saved.line1,
					...(saved.line2 ? { line2: saved.line2 } : {}),
					city: saved.city,
					state: saved.state,
					postal_code: saved.postalCode,
					country: "US",
				},
				address_source: "shipping",
			},
		});
		if (calc?.tax_amount_exclusive == null) return { tax: null, quotedTo };
		return {
			tax: new Decimal(calc.tax_amount_exclusive).dividedBy(100).toFixed(2),
			quotedTo,
		};
	} catch {
		return { tax: null, quotedTo };
	}
}

/** The Stripe tax code a listing's category carries — from the shared table, never retyped. */
function taxCodeFor(category: PhysicalTaxCategory): string {
	return PHYSICAL_TAX_CATEGORIES[category].code;
}

/**
 * What a storefront needs to render a good before any pick exists: the listing, the price,
 * and enough of the Work to name it.
 *
 * Signed-out visitors get this too — the goods rule is that the page and its store panel
 * read without an account, and creating one is required only to buy.
 */
export async function physicalStorefront(slug: string): Promise<
	| { ok: false; status: 404 | 400; error: string }
	| {
			ok: true;
			work: { id: number; title: string | null; slug: string | null; creatorHandle: string | null };
			unitPrice: Decimal;
			listing: BuyerListing;
	  }
> {
	const [row] = await db
		.select({
			id: works.id,
			title: works.title,
			slug: works.slug,
			type: works.type,
			access: works.access,
			visibility: works.visibility,
		})
		.from(works)
		.where(eq(works.slug, slug))
		.limit(1);
	if (row?.type !== "physical" || row.visibility !== "released")
		return { ok: false, status: 404, error: "Work not found" };
	const unitPrice = baselinePrice(row.access);
	if (!unitPrice || unitPrice.lte(0))
		return { ok: false, status: 400, error: "This good isn't priced for sale yet." };
	return {
		ok: true,
		work: { id: row.id, title: row.title, slug: row.slug, creatorHandle: null },
		unitPrice,
		listing: await buyerListingFor(row.id),
	};
}

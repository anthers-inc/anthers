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
import { type PhysicalOption, workPhysicalListings, works } from "@anthers/db/schema";
import { MAX_GOODS_PER_ORDER } from "@anthers/shared/constants";
import {
	isPhysicalTaxCategory,
	PHYSICAL_TAX_CATEGORIES,
	type PhysicalTaxCategory,
	SHIPPING_TAX_CODE,
} from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { createTaxCalculation } from "../lib/processor.js";
import { purchasePriceFor } from "./access.js";
import type { SavedBillingAddress } from "./billing.js";
import { type PhysicalPick, validatePhysicalPick } from "./physical-stock.js";
import { clampHandlingDays } from "./shipments.js";
import { resolveThumbnailUrl } from "./thumbnails.js";

/** The listing as a buyer sees it: what is offered, what shipping costs, how long it takes. */
export interface BuyerListing {
	shippingPrice: string;
	handlingBusinessDays: number;
	minQuantity: number;
	maxQuantity: number;
	taxCategory: PhysicalTaxCategory;
	options: Array<{ name: string; values: Array<{ label: string; stock: number | null }> }>;
	/** The storefront's pictures, resolved to display URLs in the creator's order. */
	images: Array<{ url: string; alt: string }>;
}

/** The defaults a good carries before its creator has answered anything. */
const DEFAULT_LISTING: BuyerListing = {
	shippingPrice: "0.00",
	handlingBusinessDays: 3,
	minQuantity: 1,
	maxQuantity: MAX_GOODS_PER_ORDER,
	taxCategory: "general",
	options: [],
	images: [],
};

/** The listing a buyer reads. Public by design — it is the panel they are choosing from. */
export async function buyerListingFor(workId: number): Promise<BuyerListing> {
	const [row] = await db
		.select()
		.from(workPhysicalListings)
		.where(eq(workPhysicalListings.workId, workId))
		.limit(1);
	if (!row) return { ...DEFAULT_LISTING, options: [], images: [] };
	const options: PhysicalOption[] = row.options ?? [];
	const resolved = await Promise.all(
		(row.images ?? []).map(async (image) => {
			const url = await resolveThumbnailUrl(image.key);
			return url ? { url, alt: image.alt, cover: image.cover } : null;
		}),
	);
	const images = resolved
		.filter((image): image is { url: string; alt: string; cover: boolean } => image !== null)
		.sort((a, b) => Number(b.cover) - Number(a.cover))
		.map(({ url, alt }) => ({ url, alt }));
	return {
		shippingPrice: row.shippingPrice,
		handlingBusinessDays: row.handlingBusinessDays,
		minQuantity: row.minQuantity,
		maxQuantity: row.maxQuantity,
		taxCategory: isPhysicalTaxCategory(row.taxCategory) ? row.taxCategory : "general",
		options: options.map((option) => ({
			name: option.name,
			values: option.values.map((value) => ({ label: value.label, stock: value.stock })),
		})),
		images,
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

	// 🚨 **The price is the Access table's, read through the resolver every other Work
	// uses** — the cheapest row this buyer qualifies for, which is what the Access modal
	// promises and what a supporter price on a good means. Reading the Everyone row
	// directly here is how a Blossom supporter was charged the full price on 2026-10-26.
	const priced = await purchasePriceFor(work, userId);
	const unitPrice = priced ? new Decimal(priced) : null;
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
 *
 * ⭐ **The creator's own draft reads here too** (Parker, 2026-10-29): the media area is where
 * a good is set up, and a draft that answered "Work not found" in its own store panel was
 * hiding the surface the creator was editing. Ownership is the same test the quote route
 * already uses; a stranger still gets the 404.
 */
export async function physicalStorefront(
	slug: string,
	/** The viewer, when there is one: a supporter reads their own rung's price here. */
	userId: number | null = null,
): Promise<
	| { ok: false; status: 404 | 400; error: string }
	| {
			ok: true;
			work: { id: number; title: string | null; slug: string | null; creatorHandle: string | null };
			unitPrice: Decimal;
			/** Whether the Work carries a sellable price; a creator's own unpriced draft still reads. */
			priced: boolean;
			listing: BuyerListing;
	  }
> {
	const [row] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
	if (row?.type !== "physical" || (row.visibility !== "released" && row.creatorId !== userId))
		return { ok: false, status: 404, error: "Work not found" };
	// The same resolver every Work uses, at the viewer's own standing: a signed-out visitor
	// qualifies for the Everyone row and a supporter for whichever rung they hold, so the
	// headline and the quote cannot disagree about what this person pays.
	const priced = await purchasePriceFor(row, userId);
	const unitPrice = priced ? new Decimal(priced) : null;
	const owner = row.creatorId === userId;
	// The creator's own unpriced draft still renders: the storefront is the surface they
	// are setting up, and a 400 there hid the pictures and variants behind the price.
	if ((!unitPrice || unitPrice.lte(0)) && !owner)
		return { ok: false, status: 400, error: "This good isn't priced for sale yet." };
	return {
		ok: true,
		work: { id: row.id, title: row.title, slug: row.slug, creatorHandle: null },
		unitPrice: unitPrice ?? new Decimal(0),
		priced: Boolean(unitPrice?.gt(0)),
		listing: await buyerListingFor(row.id),
	};
}

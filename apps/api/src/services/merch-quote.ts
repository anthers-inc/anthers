// SPDX-License-Identifier: Apache-2.0
/**
 * The merch quote — the money lines a merch pick resolves to, and the one place those
 * lines are derived.
 *
 * 🚨 **A merch pick is priced in three places, and this module is their shared
 * arithmetic**: the picker (`GET /merch/:slug/variants`), the store panel's live quote
 * (`GET /merch/quote/:slug`, one pick against the buyer's saved billing zip) and the
 * charge itself (`POST /merch/checkout/:slug`). Each route keeps its own refusal
 * sentences and its own response shape — what they share is the variant resolution, the
 * Badge discount, the goods figure, and the Printful shipping rate. One derived price
 * shown three ways that disagrees with itself is exactly how a store loses a buyer's
 * trust, so the arithmetic lives here and nowhere else.
 *
 * The shipping rate carries the store's standing shipping choice — **the co2 offset,
 * always** (Parker, 2026-10-09) — picked by id with a fallback to the first rate, so a
 * rate-list change degrades to plain shipping rather than failing the store. Rates are
 * quoted live per call and never cached (Printful's own warning about a mismatched
 * displayed vs charged rate is read as binding).
 */
import { db } from "@anthers/db/client";
import { merchVariants } from "@anthers/db/schema";
import {
	type Badge,
	CLOTHING_TAX_CODE,
	heldBadgeName,
	MERCH_BADGE_DISCOUNT,
	MERCH_BADGE_DISCOUNT_RATE,
} from "@anthers/shared/constants";
import { SHIPPING_TAX_CODE } from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { createTaxCalculation } from "../lib/processor.js";
import { heldAnthersBadgeAmount } from "./anthers-badges.js";
import type { SavedBillingAddress } from "./billing.js";
import { getShippingRates, type PrintfulShippingOption } from "./printful.js";

/** Why a pick failed to price, mapped to each route's own refusal sentence. */
export type MerchQuoteFailureKind = "noPick" | "ambiguousPick" | "unseededLadder" | "noRate";

export class MerchQuoteError extends Error {
	constructor(readonly kind: MerchQuoteFailureKind) {
		super(`merch quote failed: ${kind}`);
	}
}

/** The per-Badge discount a buyer holds, or null holding none. Throws on an unseeded ladder. */
export async function merchBadgeDiscount(userId: number): Promise<{
	badge: Badge;
	percent: string;
	rate: string;
} | null> {
	const badge = heldBadgeName(await heldAnthersBadgeAmount(userId));
	if (badge === "free") return null;
	return { badge, percent: MERCH_BADGE_DISCOUNT[badge], rate: MERCH_BADGE_DISCOUNT_RATE[badge] };
}

/**
 * The discounted goods figure from the stamped list price and the discount's multiplier.
 * Shared with the picker's per-size pricing; the decimal is exact.
 */
export function merchGoodsPrice(listPrice: Decimal, discountRate: string): Decimal {
	return listPrice.minus(listPrice.times(discountRate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * The exactly-one-row pick resolution — the store's only tamper-proofing of a size: the
 * body names color/size labels, and a tampered body buys nothing that does not exist.
 * Two rows matching one (work, color, size) is a data error priced as unavailable.
 */
export async function merchVariantForPick(
	workId: number,
	color: string,
	size: string,
): Promise<typeof merchVariants.$inferSelect | MerchQuoteFailureKind> {
	const matches = await db
		.select()
		.from(merchVariants)
		.where(
			and(
				eq(merchVariants.workId, workId),
				eq(merchVariants.color, color),
				eq(merchVariants.size, size),
			),
		)
		.limit(2);
	if (matches.length === 0) return "noPick";
	if (matches.length > 1) return "ambiguousPick";
	return matches[0];
}

/**
 * The shipping rate a merch sale quotes — Printful's live answer for one catalog variant,
 * one shirt, with the standing offset choice applied.
 *
 * **The state code is the rate call's required input** (see `getShippingRates`: the live
 * API refuses a bare US country with 400 "State code is missing" — found 2026-10-15).
 * The rates are flat per product category — verified live the same day across CO, CA,
 * OR, ID, NY and WA, one identical figure each — so two callers with two kinds of state
 * price the same figure: the store panel's quote uses the buyer's own saved state
 * (exact), and the checkout prices its session rate before the buyer has typed anything
 * from {@link MERCH_REPRESENTATIVE_STATE}.
 */
export const MERCH_REPRESENTATIVE_STATE = "CO";

export async function merchShippingRate(
	catalogVariantId: number,
	stateCode: string = MERCH_REPRESENTATIVE_STATE,
): Promise<PrintfulShippingOption> {
	const rates = await getShippingRates({ country_code: "US", state_code: stateCode }, [
		{ catalogVariantId, quantity: 1 },
	]);
	const rate = rates?.find((r) => r.id === "STANDARD_CARBON_OFFSET") ?? rates?.[0];
	if (!rate) throw new MerchQuoteError("noRate");
	return rate;
}

/** A priced pick — everything a merch surface needs before any session exists. */
export interface MerchPricedPick {
	variant: typeof merchVariants.$inferSelect;
	listPrice: Decimal;
	goodsPrice: Decimal;
	discount: { badge: Badge; percent: string; saved: string } | null;
	rate: PrintfulShippingOption;
	shippingPrice: Decimal;
	/** Discounted goods + Printful's shipping — tax on top at the session. */
	amountBeforeTax: Decimal;
}

/**
 * Price one merch pick — the checkout's own derivation, named so the quote route and the
 * charge call the same arithmetic. Throws `MerchQuoteError` for every priced-failure
 * shape; the routes map the kinds to their own sentences. `stateCode` is the saved
 * billing state for a quote (exact against Printful's flat US rates) and defaults to
 * the representative state for a charge priced before any address exists.
 */
export async function priceMerchPick(
	userId: number,
	workId: number,
	color: string,
	size: string,
	opts?: { stateCode?: string },
): Promise<MerchPricedPick> {
	const variant = await merchVariantForPick(workId, color, size);
	if (typeof variant === "string") throw new MerchQuoteError(variant);

	// The Badge held this cycle resolves via its threshold — the same read the
	// subscription routes take. An unseeded ladder throws inside the service; here it is
	// the store's own unavailability.
	let discount: MerchPricedPick["discount"] = null;
	let discountRate = "0";
	try {
		const held = await merchBadgeDiscount(userId);
		if (held) {
			discountRate = held.rate;
			discount = { badge: held.badge, percent: held.percent, saved: "0.00" };
		}
	} catch {
		throw new MerchQuoteError("unseededLadder");
	}

	// 🚨 The list price is Printful's own retail price, stamped at setup (Parker,
	// 2026-10-08: the store uses what Printful carries — one pricing source, edited on
	// the Printful side and restamped by the setup script's re-run). The Badge discount
	// applies to the goods line alone: shipping is Printful's charge, never discounted.
	const listPrice = new Decimal(variant.listPrice);
	const goodsPrice = merchGoodsPrice(listPrice, discountRate);
	if (discount) discount.saved = listPrice.minus(goodsPrice).toFixed(2);

	const rate = await merchShippingRate(variant.catalogVariantId, opts?.stateCode);
	const shippingPrice = new Decimal(rate.rate);

	return {
		variant,
		listPrice,
		goodsPrice,
		discount,
		rate,
		shippingPrice,
		amountBeforeTax: goodsPrice.plus(shippingPrice),
	};
}

/**
 * The buyer's live tax figure for a merch pick, against their saved billing address as
 * the delivery stand-in — the store panel's zip quote. The address is the one opt-in
 * save (the buyer's Stripe Customer), read by the route through `savedBillingAddress`
 * and passed here — never taken from the client — and a null tax is the failed
 * estimate: the caller then shows "calculated at checkout" and no total, which is the
 * honest shape of a tax no address exists to resolve.
 *
 * 🚨 **The figure is an estimate, not the charge.** The checkout session's tax resolves
 * from the address the buyer actually delivers to (the session's shipping address); this
 * quote stands in with billing as what "same as billing" delivers to. A tax-API failure
 * — Stripe refusing an address, most often — degrades to null rather than blocking a box
 * that is a convenience.
 */
export async function quoteMerchTax(
	saved: SavedBillingAddress,
	lines: { goodsPrice: Decimal; shippingPrice: Decimal },
): Promise<{
	tax: string | null;
	quotedTo: { city: string; state: string; postalCode: string } | null;
	/** True whenever a saved billing address existed — true too when Stripe refused it. */
	addressSaved: boolean;
}> {
	const quotedTo = { city: saved.city, state: saved.state, postalCode: saved.postalCode };
	try {
		// The calculation carries the same lines a merch session builds — goods
		// (`CLOTHING_TAX_CODE`, exclusive, taxed on top) and Printful's shipping
		// (`SHIPPING_TAX_CODE`, the separately-stated delivery line) — at the same
		// address shape, so the estimate reads exactly like the session will when the
		// buyer ships to this address.
		const calc = await createTaxCalculation({
			currency: "usd",
			line_items: [
				{
					amount: Math.round(lines.goodsPrice.toNumber() * 100),
					reference: "goods",
					tax_behavior: "exclusive",
					tax_code: CLOTHING_TAX_CODE,
				},
			],
			shipping_cost: {
				amount: Math.round(lines.shippingPrice.toNumber() * 100),
				tax_behavior: "exclusive",
				tax_code: SHIPPING_TAX_CODE,
			},
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
		// Cents → dollars exactly once, as one decimal string.
		const tax =
			calc?.tax_amount_exclusive == null
				? null
				: new Decimal(calc.tax_amount_exclusive).dividedBy(100).toFixed(2);
		return { tax, quotedTo, addressSaved: true };
	} catch {
		return { tax: null, quotedTo: null, addressSaved: true };
	}
}

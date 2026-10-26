// SPDX-License-Identifier: Apache-2.0
/**
 * The Stripe product tax code each charge line carries, per the tax posture's *What Gets
 * Taxed* table.
 *
 * Taxability follows **what the buyer receives**, and the code is how Stripe Tax knows that:
 * it decides each jurisdiction's rate and whether the line is taxable at all, applying
 * whichever rule is in force on the date of sale. Getting it wrong fails in both directions —
 * under-collected tax is owed from Anthers' own funds, and over-collected tax has to be
 * remitted or refunded.
 *
 * 🚨 **`physical` and `service` Works are refused at checkout rather than given a code**,
 * because nothing has a fulfillment mechanism behind it: `purchaseTaxCode` returns `null`
 * for both, and the generic checkout paths read that as a refusal.
 *
 * `game` and `software` share `txcd_10201000` (downloaded software). The posture table also
 * names `txcd_10202000` for an embedded game, and the Work model does not carry the
 * distinction: a `game` is either downloaded or played in the page with no column that says
 * which, so the code cannot follow it. One code for both is the posture's stated fallback
 * ("use `txcd_10201000` for both unless the code distinguishes them cleanly") and the
 * distinction is noted here so a future column that does carry it lands in one place.
 */

import type { WorkType } from "./content.js";

export type { WorkType };

/**
 * The Stripe product tax code for a Work of `type`, or null when that type is not sold.
 *
 * Pure, so the checkout path, the basket path and the tests all read the one mapping — the
 * posture is a table, and a table that lives in more than one place is two tables the moment
 * one of them changes.
 */
export function purchaseTaxCode(type: WorkType): string | null {
	switch (type) {
		case "video":
			// Video Work — permanent streamed access to audiovisual content.
			return "txcd_10402000";
		case "music":
		case "audio":
			// Music/audio Work — permanent streamed access to audio content.
			return "txcd_10401000";
		case "text":
		case "ebook":
			// Written Work — permanent access to pages of text.
			return "txcd_10302000";
		case "comic":
			// Comic — permanent access to pages of images.
			return "txcd_10503000";
		case "image":
			// Image — permanent access to a single image.
			return "txcd_10501000";
		case "game":
		case "software":
			// Game or software — downloaded builds and embedded play alike (see the header).
			return "txcd_10201000";
		case "physical":
		case "service":
			// Refused on the generic path — the merch path carries its own code constant
			// for physical goods (see the header; the generic checkout cannot fulfill a
			// thing, so it never names a tax code for one).
			return null;
	}
}

/**
 * The tax code a merch (physical) sale's **shipping line** carries: `txcd_92010001`,
 * Shipping — a shipping charge in conjunction with the sale of physical goods. Verified
 * against Stripe's published tax-code table on 2026-10-08. Colorado keeps separately
 * stated shipping untaxed, which is the posture's reason Printful's shipping rides its
 * own line rather than folding into the goods price (the Tax and Compliance Plan).
 */
export const SHIPPING_TAX_CODE = "txcd_92010001";

/**
 * What a creator's physical good is, for tax — the category they choose and the Stripe
 * code it carries.
 *
 * 🚨 **A creator's good cannot inherit the clothing code the Anthers shirts used.** A
 * hand-thrown mug taxed as clothing is a wrong return filed without anybody noticing, and
 * the goods that will sell first are exactly the ones no built-in category anticipated.
 * The list is deliberately short and only carries codes verified against Stripe's
 * published table: a category whose code nobody has checked is a category that files a
 * wrong return, and adding one is a research pass rather than a line in a map.
 */
export const PHYSICAL_TAX_CATEGORIES = {
	general: {
		code: "txcd_99999999",
		label: "A general physical good",
		detail: "A print, a mug, a figure, anything that ships and is not clothing.",
	},
	clothing: {
		code: "txcd_30011000",
		label: "Clothing or footwear",
		detail: "A shirt, a hat, a hand-knitted garment.",
	},
} as const;

/** The categories a physical listing may name. */
export type PhysicalTaxCategory = keyof typeof PHYSICAL_TAX_CATEGORIES;

/** Whether a value names a category we can price. */
export function isPhysicalTaxCategory(value: string): value is PhysicalTaxCategory {
	return Object.hasOwn(PHYSICAL_TAX_CATEGORIES, value);
}

/**
 * The code for support that buys nothing: a cash donation, `txcd_90000001`.
 *
 * Support that opens gated Works or carries a tagged perk is coded from what it buys
 * instead, at subscription build; this is the line that buys nothing at all, which the
 * posture holds is probably not a taxable sale in Colorado (PLR 22-005's shape).
 */
export const DONATION_TAX_CODE = "txcd_90000001";

/**
 * The code for a streamed-audiovisual subscription line — an Anthers Badge, or a creator
 * Badge that opens gated streaming Works. `txcd_10402200`.
 */
export const STREAMED_SUBSCRIPTION_TAX_CODE = "txcd_10402200";

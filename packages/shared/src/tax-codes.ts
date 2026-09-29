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
 * 🚨 **`physical` and `service` Works are refused at checkout rather than given a code.**
 * Nothing fulfills them yet — there is no shipping lane for a physical Work and no
 * fulfillment mechanism for a service one — so there is nothing a buyer receives to tax and
 * no code that honestly describes the charge. `purchaseTaxCode` returns `null` for them,
 * which the checkout paths read as a refusal; selling them arrives with whatever fulfills
 * them, and with a code.
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
			// Not sold until something fulfills them — no code describes an undelivered thing.
			return null;
	}
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

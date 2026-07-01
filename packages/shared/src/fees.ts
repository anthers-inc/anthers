// SPDX-License-Identifier: AGPL-3.0-or-later
import Decimal from "decimal.js";
import { FOUNDATION_FEE_PERCENTAGE } from "./constants.js";

/** Stripe processing fee: 2.9% + $0.30 */
const PROCESSING_RATE = new Decimal("0.029");
const PROCESSING_FLAT = new Decimal("0.30");

/** Anthers Foundation Fee as a rate (8% of the transaction amount). */
const FOUNDATION_RATE = new Decimal(FOUNDATION_FEE_PERCENTAGE).div(100);

/** Delivery/egress: ~$0.01 per GB of download bandwidth (per-GB, decimal). */
const DELIVERY_PER_GB = new Decimal("0.01");
const BYTES_PER_GB = new Decimal("1000000000");

/** Foundation hosting cost model constants (monthly per-creator) */
export const HOSTING_COSTS = {
	BASE_PER_CREATOR: new Decimal("0.50"),
	PER_GB_STORAGE: new Decimal("0.05"),
	PER_PROJECT: new Decimal("0.10"),
	PER_MEDIA_POST: new Decimal("0.15"),
} as const;

/** Maximum Foundation subsidy per creator per month */
export const MAX_MONTHLY_SUBSIDY = new Decimal("25.00");

/**
 * Calculate fee breakdown for a purchase (pass-through model).
 *
 * The creator receives the full listed price; processing, the Foundation Fee, and
 * delivery are added on top and paid by the buyer — never subtracted from earnings.
 * `deliveryBytes` is the total size of the downloadable content; pass 0 for items
 * with nothing to download.
 */
export function calculateFees(amount: Decimal, deliveryBytes: Decimal | number = 0) {
	const processingFee = amount
		.mul(PROCESSING_RATE)
		.plus(PROCESSING_FLAT)
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
	const foundationFee = amount.mul(FOUNDATION_RATE).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

	const bytes = new Decimal(deliveryBytes);
	let deliveryFee = bytes
		.div(BYTES_PER_GB)
		.mul(DELIVERY_PER_GB)
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
	// Any real download costs at least a cent to deliver — we can't bill sub-cent.
	if (bytes.gt(0) && deliveryFee.lte(0)) deliveryFee = new Decimal("0.01");

	const creatorEarnings = amount;
	const buyerTotal = amount.plus(processingFee).plus(foundationFee).plus(deliveryFee);

	return { processingFee, deliveryFee, crfFee: foundationFee, creatorEarnings, buyerTotal };
}

/**
 * Estimate monthly hosting costs for a creator.
 */
export function estimateHostingCost(params: {
	storageBytes: number;
	projectCount: number;
	mediaPostCount: number;
}): Decimal {
	const storageGb = new Decimal(params.storageBytes).div("1073741824");

	return HOSTING_COSTS.BASE_PER_CREATOR.plus(HOSTING_COSTS.PER_GB_STORAGE.mul(storageGb))
		.plus(HOSTING_COSTS.PER_PROJECT.mul(params.projectCount))
		.plus(HOSTING_COSTS.PER_MEDIA_POST.mul(params.mediaPostCount))
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

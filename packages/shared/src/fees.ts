import Decimal from "decimal.js";

/** Stripe processing fee: 2.9% + $0.30 */
const PROCESSING_RATE = new Decimal("0.029");
const PROCESSING_FLAT = new Decimal("0.30");

/** Community Resilience Fund: 3% of transaction amount */
const CRF_RATE = new Decimal("0.03");

/** CRF hosting cost model constants (monthly per-creator) */
export const HOSTING_COSTS = {
	BASE_PER_CREATOR: new Decimal("0.50"),
	PER_GB_STORAGE: new Decimal("0.05"),
	PER_PROJECT: new Decimal("0.10"),
	PER_MEDIA_POST: new Decimal("0.15"),
} as const;

/** Maximum CRF subsidy per creator per month */
export const MAX_MONTHLY_SUBSIDY = new Decimal("25.00");

/**
 * Calculate fee breakdown for a purchase.
 * Fees are shown to the buyer as line items — never subtracted from creator earnings.
 */
export function calculateFees(amount: Decimal) {
	const processingFee = amount
		.mul(PROCESSING_RATE)
		.plus(PROCESSING_FLAT)
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
	const crfFee = amount
		.mul(CRF_RATE)
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
	const creatorEarnings = amount;
	const buyerTotal = amount.plus(processingFee).plus(crfFee);

	return { processingFee, crfFee, creatorEarnings, buyerTotal };
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

	return HOSTING_COSTS.BASE_PER_CREATOR.plus(
		HOSTING_COSTS.PER_GB_STORAGE.mul(storageGb),
	)
		.plus(HOSTING_COSTS.PER_PROJECT.mul(params.projectCount))
		.plus(HOSTING_COSTS.PER_MEDIA_POST.mul(params.mediaPostCount))
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	BANDWIDTH_PER_GIB,
	CARD_FLAT,
	CARD_RATE,
	FREE_STORAGE_GIB,
	PHYSICAL_AFF_RATE,
	SALES_TAX_RATE,
	SELF_HOST_FEE,
	STORAGE_PER_GIB_MONTH,
	TIME_POOL_PER_GIB,
	USAGE_AFF_PER_GIB,
} from "./constants.js";

/** Bytes per GiB (binary). */
const GIB = new Decimal("1073741824");
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Maximum discretionary Foundation subsidy per creator per month. */
export const MAX_MONTHLY_SUBSIDY = new Decimal("25.00");

/** What a direct purchase delivers, which sets its Foundation Fee basis. */
export type PurchaseType = "digital" | "physical" | "service";

/**
 * Usage-price breakdown for a number of GiB (unrounded, full precision):
 * bandwidth (at cost) + AFF (charity) + Time Pool (to creators) = $0.03/GiB.
 */
export function usageBreakdown(gib: Decimal | number) {
	const g = new Decimal(gib);
	const bandwidth = g.mul(BANDWIDTH_PER_GIB);
	const aff = g.mul(USAGE_AFF_PER_GIB);
	const timePool = g.mul(TIME_POOL_PER_GIB);
	return { bandwidth, aff, timePool, total: bandwidth.plus(aff).plus(timePool) };
}

/**
 * Fee breakdown for a direct purchase (zero-cut, pass-through model).
 *
 * The creator receives the full listed price; the Anthers Foundation Fee, delivery
 * bandwidth, and card + sales tax are added on top and paid by the buyer — never
 * subtracted from earnings. Anthers keeps $0.
 *
 * - `digital`: the AFF is the **Digital AFF** — 50% of the download's bandwidth,
 *   the same fee as streaming — and the buyer also pays that bandwidth at cost.
 * - `physical` / `service`: no bytes are delivered, so the AFF is a nominal
 *   **Physical & Service AFF** of 1% of the price, and there is no delivery fee.
 *
 * `crfFee` keeps its legacy key name but holds the Foundation Fee (AFF) amount.
 */
export function calculateFees(
	amount: Decimal,
	opts: { deliveryBytes?: Decimal | number; type?: PurchaseType } = {},
) {
	const type = opts.type ?? "digital";
	const deliveryGiB = new Decimal(opts.deliveryBytes ?? 0).div(GIB);

	let deliveryFee = new Decimal(0);
	let foundationFee: Decimal;
	if (type === "digital") {
		deliveryFee = CENTS(deliveryGiB.mul(BANDWIDTH_PER_GIB));
		foundationFee = CENTS(deliveryGiB.mul(USAGE_AFF_PER_GIB));
		// Any real download costs at least a cent to deliver — we can't bill sub-cent.
		if (deliveryGiB.gt(0) && deliveryFee.lte(0)) deliveryFee = new Decimal("0.01");
	} else {
		foundationFee = CENTS(amount.mul(PHYSICAL_AFF_RATE));
	}

	const creatorEarnings = amount;
	// Card + tax apply to the buyer-paid subtotal (price + AFF + delivery); both leave the system.
	const subtotal = amount.plus(foundationFee).plus(deliveryFee);
	const processingFee = CENTS(subtotal.mul(CARD_RATE).plus(CARD_FLAT));
	const salesTax = CENTS(subtotal.mul(SALES_TAX_RATE));
	const buyerTotal = subtotal.plus(processingFee).plus(salesTax);

	return {
		processingFee,
		deliveryFee,
		salesTax,
		crfFee: foundationFee,
		creatorEarnings,
		buyerTotal,
	};
}

/**
 * A creator's monthly storage cost and the storage-side Foundation Fee.
 *
 * Storage beyond the free allowance is billed at DigitalOcean rates; the AFF is
 * 50% of that storage cost. Delivery is viewer-funded, so it is not billed here.
 * A self-hosting creator (Anthers stores/serves nothing) pays a flat fee instead.
 */
export function estimateStorageCost(params: { storageBytes: number; isSelfHosting?: boolean }): {
	storageGiB: Decimal;
	storageCost: Decimal;
	storageAff: Decimal;
	total: Decimal;
} {
	if (params.isSelfHosting) {
		const fee = new Decimal(SELF_HOST_FEE);
		return { storageGiB: new Decimal(0), storageCost: new Decimal(0), storageAff: fee, total: fee };
	}
	const billableGiB = Decimal.max(
		0,
		new Decimal(params.storageBytes).div(GIB).minus(FREE_STORAGE_GIB),
	);
	const storageCost = CENTS(billableGiB.mul(STORAGE_PER_GIB_MONTH));
	const storageAff = CENTS(storageCost.mul(AFF_INFRA_RATE));
	return { storageGiB: billableGiB, storageCost, storageAff, total: storageCost.plus(storageAff) };
}

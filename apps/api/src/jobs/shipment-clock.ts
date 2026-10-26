// SPDX-License-Identifier: Apache-2.0
/**
 * The shipment clock — closes the wait on parcels nothing reported delivered.
 *
 * A physical good's buyer confirms receipt when they have it, and a carrier's signal
 * confirms it when we can read one. Neither is guaranteed: a creator may use a carrier
 * whose data we never see, a label may have been bought elsewhere, or a parcel may be
 * handed over locally. Without this sweep those orders sit in transit forever, the buyer
 * has no window that ever opens, and the creator is never paid for something that plainly
 * arrived.
 *
 * So the clock runs on the absence of evidence: a shipment that left the creator's hands
 * and produced no delivery signal for the fallback window is marked delivered with source
 * `fallback`. The row records that nobody observed it, which is the honest version of the
 * fact, and a dispute met later can tell the difference between a carrier scan and a
 * guess.
 *
 * ⚠️ **Nothing here moves money, and nothing here sends mail.** It advances one date on
 * rows that have earned it, and it is quiet when it finds none — the same posture every
 * other sweep's worker logs with.
 */
import { releaseAbandonedStock } from "../services/physical-stock.js";
import { advanceFallbackDeliveries } from "../services/shipments.js";

export interface ShipmentClockResult {
	/** How many shipments the fallback closed on this pass. */
	closed: number;
	/** How many abandoned orders gave their reserved stock back. */
	released: number;
}

/**
 * The daily physical-goods sweep: close the delivery clock, and put abandoned orders'
 * stock back on the shelf.
 *
 * ⚠️ **The two belong to one job rather than two**, because both are "the day after" work
 * over the same rows and neither is urgent to the minute — a fallback delivery is a
 * fourteen-day judgment and a stock reservation is returned a day after it was made.
 * Splitting them would buy a second cron entry and no correctness.
 */
export async function runShipmentClock(now: Date = new Date()): Promise<ShipmentClockResult> {
	const released = await releaseAbandonedStock(now);
	const closed = await advanceFallbackDeliveries(now);
	return { closed, released };
}

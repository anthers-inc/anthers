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
import { advanceFallbackDeliveries } from "../services/shipments.js";

export interface ShipmentClockResult {
	/** How many shipments the fallback closed on this pass. */
	closed: number;
}

export async function runShipmentClock(now: Date = new Date()): Promise<ShipmentClockResult> {
	const closed = await advanceFallbackDeliveries(now);
	return { closed };
}

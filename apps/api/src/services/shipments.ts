// SPDX-License-Identifier: Apache-2.0
/**
 * Shipments — the one writer of `shipments`, and the clocks that carry an order from paid
 * to closed.
 *
 * A physical purchase is paid up front and fulfilled by a person, so the platform's job
 * is to keep three questions answerable: *should this have shipped yet*, *has it landed*,
 * and *can the buyer still say something went wrong*. Each is a date on the row, stamped
 * once when it becomes knowable, and the state a surface shows is a reading of those dates
 * (`shipmentState`) rather than a stored enum — a status column is a second copy of truth
 * that drifts the moment a clock fires without a writer.
 *
 * 🚨 **The three clocks, and why each is anchored where it is:**
 *
 *   1. **Ship-by** is computed at purchase from the Work's handling time, in business days,
 *      and snapshotted onto the row. A creator who shortens their handling time tomorrow
 *      must not move the deadline of an order somebody already placed.
 *   2. **Delivery** arrives from a carrier signal or from the buyer confirming receipt.
 *      When neither arrives, the fallback closes the wait a fixed number of days after the
 *      parcel shipped — a creator must not go unpaid because a carrier's data never
 *      reached us, and this is the only clock that runs on the absence of evidence.
 *   3. **The complaint window** opens at delivery, never at shipment, and its end is
 *      stamped onto the row rather than recomputed. The buyer's deadline is theirs; a later
 *      policy change must not shorten a window somebody already has.
 *
 * ⚠️ **Nothing here moves money.** Release is the purchase split's business, and it will
 * ask this module whether a shipment is closed rather than this module paying anybody —
 * the money path has one writer (`services/purchase-split.ts`) and the delivery path has
 * one (`this`). Keeping them apart is what lets the hold change without touching a clock.
 */
import { db } from "@anthers/db/client";
import { shipmentComplaints, shipments } from "@anthers/db/schema";
import {
	SHIPMENT_COMPLAINT_WINDOW_DAYS,
	SHIPMENT_DELIVERY_FALLBACK_DAYS,
	SHIPMENT_HANDLING_DAYS_DEFAULT,
	SHIPMENT_HANDLING_DAYS_MAX,
	SHIPMENT_HANDLING_DAYS_MIN,
} from "@anthers/shared/constants";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

type Shipment = typeof shipments.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The carriers a tracking link can be built for. Anything else is `other`. */
export const SHIPMENT_CARRIERS = ["usps", "ups", "fedex", "dhl", "other"] as const;
export type ShipmentCarrier = (typeof SHIPMENT_CARRIERS)[number];

/** How delivery was established. The three carry different weight in a dispute. */
export type DeliverySource = "carrier" | "buyer" | "fallback";

/** What a surface shows. Derived from the row's dates, never stored. */
export type ShipmentState = "awaiting_shipment" | "in_transit" | "delivered" | "window_closed";

/**
 * The state a shipment is in at `now`.
 *
 * `window_closed` is the terminal state this module owns: the parcel landed (or was
 * treated as landed) and the buyer can report nothing further. Whether the creator has
 * been paid is a separate question the money path answers.
 */
export function shipmentState(row: Shipment, now: Date = new Date()): ShipmentState {
	if (!row.shippedAt) return "awaiting_shipment";
	if (!row.deliveredAt) return "in_transit";
	if (row.complaintWindowEndsAt && row.complaintWindowEndsAt.getTime() <= now.getTime())
		return "window_closed";
	return "delivered";
}

/**
 * Whether a shipment has blown its ship-by date without leaving.
 *
 * Not an error and not a cancellation: it is the fact a buyer's refund request rests on,
 * and the fact a creator's order list should show first.
 */
export function isOverdue(row: Shipment, now: Date = new Date()): boolean {
	return !row.shippedAt && row.shipByAt.getTime() < now.getTime();
}

/**
 * Add business days to a moment, skipping Saturday and Sunday.
 *
 * Postal holidays are deliberately not skipped: a holiday calendar is a third-party feed,
 * and this clock has to be computable from a date alone. A deadline that lands on a
 * federal holiday is a deadline a day early, which is the safe direction.
 */
export function addBusinessDays(from: Date, days: number): Date {
	const out = new Date(from.getTime());
	let remaining = Math.max(0, Math.trunc(days));
	while (remaining > 0) {
		out.setUTCDate(out.getUTCDate() + 1);
		const weekday = out.getUTCDay();
		if (weekday !== 0 && weekday !== 6) remaining -= 1;
	}
	return out;
}

/** Clamp a creator's handling time into the range the product offers. */
export function clampHandlingDays(days: number | null | undefined): number {
	if (days == null || !Number.isFinite(days)) return SHIPMENT_HANDLING_DAYS_DEFAULT;
	return Math.min(
		SHIPMENT_HANDLING_DAYS_MAX,
		Math.max(SHIPMENT_HANDLING_DAYS_MIN, Math.trunc(days)),
	);
}

/** Normalize whatever a creator typed into one of the codes a link can be built from. */
export function normalizeCarrier(value: string | null | undefined): ShipmentCarrier {
	const v = (value ?? "").trim().toLowerCase();
	if (!v) return "other";
	if (v.includes("usps") || v.includes("postal")) return "usps";
	if (v.includes("ups")) return "ups";
	if (v.includes("fedex") || v.includes("federal express")) return "fedex";
	if (v.includes("dhl")) return "dhl";
	return "other";
}

/**
 * The buyer-facing tracking link for a carrier, or null when we cannot build one.
 *
 * A link we can build is worth showing even though we never fetch its contents: the
 * buyer gets the carrier's own page, which is the most current answer that exists, and
 * we make no claim we cannot support.
 */
export function trackingUrlFor(
	carrier: string | null,
	trackingNumber: string | null,
): string | null {
	const number = (trackingNumber ?? "").trim();
	if (!number) return null;
	const encoded = encodeURIComponent(number);
	switch (normalizeCarrier(carrier)) {
		case "usps":
			return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
		case "ups":
			return `https://www.ups.com/track?tracknum=${encoded}`;
		case "fedex":
			return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
		case "dhl":
			return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encoded}`;
		default:
			return null;
	}
}

/** Append one entry to the row's log and return the new array. */
function appended(
	existing: Shipment["events"],
	entry: { type: string; occurredAt: Date; note?: string },
): Shipment["events"] {
	return [...(existing ?? []), { ...entry, occurredAt: entry.occurredAt.toISOString() }];
}

/**
 * Open the shipment a completed physical purchase owes.
 *
 * Idempotent on the purchase: a replayed completion finds the row and leaves it alone,
 * because a second shipment row for one purchase is two answers to one question. Returns
 * null for a purchase that already has one.
 */
export async function createShipmentForPurchase(input: {
	purchaseId: number;
	handlingBusinessDays?: number | null;
	now?: Date;
}): Promise<Shipment | null> {
	const now = input.now ?? new Date();
	const handling = clampHandlingDays(input.handlingBusinessDays);
	const [row] = await db
		.insert(shipments)
		.values({
			purchaseId: input.purchaseId,
			handlingBusinessDays: handling,
			shipByAt: addBusinessDays(now, handling),
			events: [],
		})
		.onConflictDoNothing({ target: shipments.purchaseId })
		.returning();
	return row ?? null;
}

/** The shipment behind a purchase, or null when the purchase is not a physical one. */
export async function shipmentForPurchase(purchaseId: number): Promise<Shipment | null> {
	const [row] = await db
		.select()
		.from(shipments)
		.where(eq(shipments.purchaseId, purchaseId))
		.limit(1);
	return row ?? null;
}

export type MarkShippedResult =
	| { ok: true; shipment: Shipment }
	| { ok: false; reason: "no_shipment" | "already_shipped" | "no_tracking" };

/**
 * Record that a good left the creator's hands.
 *
 * The tracking number is required: it is the buyer's only way to follow the parcel and
 * the creator's only evidence that something was sent, and a shipment without one is a
 * claim rather than a fact. Re-marking an already-shipped order is refused rather than
 * silently overwritten, so a typo is corrected deliberately by whoever owns the order.
 */
export async function markShipped(
	purchaseId: number,
	input: { carrier?: string | null; carrierName?: string | null; trackingNumber?: string | null },
	now: Date = new Date(),
): Promise<MarkShippedResult> {
	const row = await shipmentForPurchase(purchaseId);
	if (!row) return { ok: false, reason: "no_shipment" };
	if (row.shippedAt) return { ok: false, reason: "already_shipped" };

	const trackingNumber = (input.trackingNumber ?? "").trim();
	if (!trackingNumber) return { ok: false, reason: "no_tracking" };

	const carrier = normalizeCarrier(input.carrier ?? input.carrierName);
	const [updated] = await db
		.update(shipments)
		.set({
			carrier,
			carrierName: (input.carrierName ?? "").trim() || null,
			trackingNumber,
			trackingUrl: trackingUrlFor(carrier, trackingNumber),
			shippedAt: now,
			events: appended(row.events, { type: "shipped", occurredAt: now, note: carrier }),
			updatedAt: now,
		})
		.where(eq(shipments.id, row.id))
		.returning();
	return { ok: true, shipment: updated };
}

/**
 * Record that the parcel landed, and open the complaint window from that moment.
 *
 * The source is kept because it changes what the fact is worth: a carrier scan is
 * evidence, a buyer's own confirmation is an admission against their later claim, and
 * the fallback is neither.
 */
export async function markDelivered(
	purchaseId: number,
	source: DeliverySource,
	now: Date = new Date(),
): Promise<Shipment | null> {
	const row = await shipmentForPurchase(purchaseId);
	if (!row?.shippedAt) return null;
	// A delivery already known is not overwritten by a weaker later signal: a buyer
	// confirming receipt must not erase the carrier's timestamp, and the fallback must
	// never replace a real one.
	if (row.deliveredAt) return row;

	const windowEnds = new Date(now.getTime() + SHIPMENT_COMPLAINT_WINDOW_DAYS * DAY_MS);
	const [updated] = await db
		.update(shipments)
		.set({
			deliveredAt: now,
			deliverySource: source,
			complaintWindowEndsAt: windowEnds,
			events: appended(row.events, {
				type: source === "buyer" ? "receipt_confirmed" : "delivered",
				occurredAt: now,
				note: source,
			}),
			updatedAt: now,
		})
		.where(eq(shipments.id, row.id))
		.returning();
	return updated ?? null;
}

/** A buyer saying the parcel arrived. The strongest signal available without an integration. */
export async function confirmReceipt(
	purchaseId: number,
	now: Date = new Date(),
): Promise<Shipment | null> {
	return markDelivered(purchaseId, "buyer", now);
}

/**
 * Close the clock on parcels nothing has reported delivered.
 *
 * The sweep the job runs. A shipment qualifies when it has shipped, has no delivery, and
 * its ship date is at least the fallback window in the past. Each is stamped through
 * `markDelivered` with source `fallback`, so the row records honestly that nobody
 * observed the delivery — only that the wait is over.
 */
export async function advanceFallbackDeliveries(now: Date = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - SHIPMENT_DELIVERY_FALLBACK_DAYS * DAY_MS);
	const due = await db
		.select({ id: shipments.id, purchaseId: shipments.purchaseId })
		.from(shipments)
		.where(and(isNull(shipments.deliveredAt), lte(shipments.shippedAt, cutoff)));

	let closed = 0;
	for (const row of due) {
		if (row.purchaseId == null) continue;
		const updated = await markDelivered(row.purchaseId, "fallback", now);
		if (updated) closed += 1;
	}
	return closed;
}

/**
 * Whether a purchase's complaint window has closed at `now` — the question the money path
 * will ask before releasing a physical good's share.
 *
 * Deliberately a predicate on the row rather than a join to `purchases`: the release rule
 * is a fact about the shipment, and the money module stays the one that decides what to do
 * with it.
 */
export function isReleaseEligible(row: Shipment | null, now: Date = new Date()): boolean {
	if (!row) return false;
	if (!row.deliveredAt || !row.complaintWindowEndsAt) return false;
	return row.complaintWindowEndsAt.getTime() <= now.getTime();
}

/** The raw SQL a surface may want for "shipped, not delivered" without loading every row. */
export const pendingDeliveryPredicate = sql`${shipments.shippedAt} is not null and ${shipments.deliveredAt} is null`;

/**
 * Which of a set of orders are releasable at `now` — the batch form of `isReleaseEligible`,
 * for the transfer job, which asks once per creator rather than once per credit.
 *
 * 🚨 **An open complaint freezes the release**, which is the whole point of the complaint
 * record: a buyer who says the mug arrived cracked has stopped the money leaving until
 * somebody answers them. The rule is one sentence — delivered, the window has closed, and
 * nothing is open — and it lives here so the transfer job and any surface that shows a
 * creator their money read the same one.
 */
export async function releasableOrders(
	purchaseIds: number[],
	now: Date = new Date(),
): Promise<Set<number>> {
	if (purchaseIds.length === 0) return new Set();
	const rows = await db
		.select({
			purchaseId: shipments.purchaseId,
			deliveredAt: shipments.deliveredAt,
			complaintWindowEndsAt: shipments.complaintWindowEndsAt,
		})
		.from(shipments)
		.where(inArray(shipments.purchaseId, purchaseIds));
	const open = await db
		.select({ purchaseId: shipmentComplaints.purchaseId })
		.from(shipmentComplaints)
		.where(
			and(
				inArray(shipmentComplaints.purchaseId, purchaseIds),
				eq(shipmentComplaints.status, "open"),
			),
		);
	const frozen = new Set(open.map((row) => row.purchaseId));
	const releasable = new Set<number>();
	for (const row of rows) {
		if (row.purchaseId == null || frozen.has(row.purchaseId)) continue;
		if (!row.deliveredAt || !row.complaintWindowEndsAt) continue;
		if (row.complaintWindowEndsAt.getTime() <= now.getTime()) releasable.add(row.purchaseId);
	}
	return releasable;
}

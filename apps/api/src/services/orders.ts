// SPDX-License-Identifier: Apache-2.0
/**
 * Orders — the two surfaces a physical purchase needs after it is paid: the creator's list
 * of what to pack, and the buyer's page for the thing they are waiting for.
 *
 * 🚨 **Both halves read the same three rows and neither derives its own money.** The purchase
 * is the financial record, the shipment is what happened to the parcel, and a complaint is
 * what the buyer says about it. This module is the read that joins them and the one writer
 * of a complaint; marking an order shipped and confirming receipt stay in
 * `services/shipments.ts`, which owns those transitions.
 *
 * ⚠️ **The state is derived, never stored** — `shipmentState` over the shipment's dates,
 * exactly as the clocks module reads it, so an order surface cannot show a state the clocks
 * disagree with.
 */
import { db } from "@anthers/db/client";
import { purchases, shipmentComplaints, shipments, users } from "@anthers/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { isOverdue, type ShipmentState, shipmentState, trackingUrlFor } from "./shipments.js";

/** What a buyer may say is wrong. The list is short on purpose — it is a category, not a menu. */
export const COMPLAINT_REASONS = ["not_as_described", "damaged", "never_arrived", "other"] as const;
export type ComplaintReason = (typeof COMPLAINT_REASONS)[number];

export function isComplaintReason(value: string): value is ComplaintReason {
	return (COMPLAINT_REASONS as readonly string[]).includes(value);
}

/** The sentence a reason reads as, for a surface that shows it back. */
export const COMPLAINT_REASON_LABELS: Record<ComplaintReason, string> = {
	not_as_described: "Not as described",
	damaged: "Damaged in transit",
	never_arrived: "Never arrived",
	other: "Something else",
};

export interface OrderComplaint {
	reason: ComplaintReason;
	details: string;
	status: string;
	createdAt: Date;
	resolvedAt: Date | null;
}

/** One physical order, as either surface needs it. */
export interface OrderView {
	id: number;
	/** What was bought, as it was at the time of sale. */
	title: string | null;
	workId: number | null;
	quantity: number;
	options: Array<{ name: string; label: string }> | null;
	/** Goods and shipping, as the row recorded them. */
	amount: string;
	shippingAmount: string;
	/** What the creator receives for this order — the figure the hold task will gate. */
	creatorEarnings: string;
	purchasedAt: Date;
	shipment: {
		state: ShipmentState;
		overdue: boolean;
		carrier: string | null;
		carrierName: string | null;
		trackingNumber: string | null;
		trackingUrl: string | null;
		handlingBusinessDays: number;
		shipByAt: Date;
		shippedAt: Date | null;
		deliveredAt: Date | null;
		deliverySource: string | null;
		complaintWindowEndsAt: Date | null;
	};
	complaint: OrderComplaint | null;
}

/** Where the parcel is going — the creator's half of an order, and never the buyer's. */
export interface OrderAddress {
	name: string | null;
	line1: string | null;
	line2: string | null;
	city: string | null;
	state: string | null;
	postalCode: string | null;
	country: string | null;
}

export interface CreatorOrder extends OrderView {
	buyer: { handle: string | null };
	address: OrderAddress;
	status: string;
}

function view(
	row: {
		purchase: typeof purchases.$inferSelect;
		shipment: typeof shipments.$inferSelect | null;
		complaint: typeof shipmentComplaints.$inferSelect | null;
	},
	now: Date,
): OrderView | null {
	const s = row.shipment;
	if (!s) return null;
	return {
		id: row.purchase.id,
		title: row.purchase.workTitle,
		workId: row.purchase.workId,
		quantity: row.purchase.quantity,
		options: row.purchase.options ?? null,
		amount: row.purchase.amount,
		shippingAmount: row.purchase.shippingAmount,
		creatorEarnings: row.purchase.creatorEarnings,
		purchasedAt: row.purchase.createdAt,
		shipment: {
			state: shipmentState(s, now),
			overdue: isOverdue(s, now),
			carrier: s.carrier,
			carrierName: s.carrierName,
			trackingNumber: s.trackingNumber,
			// Rebuilt rather than trusted: a row written before a carrier was normalized
			// still gets a link, and a carrier we cannot link is honestly null.
			trackingUrl: s.trackingUrl ?? trackingUrlFor(s.carrier, s.trackingNumber),
			handlingBusinessDays: s.handlingBusinessDays,
			shipByAt: s.shipByAt,
			shippedAt: s.shippedAt,
			deliveredAt: s.deliveredAt,
			deliverySource: s.deliverySource,
			complaintWindowEndsAt: s.complaintWindowEndsAt,
		},
		complaint: row.complaint
			? {
					reason: row.complaint.reason as ComplaintReason,
					details: row.complaint.details,
					status: row.complaint.status,
					createdAt: row.complaint.createdAt,
					resolvedAt: row.complaint.resolvedAt,
				}
			: null,
	};
}

const openComplaintJoin = and(
	eq(shipmentComplaints.purchaseId, purchases.id),
	eq(shipmentComplaints.status, "open"),
);

/**
 * A creator's own orders, newest first — the packing list.
 *
 * Only `completed` purchases appear: a pending one is a checkout somebody may still
 * abandon, and a shipment exists for it only once the money landed. An order whose shipment
 * row is missing (a physical purchase completed before the shipment writer shipped, or one
 * whose write failed) is included rather than hidden — the money is real even when the
 * operational row is not, and hiding it would lose an order the creator has been paid for.
 */
export async function creatorOrders(
	creatorId: number,
	now: Date = new Date(),
): Promise<CreatorOrder[]> {
	const rows = await db
		.select({
			purchase: purchases,
			shipment: shipments,
			complaint: shipmentComplaints,
			buyerHandle: users.atprotoHandle,
		})
		.from(purchases)
		.leftJoin(shipments, eq(shipments.purchaseId, purchases.id))
		.leftJoin(users, eq(users.id, purchases.buyerId))
		.leftJoin(shipmentComplaints, openComplaintJoin)
		.where(
			and(
				eq(purchases.creatorId, creatorId),
				eq(purchases.type, "physical"),
				eq(purchases.status, "completed"),
			),
		)
		.orderBy(desc(purchases.createdAt));

	return rows.flatMap((row) => {
		// A purchase with no shipment still has to be packable, so the clock fields fall
		// back to the purchase's own handling snapshot and its sale date.
		const shipment = row.shipment ?? orphanShipment(row.purchase);
		const view$ = view({ ...row, shipment }, now);
		if (!view$) return [];
		return [
			{
				...view$,
				status: row.purchase.status,
				buyer: { handle: row.buyerHandle },
				address: {
					name: null,
					line1: row.purchase.buyerAddressLine1,
					line2: row.purchase.buyerAddressLine2,
					city: row.purchase.buyerCity,
					state: row.purchase.buyerState,
					postalCode: row.purchase.buyerPostalCode,
					country: row.purchase.buyerCountry,
				},
			},
		];
	});
}

/**
 * The shipment-shaped clock an order carries when its `shipments` row never landed.
 *
 * Deliberately not written to the database from a read: this is what the surface needs to
 * show a deadline, and the honest repair is the completion path creating the row, not a
 * `GET` mutating money-adjacent state.
 */
function orphanShipment(purchase: typeof purchases.$inferSelect): typeof shipments.$inferSelect {
	const handling = purchase.handlingBusinessDays ?? 3;
	return {
		id: -purchase.id,
		purchaseId: purchase.id,
		carrier: null,
		carrierName: null,
		trackingNumber: null,
		trackingUrl: null,
		handlingBusinessDays: handling,
		shipByAt: purchase.createdAt,
		shippedAt: null,
		deliveredAt: null,
		deliverySource: null,
		complaintWindowEndsAt: null,
		events: [],
		createdAt: purchase.createdAt,
		updatedAt: purchase.createdAt,
	} as typeof shipments.$inferSelect;
}

/** A buyer's own order, or null when it is not theirs (which the route answers as 404). */
export async function buyerOrder(
	purchaseId: number,
	buyerId: number,
	now: Date = new Date(),
): Promise<(OrderView & { creatorHandle: string | null }) | null> {
	const [row] = await db
		.select({
			purchase: purchases,
			shipment: shipments,
			complaint: shipmentComplaints,
			creatorHandle: users.atprotoHandle,
		})
		.from(purchases)
		.leftJoin(shipments, eq(shipments.purchaseId, purchases.id))
		.leftJoin(shipmentComplaints, openComplaintJoin)
		.leftJoin(users, eq(users.id, purchases.creatorId))
		.where(and(eq(purchases.id, purchaseId), eq(purchases.buyerId, buyerId)))
		.limit(1);
	if (!row) return null;
	const view$ = view({ ...row, shipment: row.shipment ?? orphanShipment(row.purchase) }, now);
	if (!view$) return null;
	return { ...view$, creatorHandle: row.creatorHandle };
}

export type ComplaintResult =
	| { ok: true; complaint: OrderComplaint }
	| { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Open a complaint on an order the buyer owns, while its window is open.
 *
 * 🚨 **The window is the shipment's own stamp, read here rather than recomputed**: a policy
 * change after delivery must not shorten a deadline somebody already has, and the stamp was
 * written for exactly that reason.
 */
export async function openComplaint(
	purchaseId: number,
	buyerId: number,
	input: { reason?: unknown; details?: unknown },
	now: Date = new Date(),
): Promise<ComplaintResult> {
	const [row] = await db
		.select({ purchase: purchases, shipment: shipments })
		.from(purchases)
		.leftJoin(shipments, eq(shipments.purchaseId, purchases.id))
		.where(and(eq(purchases.id, purchaseId), eq(purchases.buyerId, buyerId)))
		.limit(1);
	if (!row) return { ok: false, status: 404, error: "Order not found" };

	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	if (!isComplaintReason(reason))
		return { ok: false, status: 400, error: "Choose what went wrong." };
	const details = typeof input.details === "string" ? input.details.slice(0, 2000).trim() : "";

	const shipment = row.shipment;
	if (!shipment?.deliveredAt || !shipment.complaintWindowEndsAt) {
		return {
			ok: false,
			status: 409,
			error: "This order hasn't been delivered yet, so there's nothing to report.",
		};
	}
	if (shipment.complaintWindowEndsAt.getTime() <= now.getTime()) {
		return {
			ok: false,
			status: 409,
			error: "The window for reporting a problem with this order has closed.",
		};
	}

	const [inserted] = await db
		.insert(shipmentComplaints)
		.values({ purchaseId, buyerId, reason, details })
		// The partial unique index turns a second press into a no-op rather than a second
		// problem; the existing row is what the buyer is shown either way.
		.onConflictDoNothing()
		.returning();
	const complaint = inserted ?? (await openComplaintFor(purchaseId));
	if (!complaint)
		return { ok: false, status: 409, error: "A problem is already open on this order." };
	return {
		ok: true,
		complaint: {
			reason: complaint.reason as ComplaintReason,
			details: complaint.details,
			status: complaint.status,
			createdAt: complaint.createdAt,
			resolvedAt: complaint.resolvedAt,
		},
	};
}

/** The open complaint on an order, if there is one. */
export async function openComplaintFor(purchaseId: number) {
	const [row] = await db
		.select()
		.from(shipmentComplaints)
		.where(
			and(eq(shipmentComplaints.purchaseId, purchaseId), eq(shipmentComplaints.status, "open")),
		)
		.limit(1);
	return row ?? null;
}

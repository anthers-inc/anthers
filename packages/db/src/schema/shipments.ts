// SPDX-License-Identifier: Apache-2.0
/**
 * Shipments — the delivery half of a physical purchase, and nothing about its money.
 *
 * The financial record stays on `purchases`, exactly as a digital sale's does. This table
 * carries only what a good that a person ships needs and a download never did: where it
 * is going, when it must leave, when it left, when it landed, and how long the buyer has
 * to say something went wrong.
 *
 * 🚨 **Nothing here is a status column, deliberately.** The state of a shipment is
 * derived from its timestamps by `shipmentState` in `services/shipments.ts` — a stored
 * enum would be a second copy of truth that drifts the moment a clock fires without a
 * writer, and every one of these transitions is a clock rather than a decision. What is
 * stored is what happened; what is shown is a reading of it.
 *
 * ⚠️ **The complaint window is measured from delivery, not from the ship date**, and a
 * parcel the carrier never reports as delivered falls back to a fixed number of days
 * after it shipped. Both clocks are computed once, at the moment they become knowable,
 * and stamped — so a later change to the policy cannot move a deadline somebody already
 * has.
 */
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { purchases } from "./payments.js";

// org — a shipment is the platform's operational record of an order it brokered; the
// carrier and the tracking number are the creator's, held here to show the buyer.
export const shipments = pgTable(
	"shipments",
	{
		id: serial("id").primaryKey(),
		/** The purchase this ships. One purchase is one good, so at most one shipment. */
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		/**
		 * The carrier's normalized code — `usps`, `ups`, `fedex`, `dhl`, `other`. A code
		 * rather than a name so a tracking link can be built from it and a future provider
		 * can be asked about it; `carrierName` carries whatever the creator called it.
		 */
		carrier: text("carrier"),
		/** The creator's own spelling, shown when `carrier` is `other` or the code is missing. */
		carrierName: text("carrier_name"),
		trackingNumber: text("tracking_number"),
		/** The buyer-facing link, built from the carrier code when one is known. */
		trackingUrl: text("tracking_url"),
		/**
		 * The handling time the order was placed under, snapshotted rather than read back
		 * from the Work: a creator who shortens their handling time tomorrow must not
		 * move the deadline of an order somebody already placed.
		 */
		handlingBusinessDays: integer("handling_business_days").notNull(),
		/** The date by which it must leave, computed at purchase from the handling time. */
		shipByAt: timestamp("ship_by_at", { withTimezone: true }).notNull(),
		shippedAt: timestamp("shipped_at", { withTimezone: true }),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		/**
		 * How delivery was established — `carrier`, `buyer`, or `fallback`. Kept because
		 * the three carry different weight in a dispute: a carrier scan is evidence, a
		 * buyer's own confirmation is an admission, and a fallback is neither.
		 */
		deliverySource: text("delivery_source"),
		/** The last moment the buyer may report a problem, stamped when delivery is known. */
		complaintWindowEndsAt: timestamp("complaint_window_ends_at", { withTimezone: true }),
		/**
		 * The append-only log: `{ type, occurredAt, note }` entries — `shipped`,
		 * `delivered`, `receipt_confirmed`, `fallback_delivered`. A record of what
		 * happened beside the timestamps that summarize it.
		 */
		events: jsonb("events")
			.$type<Array<{ type: string; occurredAt: string; note?: string }>>()
			.notNull()
			.default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One shipment per purchase — a re-mark replaces the same row rather than adding one.
		uniqueIndex("uq_shipments_purchase").on(table.purchaseId),
		// The clock sweep's lookup: shipments that have shipped and not yet landed.
		index("idx_shipments_pending_delivery").on(table.deliveredAt, table.shippedAt),
	],
);

/**
 * A buyer saying something went wrong with an order — the record the release rule reads.
 *
 * 🚨 **A complaint is the only thing that can stop a creator being paid after delivery**, so
 * it is its own row rather than a flag on the shipment: the shipment records what happened
 * to the parcel, and this records what the buyer says about it, who has to answer, and
 * whether they have. A settled complaint leaves the row (with `status` and `resolvedAt`)
 * rather than deleting it, because a refund that followed one needs to be explainable
 * months later.
 *
 * ⚠️ **The window is checked when the complaint is opened, not by this table.** The buyer's
 * deadline was stamped on the shipment at delivery (`complaintWindowEndsAt`), and a
 * complaint arrives only while that stamp is in the future — the row itself has no window
 * of its own, so it cannot disagree with the shipment's.
 */
// org — a complaint gates a payout and is answered by support, so the record stays with the
// organization rather than following a creator to a machine they run.
export const shipmentComplaints = pgTable(
	"shipment_complaints",
	{
		id: serial("id").primaryKey(),
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		/** Who reported it. Nullable and set-null, like every record that outlives an account. */
		buyerId: integer("buyer_id").references(() => users.id, { onDelete: "set null" }),
		/** `not_as_described`, `damaged`, `never_arrived`, `other`. */
		reason: text("reason").notNull(),
		/** The buyer's own words. The reason above is the category; this is what they wrote. */
		details: text("details").notNull().default(""),
		/** `open` until a person settles it; `resolved` or `dismissed` after. */
		status: text("status").notNull().default("open"),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One open complaint per order: a buyer pressing the button twice is one problem,
		// and two open rows would make "is this frozen" a question with two answers.
		uniqueIndex("uq_shipment_complaints_open")
			.on(table.purchaseId)
			.where(sql`${table.status} = 'open'`),
		index("idx_shipment_complaints_purchase").on(table.purchaseId),
	],
);

// SPDX-License-Identifier: Apache-2.0
/**
 * Printful merch — the fulfillment half of Anthers' own physical goods.
 *
 * The financial record stays on `purchases`, exactly as a digital sale's does; these
 * tables carry only what Printful adds: **which blank garment sizes map to which
 * Printful variant** (`merch_variants`, written by the setup script) and **what became
 * of each purchase on Printful's side** (`merch_fulfillments`, written by the completion
 * path and the webhook receiver).
 *
 * Nothing here is money. Both tables are children of payments rows and live beside them
 * by that tie, but every dollar figure the flows produce is recorded on `purchases` (the
 * margin in `creator_earnings`, Printful's costs in `printful_costs`) and on Printful's
 * own invoices. A fulfillment record that carried money of its own would be two records
 * of one amount drifting apart.
 *
 * 🚨 **This module is the one writer of its records** (`services/printful.ts` for
 * fulfillments; the setup script for variants) — routes read, they do not write.
 */
import {
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { works } from "./content.js";
import { purchases } from "./payments.js";

/**
 * org — one sellable size of one merch Work, mapped to Printful's catalog.
 *
 * A merch Work (type `physical`, owned by the official Anthers account) is priced not
 * from its `price` column but **derived**: Printful's catalog price for the variant plus
 * the margin constant. This table is the link that makes the derivation real — which
 * Printful blank (`catalogVariantId`) answers this Work's `size` label, and at what the
 * catalog currently lists it.
 *
 * ⚠️ **`catalogPrice` is a snapshot, not the pricing source.** The quote re-derives the
 * list price from the Printful catalog at checkout, so a Printful price change is caught
 * before a buyer is charged a stale figure; this column is what the Work page renders
 * before checkout and what makes drift visible rather than discovered at the Pay button.
 */
// org — the mapping between a Work's sellable size and Printful's catalog is Anthers'
// selling machinery (a fact about the platform's own store, never a creator's).
export const merchVariants = pgTable(
	"merch_variants",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		/** The buyer-facing size label, exactly as the Work page shows it ("M", "L", "XL"). */
		size: text("size").notNull(),
		/** Printful's catalog variant id — the blank garment+size+color, NOT the product id. */
		catalogVariantId: integer("catalog_variant_id").notNull(),
		/** Printful's name for the variant, as the receipt and packing slip name it. */
		catalogVariantName: text("catalog_variant_name").notNull(),
		/** The blank's catalog price, captured when the row was written. A snapshot — see above. */
		catalogPrice: numeric("catalog_price").notNull(),
		/** The print-file URL this variant prints from — unique per design, per the File Library's reuse rule. */
		printFileUrl: text("print_file_url").notNull(),
		/** True once the row exists on the Printful store as a Sync Variant (`external_id` = this row's id). */
		synced: boolean("synced").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One row per (Work, size) — the picker offers each size once.
		uniqueIndex("uq_merch_variants_work_size").on(table.workId, table.size),
		index("idx_merch_variants_work").on(table.workId),
	],
);

/**
 * org — what became of one merch purchase on Printful's side.
 *
 * Written by the completion path when the order is placed and rewritten by the webhook
 * receiver as status events arrive (each event re-reads the order from Printful's API
 * first — the receiver treats a webhook as a hint, never as truth). The `events` column
 * is the append-only log of what Printful reported and when, so the buyer-facing
 * "shipped" state and the internal troubleshooting both read one record.
 *
 * ⚠️ **One row per purchase, and it is never the financial record.** Nothing on this
 * table is a dollar figure.
 *
 * 🚨 **`purchase_id` is `set null`, not cascade, like every neighbor of `purchases`**: the
 * fulfillment record of what Printful shipped is a fact about Anthers' own operations,
 * not about the buyer, and it outlives the account that bought it the same way the
 * purchase row does.
 */
// org — fulfillment state of Anthers' own sales is the platform's operational record.
export const merchFulfillments = pgTable(
	"merch_fulfillments",
	{
		id: serial("id").primaryKey(),
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		/** Printful's order id, null until the order is placed. */
		printfulOrderId: integer("printful_order_id"),
		/** Printful's own order status — draft, inreview, pending, inprocess, fulfilled, onhold, failed, canceled. */
		printfulStatus: text("printful_status"),
		/** When the order was placed with Printful, null on a purchase whose placement is still owed. */
		placedAt: timestamp("placed_at", { withTimezone: true }),
		/** Retry bookkeeping for the placement sweep: null once placed, else why the last attempt failed. */
		placementError: text("placement_error"),
		placementAttempts: integer("placement_attempts").notNull().default(0),
		/**
		 * The append-only event log: `{ type, occurredAt, note }` entries —
		 * `order_placed`, `package_shipped` (with the tracking url), `order_failed`,
		 * `order_canceled`, and Printful's other states as they arrive.
		 */
		events: jsonb("events")
			.$type<Array<{ type: string; occurredAt: string; note?: string }>>()
			.notNull()
			.default([]),
		/** The buyer-facing tracking url, from a `package_shipped` event. */
		trackingUrl: text("tracking_url"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// At most one fulfillment per purchase — a Printful order is placed once and then
		// updated in place; a re-place replaces the same row rather than adding one.
		uniqueIndex("uq_merch_fulfillments_purchase").on(table.purchaseId),
		// The webhook receiver's lookup: an event names a Printful order id, which names
		// the fulfillment row it belongs to.
		index("idx_merch_fulfillments_order").on(table.printfulOrderId),
	],
);

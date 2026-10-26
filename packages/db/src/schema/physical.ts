// SPDX-License-Identifier: Apache-2.0
/**
 * A physical Work's listing — what a creator sells, ships and charges for, and nothing
 * about the order.
 *
 * The Work already carries the title, the description, the art and the price; what a good
 * needs beyond that is where it ships from, how long it takes to leave, what it is for
 * tax, and whatever choices a buyer makes before paying. Those are facts about selling
 * rather than about the thing, which is why they sit beside the Work rather than on it:
 * a digital Work has no shipping price, and a column nobody fills is a column every
 * reader has to wonder about.
 *
 * ⚠️ **The price is the Work's, not this table's.** A physical good is priced by the same
 * access row a digital Work uses, so `resolvePurchase` needs no new branch to know what to
 * charge, and the creator's existing price editor already edits it. What lives here is the
 * shipping line the price does not include, because shipping is the creator's cost passed
 * through rather than part of what the good is worth.
 *
 * 🚨 **`options` is a shape, not a schema.** A creator's choices are a short ordered list
 * of names with values — size, color, scent — and a table per level would be three joins
 * to render one picker. It is validated on write (`services/physical-listings.ts`) and
 * read as a whole, and a null `stock` means "as many as I can make" rather than zero.
 */
import { integer, jsonb, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { works } from "./content.js";

/** One choice a buyer makes: its name, and the values under it. */
export interface PhysicalOptionValue {
	label: string;
	/** How many are left, or null for unlimited. */
	stock: number | null;
}
export interface PhysicalOption {
	name: string;
	values: PhysicalOptionValue[];
}

// org — a listing is the platform's selling machinery for one creator's good; the carrier
// and the stock are the creator's facts, held here to run a sale.
export const physicalListings = pgTable("physical_listings", {
	id: serial("id").primaryKey(),
	/** The Work being sold. One listing per Work, and a re-save replaces it. */
	workId: integer("work_id")
		.notNull()
		.unique()
		.references(() => works.id, { onDelete: "cascade" }),
	/**
	 * The shipping line, per order rather than per item — a creator charges what a parcel
	 * costs them, and two of one good still go in one box. `0.00` is free shipping, which
	 * is the creator's choice to make and reads as a stated fact rather than as missing
	 * data.
	 */
	shippingPrice: numeric("shipping_price").notNull().default("0.00"),
	/** How long this good takes to leave, in business days. Clamped into the offered range. */
	handlingBusinessDays: integer("handling_business_days").notNull().default(3),
	/** Which tax category the good falls under — a key into `PHYSICAL_TAX_CATEGORIES`. */
	taxCategory: text("tax_category").notNull().default("general"),
	/** The buyer's choices, in the creator's order. Empty for a good with no choices. */
	options: jsonb("options").$type<PhysicalOption[]>().notNull().default([]),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

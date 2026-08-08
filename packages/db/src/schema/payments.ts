// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	bigint,
	boolean,
	index,
	integer,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { works } from "./content.js";

export const stripeAccounts = pgTable("stripe_accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	stripeAccountId: text("stripe_account_id").notNull().unique(),
	chargesEnabled: boolean("charges_enabled").default(false),
	payoutsEnabled: boolean("payouts_enabled").default(false),
	onboardingComplete: boolean("onboarding_complete").default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Decimal columns are stored as numeric to preserve decimal.js precision (app owns rounding).
export const purchases = pgTable(
	"purchases",
	{
		id: serial("id").primaryKey(),
		buyerId: integer("buyer_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// What was bought. A purchase unlocks a **Work**, not a Post — access moved onto the
		// Work in `0010`, and a permanent unlock has to name the thing it unlocks. Null for
		// one-time charges that aren't a Work purchase (e.g. a Seed buy).
		//
		// SET NULL, not cascade (`0016`). It was cascade, which meant a creator deleting a
		// Work destroyed every row here that named it — the buyer's entitlement, the
		// financial record, and the `sales_tax` figure that makes remittance reportable.
		// A receipt is not a detail of the thing bought; it outlives it, the same way
		// moderation records outlive the account they concern.
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		// Who was paid. Denormalised deliberately, because it used to be reachable ONLY by
		// joining `works` — so a deleted Work took the seller's identity with it and the
		// sale silently left that creator's own earnings maths (`calculate-crf` joined
		// through `works` to get here). Null for charges with no creator side (a Seed buy).
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// A snapshot of what was bought, as it was at the time of sale. These are NOT a
		// cache of the Work — they are what the row still says after the Work is gone, and
		// they deliberately do not track later edits: a receipt records the transaction as
		// it happened, not the current state of the catalogue.
		workTitle: text("work_title"),
		workType: text("work_type"),
		workPublicId: bigint("work_public_id", { mode: "number" }),
		type: text("type").notNull().default("digital"), // digital | physical | service | seeds
		amount: numeric("amount").notNull(),
		processingFee: numeric("processing_fee").notNull(),
		deliveryFee: numeric("delivery_fee").notNull().default("0.00"), // download bandwidth (digital only)
		crfFee: numeric("crf_fee").notNull(), // Legacy column name; stores the retired purchase fee; always 0 since 2026-08-03
		// Sales tax is the ONE thing added on top of the list price, so it is money we
		// collect and owe onward rather than money anyone here keeps. Recording it
		// per-transaction is what makes remittance reportable; without the column the tax
		// was charged inside `buyer_total` and then unrecoverable from the row. Defaults
		// to 0.00 for the charges that carry none (a Seed buy).
		salesTax: numeric("sales_tax").notNull().default("0.00"),
		creatorEarnings: numeric("creator_earnings").notNull(),
		stripePaymentIntentId: text("stripe_payment_intent_id").notNull().unique(),
		status: text("status").notNull().default("pending"), // pending | completed | failed | refunded
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	// resolveAccess treats a completed purchase as a permanent unlock, so (buyer, work)
	// is read on every gated view — and neither column was indexed until `0015`.
	(table) => [
		index("idx_purchases_buyer").on(table.buyerId),
		index("idx_purchases_work").on(table.workId),
		// creator_id arrives already indexed: it is what calculate-crf now sums by, and
		// an unindexed FK is the exact debt `0015` was written to clear.
		index("idx_purchases_creator").on(table.creatorId),
	],
);

export const crfLedger = pgTable(
	"crf_ledger",
	{
		id: serial("id").primaryKey(),
		amount: numeric("amount").notNull(),
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		description: text("description").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_crf_ledger_purchase").on(table.purchaseId)],
);

// billingCycle is stored as an ISO date string (YYYY-MM-DD) — first of the month.
export const crfSubsidies = pgTable(
	"crf_subsidies",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(),
		estimatedHostingCost: numeric("estimated_hosting_cost").notNull(),
		creatorEarnings: numeric("creator_earnings").notNull(),
		subsidyAmount: numeric("subsidy_amount").notNull(),
		// Byte counts can exceed 2^31 — bigint, not integer.
		storageBytes: bigint("storage_bytes", { mode: "number" }).default(0),
		projectCount: integer("project_count").default(0),
		postCount: integer("post_count").default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_crf_subsidies_creator_cycle").on(table.creatorId, table.billingCycle),
	],
);

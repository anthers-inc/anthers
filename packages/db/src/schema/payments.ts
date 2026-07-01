// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	bigint,
	boolean,
	integer,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./content.js";

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
export const purchases = pgTable("purchases", {
	id: serial("id").primaryKey(),
	buyerId: integer("buyer_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	amount: numeric("amount").notNull(),
	processingFee: numeric("processing_fee").notNull(),
	crfFee: numeric("crf_fee").notNull(), // Legacy column name; stores Anthers Foundation Fee amount
	creatorEarnings: numeric("creator_earnings").notNull(),
	stripePaymentIntentId: text("stripe_payment_intent_id").notNull().unique(),
	status: text("status").notNull().default("pending"), // pending | completed | failed | refunded
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crfLedger = pgTable("crf_ledger", {
	id: serial("id").primaryKey(),
	amount: numeric("amount").notNull(),
	purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
	description: text("description").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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

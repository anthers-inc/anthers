import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { projects } from "./content.js";

export const stripeAccounts = sqliteTable("stripe_accounts", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	stripeAccountId: text("stripe_account_id").notNull().unique(),
	chargesEnabled: integer("charges_enabled", { mode: "boolean" }).default(false),
	payoutsEnabled: integer("payouts_enabled", { mode: "boolean" }).default(false),
	onboardingComplete: integer("onboarding_complete", { mode: "boolean" }).default(false),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

// Decimal columns are stored as text to preserve decimal.js precision.
export const purchases = sqliteTable("purchases", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	buyerId: integer("buyer_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	amount: text("amount").notNull(),
	processingFee: text("processing_fee").notNull(),
	crfFee: text("crf_fee").notNull(), // Legacy column name; stores Anthers Foundation Fee amount
	creatorEarnings: text("creator_earnings").notNull(),
	stripePaymentIntentId: text("stripe_payment_intent_id").notNull().unique(),
	status: text("status").notNull().default("pending"), // pending | completed | failed | refunded
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const crfLedger = sqliteTable("crf_ledger", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	amount: text("amount").notNull(),
	purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
	description: text("description").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

// billingCycle is stored as an ISO date string (YYYY-MM-DD) — first of the month.
export const crfSubsidies = sqliteTable(
	"crf_subsidies",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(),
		estimatedHostingCost: text("estimated_hosting_cost").notNull(),
		creatorEarnings: text("creator_earnings").notNull(),
		subsidyAmount: text("subsidy_amount").notNull(),
		storageBytes: integer("storage_bytes").default(0),
		projectCount: integer("project_count").default(0),
		postCount: integer("post_count").default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("uq_crf_subsidies_creator_cycle").on(table.creatorId, table.billingCycle),
	],
);

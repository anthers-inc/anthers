import {
	bigint,
	boolean,
	date,
	integer,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./content.js";

export const stripeAccounts = pgTable("stripe_accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	stripeAccountId: varchar("stripe_account_id", { length: 255 }).notNull().unique(),
	chargesEnabled: boolean("charges_enabled").default(false),
	payoutsEnabled: boolean("payouts_enabled").default(false),
	onboardingComplete: boolean("onboarding_complete").default(false),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const purchases = pgTable("purchases", {
	id: serial("id").primaryKey(),
	buyerId: integer("buyer_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	amount: numeric("amount", { precision: 8, scale: 2 }).notNull(),
	processingFee: numeric("processing_fee", { precision: 8, scale: 2 }).notNull(),
	crfFee: numeric("crf_fee", { precision: 8, scale: 2 }).notNull(),
	creatorEarnings: numeric("creator_earnings", { precision: 8, scale: 2 }).notNull(),
	stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }).notNull().unique(),
	status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | completed | failed | refunded
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const crfLedger = pgTable("crf_ledger", {
	id: serial("id").primaryKey(),
	amount: numeric("amount", { precision: 8, scale: 2 }).notNull(),
	purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
	description: varchar("description", { length: 500 }).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crfSubsidies = pgTable(
	"crf_subsidies",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: date("billing_cycle").notNull(),
		estimatedHostingCost: numeric("estimated_hosting_cost", { precision: 8, scale: 2 }).notNull(),
		creatorEarnings: numeric("creator_earnings", { precision: 8, scale: 2 }).notNull(),
		subsidyAmount: numeric("subsidy_amount", { precision: 8, scale: 2 }).notNull(),
		storageBytes: bigint("storage_bytes", { mode: "number" }).default(0),
		projectCount: integer("project_count").default(0),
		postCount: integer("post_count").default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_crf_subsidies_creator_cycle").on(table.creatorId, table.billingCycle),
	],
);

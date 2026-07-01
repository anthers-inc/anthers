// SPDX-License-Identifier: AGPL-3.0-or-later
import {
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
import { posts, projects } from "./content.js";

export const subscriptions = pgTable("subscriptions", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	tier: text("tier").notNull().default("free"), // free | root | sprout | petal | bloom
	fundingLevel: integer("funding_level").notNull().default(0), // actual monthly funding in whole dollars
	stripeCustomerId: text("stripe_customer_id").default(""),
	stripeSubscriptionId: text("stripe_subscription_id").default(""),
	isActive: boolean("is_active").default(true),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
	canceledAt: timestamp("canceled_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const attentionEvents = pgTable(
	"attention_events",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "set null" }),
		eventType: text("event_type").notNull(), // page_view | play | watch | read | listen
		durationSeconds: integer("duration_seconds").default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_attention_user_date").on(table.userId, table.createdAt),
		index("idx_attention_creator_date").on(table.creatorId, table.createdAt),
	],
);

// billingCycle is stored as an ISO date string (YYYY-MM-DD) — first of the month.
export const boostAllocations = pgTable(
	"boost_allocations",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		amount: numeric("amount").notNull(),
		billingCycle: text("billing_cycle").notNull(),
		isLocked: boolean("is_locked").default(false),
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_boost_user_creator_cycle").on(
			table.userId,
			table.creatorId,
			table.billingCycle,
		),
	],
);

export const poolDistributions = pgTable(
	"pool_distributions",
	{
		id: serial("id").primaryKey(),
		subscriberId: integer("subscriber_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(),
		poolAmount: numeric("pool_amount").notNull().default("0.00"),
		boostAmount: numeric("boost_amount").notNull().default("0.00"),
		attentionSeconds: integer("attention_seconds").default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_pool_dist_sub_creator_cycle").on(
			table.subscriberId,
			table.creatorId,
			table.billingCycle,
		),
	],
);

export const creatorGates = pgTable("creator_gates", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	gateType: text("gate_type").notNull().default("boost"), // "boost" | "anthers_tier"
	threshold: numeric("threshold").notNull(),
	label: text("label").notNull(),
	description: text("description").default(""),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

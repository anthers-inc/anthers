import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { posts, projects } from "./content.js";

export const subscriptions = sqliteTable("subscriptions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	tier: text("tier").notNull().default("free"), // free | root | sprout | petal | bloom
	fundingLevel: integer("funding_level").notNull().default(0), // actual monthly funding in whole dollars
	stripeCustomerId: text("stripe_customer_id").default(""),
	stripeSubscriptionId: text("stripe_subscription_id").default(""),
	isActive: integer("is_active", { mode: "boolean" }).default(true),
	currentPeriodStart: integer("current_period_start", { mode: "timestamp_ms" }),
	currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
	canceledAt: integer("canceled_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const attentionEvents = sqliteTable(
	"attention_events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
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
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [
		index("idx_attention_user_date").on(table.userId, table.createdAt),
		index("idx_attention_creator_date").on(table.creatorId, table.createdAt),
	],
);

// billingCycle is stored as an ISO date string (YYYY-MM-DD) — first of the month.
export const boostAllocations = sqliteTable(
	"boost_allocations",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		amount: text("amount").notNull(),
		billingCycle: text("billing_cycle").notNull(),
		isLocked: integer("is_locked", { mode: "boolean" }).default(false),
		atprotoUri: text("atproto_uri").unique(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("uq_boost_user_creator_cycle").on(
			table.userId,
			table.creatorId,
			table.billingCycle,
		),
	],
);

export const poolDistributions = sqliteTable(
	"pool_distributions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		subscriberId: integer("subscriber_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(),
		poolAmount: text("pool_amount").notNull().default("0.00"),
		boostAmount: text("boost_amount").notNull().default("0.00"),
		attentionSeconds: integer("attention_seconds").default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("uq_pool_dist_sub_creator_cycle").on(
			table.subscriberId,
			table.creatorId,
			table.billingCycle,
		),
	],
);

export const creatorGates = sqliteTable("creator_gates", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	gateType: text("gate_type").notNull().default("boost"), // "boost" | "anthers_tier"
	threshold: text("threshold").notNull(),
	label: text("label").notNull(),
	description: text("description").default(""),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

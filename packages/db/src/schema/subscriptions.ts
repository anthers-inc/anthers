import {
	boolean,
	date,
	index,
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
import { projects, posts } from "./content.js";

export const subscriptions = pgTable("subscriptions", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	tier: varchar("tier", { length: 20 }).notNull().default("free"), // free | root | sprout | petal | bloom
	fundingLevel: integer("funding_level").notNull().default(0), // actual monthly funding in whole dollars
	stripeCustomerId: varchar("stripe_customer_id", { length: 255 }).default(""),
	stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }).default(""),
	isActive: boolean("is_active").default(true),
	currentPeriodStart: timestamp("current_period_start"),
	currentPeriodEnd: timestamp("current_period_end"),
	canceledAt: timestamp("canceled_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
		eventType: varchar("event_type", { length: 20 }).notNull(), // page_view | play | watch | read | listen
		durationSeconds: integer("duration_seconds").default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("idx_attention_user_date").on(table.userId, table.createdAt),
		index("idx_attention_creator_date").on(table.creatorId, table.createdAt),
	],
);

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
		amount: numeric("amount", { precision: 8, scale: 2 }).notNull(),
		billingCycle: date("billing_cycle").notNull(),
		isLocked: boolean("is_locked").default(false),
		atprotoUri: varchar("atproto_uri", { length: 512 }).unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
		billingCycle: date("billing_cycle").notNull(),
		poolAmount: numeric("pool_amount", { precision: 8, scale: 2 }).notNull().default("0.00"),
		boostAmount: numeric("boost_amount", { precision: 8, scale: 2 }).notNull().default("0.00"),
		attentionSeconds: integer("attention_seconds").default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
	gateType: varchar("gate_type", { length: 20 }).notNull().default("boost"), // "boost" | "anthers_tier"
	threshold: numeric("threshold", { precision: 5, scale: 2 }).notNull(),
	label: varchar("label", { length: 100 }).notNull(),
	description: text("description").default(""),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

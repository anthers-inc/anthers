// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Support-model economics schema. A user holds an `account` with a count of
 * **Anthers-Seeds** (`anthersSeeds`) — that count IS their rank (0 = free … 4 =
 * blossom, "+" beyond) and, at $3 each, their Anthers subscription. Each
 * Anthers-Seed covers the user's streaming (at cost, folded in — no wallet),
 * funds the Time Pool, and leaves a remainder for the Foundation. Directed
 * (creator) Seeds are tracked per-creator in `seed_allocations`. This file also
 * holds the shared economics tables: time (attention) events, pool
 * distributions, and creator gates.
 */
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
import { posts } from "./content.js";

/**
 * A user's standing account (one per user). `anthersSeeds` is the count of
 * Anthers-Seeds held (rank = min(anthersSeeds, 4); count also drives billing at
 * $3/Seed). `creatorSeedTotal` is the $ of directed creator-Seeds this cycle
 * (denormalised sum of `seed_allocations`). `bandwidthUsedGiB` is the running
 * stream consumption this cycle, drawn at cost against the Seed allowance
 * (15 GiB floor + 60 GiB per Anthers-Seed). There is no bandwidth wallet.
 */
export const accounts = pgTable("accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	anthersSeeds: integer("anthers_seeds").notNull().default(0), // count → rank + $3/Seed billing
	creatorSeedTotal: numeric("creator_seed_total").notNull().default("0.00"), // $ directed to creators this cycle
	bandwidthUsedGiB: numeric("bandwidth_used_gib").notNull().default("0"), // stream GiB consumed this cycle
	isSelfHosting: boolean("is_self_hosting").notNull().default(false), // creator self-hosts → flat fee, no storage AFF
	stripeCustomerId: text("stripe_customer_id").default(""),
	stripeSubscriptionId: text("stripe_subscription_id").default(""), // active Anthers-Seed subscription
	isActive: boolean("is_active").default(true),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
	canceledAt: timestamp("canceled_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-cycle economic snapshot — one row per (user, cycle) — kept for spend and
 * consumption history/analytics. Records the Anthers-Seeds held and what flowed:
 * Time Pool (to creators), the Foundation remainder, and stream consumption.
 */
export const accountCycles = pgTable(
	"account_cycles",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(), // YYYY-MM-01
		anthersSeeds: integer("anthers_seeds").notNull().default(0), // Anthers-Seeds held this cycle
		anthersSpend: numeric("anthers_spend").notNull().default("0.00"), // $ on Anthers-Seeds (count × $3)
		creatorSeedTotal: numeric("creator_seed_total").notNull().default("0.00"), // $ directed to creators
		timePool: numeric("time_pool").notNull().default("0.00"), // Time Pool budget this cycle
		foundation: numeric("foundation").notNull().default("0.00"), // Foundation remainder this cycle
		bandwidthUsedGiB: numeric("bandwidth_used_gib").notNull().default("0"), // stream GiB consumed
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_account_cycles_user_cycle").on(table.userId, table.billingCycle)],
);

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
// A user's DIRECTED Seeds — $3 Seeds the user has given to a creator (unlocking
// that creator's Seed Gates). The account's `creatorSeedTotal` is the sum of these.
export const seedAllocations = pgTable(
	"seed_allocations",
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
		uniqueIndex("uq_seed_user_creator_cycle").on(table.userId, table.creatorId, table.billingCycle),
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
		poolAmount: numeric("pool_amount").notNull().default("0.00"), // Time Pool share
		seedAmount: numeric("seed_amount").notNull().default("0.00"), // directed-Seed share
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

/**
 * Creator-defined gate ladder — the creator's *named* rungs.
 *
 * `threshold` is **whole Seeds for both gate types** (unified in migration `0007`, which
 * divided the `seed` rungs by 3). `seed` rungs read the Seeds directed to this creator
 * this cycle; `anthers_badge` rungs read the viewer's *currently held* Anthers-Seed count.
 * One unit, one comparison — the direction is the only difference.
 *
 * The `seed` rungs previously counted dollars, which meant the price of a Seed was baked
 * into every stored gate and the same concept was spelled two ways across this table and
 * `posts.seed_access`. Naming the rungs is this table's job; deciding a post's access is
 * `posts.seed_access`'s, and a post may gate at a threshold no rung is named for.
 */
export const creatorGates = pgTable(
	"creator_gates",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		gateType: text("gate_type").notNull().default("seed"), // "seed" | "anthers_badge"
		threshold: numeric("threshold").notNull(), // whole Seeds, both gate types
		label: text("label").notNull(),
		description: text("description").default(""),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_creator_gates_creator").on(table.creatorId, table.sortOrder)],
);

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * V4 economics schema (the "Big Rethink" model). A user holds an `account` and
 * *chooses* a Badge plan (free/root/sprout/petal/blossom) — the badge is stored
 * point-in-time, not derived from spend. Bandwidth is a separate at-cost wallet
 * with a per-tier free monthly allowance. This file also holds the shared
 * economics tables: time (attention) events, Seed allocations, pool
 * distributions, the bandwidth-wallet ledger, and creator gates.
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
 * A user's standing account (one per user). `badge` is the *chosen* plan, held
 * point-in-time. `walletBalance` is the prepaid bandwidth wallet (dollars);
 * `bandwidthUsedGiB` is the running stream consumption this cycle, drawn against
 * the badge's free monthly allowance first and then the wallet. `seedTotal` is
 * the user's Seeds this cycle (badge-included + purchased). The per-tier free
 * allowance is derived from the badge (`BADGE_PLANS[badge].freeBwGiB`), not stored.
 */
export const accounts = pgTable("accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	badge: text("badge").notNull().default("free"), // chosen plan: free|root|sprout|petal|blossom
	walletBalance: numeric("wallet_balance").notNull().default("0.00"), // prepaid bandwidth wallet ($)
	bandwidthUsedGiB: numeric("bandwidth_used_gib").notNull().default("0"), // stream GiB consumed this cycle
	seedTotal: numeric("seed_total").notNull().default("0.00"), // total Seeds this cycle ($ = qty × $1)
	autoTopupEnabled: boolean("auto_topup_enabled").notNull().default(false),
	autoTopupAmount: numeric("auto_topup_amount").notNull().default("5.00"), // $ added per auto top-up
	autoTopupThreshold: numeric("auto_topup_threshold").notNull().default("2.00"), // top up when wallet < this
	isSelfHosting: boolean("is_self_hosting").notNull().default(false), // creator self-hosts → flat fee, no storage AFF
	stripeCustomerId: text("stripe_customer_id").default(""),
	isActive: boolean("is_active").default(true),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
	canceledAt: timestamp("canceled_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-cycle economic snapshot — one row per (user, cycle) — kept for spend and
 * consumption history/analytics. In V4 the badge is chosen, so this no longer
 * drives it; it simply records the plan the user held and what flowed that cycle.
 */
export const accountCycles = pgTable(
	"account_cycles",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(), // YYYY-MM-01
		badge: text("badge").notNull().default("free"), // badge held this cycle
		planPrice: numeric("plan_price").notNull().default("0.00"), // badge price paid this cycle
		timePool: numeric("time_pool").notNull().default("0.00"), // Time Pool budget this cycle
		seedTotal: numeric("seed_total").notNull().default("0.00"), // Seeds this cycle ($)
		communityShare: numeric("community_share").notNull().default("0.00"), // to the Foundation
		bandwidthUsedGiB: numeric("bandwidth_used_gib").notNull().default("0"), // stream GiB consumed
		walletSpend: numeric("wallet_spend").notNull().default("0.00"), // bandwidth $ charged to wallet
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_account_cycles_user_cycle").on(table.userId, table.billingCycle)],
);

/**
 * The bandwidth-wallet ledger. The wallet is a prepaid, at-cost balance that
 * covers streaming beyond the badge's free monthly allowance. `delta` is + on a
 * top-up/refund, − on a stream debit. Direct-download bandwidth is folded into
 * the purchase price (Digital AFF) and never touches this wallet.
 */
export const walletLedger = pgTable(
	"wallet_ledger",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		delta: numeric("delta").notNull(), // + top-up/refund, − stream debit
		reason: text("reason").notNull(), // "topup" | "auto_topup" | "stream" | "refund"
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_wallet_user_date").on(table.userId, table.createdAt)],
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
// The DIRECTED portion of a user's Seeds — badge-included and purchased Seeds the
// user has assigned to a creator (unlocking that creator's Seed Gates). Undirected
// Seeds = account.seedTotal − Σ directed.
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
		seedAmount: numeric("seed_amount").notNull().default("0.00"), // Seeds share
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
 * Creator-defined gate ladder. `seed` rungs populate the Seed Access table
 * (`threshold` = dollars of Seeds given to the creator this cycle); `anthers_badge`
 * rungs are the Anthers Gate, unlocked by the viewer *currently holding* the
 * required badge (`threshold` = badge rank, 1 = root … 4 = blossom).
 */
export const creatorGates = pgTable(
	"creator_gates",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		gateType: text("gate_type").notNull().default("seed"), // "seed" | "anthers_badge"
		threshold: numeric("threshold").notNull(), // seed: $ of Seeds; anthers_badge: badge rank 1–4
		label: text("label").notNull(),
		description: text("description").default(""),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_creator_gates_creator").on(table.creatorId, table.sortOrder)],
);

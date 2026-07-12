// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * V3 economics schema. Users don't subscribe to a tier — they hold an `account`
 * and make two prepaid, per-cycle choices: a Usage level (GiB) and a total Boost
 * ($). Their Anthers Badge is *derived* from combined spend across the trailing
 * cycles recorded in `accountCycles`. This file also holds the shared economics
 * tables: time (attention) events, boost allocations, pool distributions, the
 * re-download wallet ledger, and creator gates.
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
 * A user's standing spend account (one per user). Usage and total Boost are the
 * *current cycle's* prepaid levels; the per-cycle history in `accountCycles` is
 * the ledger that drives the rolling Badge. The free 3 GiB usage allowance is a
 * constant, not stored here.
 */
export const accounts = pgTable("accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	usageGiB: integer("usage_gib").notNull().default(0), // current-cycle prepaid Usage level (paid GiB)
	boostTotal: numeric("boost_total").notNull().default("0.00"), // current-cycle total Boost $ (directed + undirected)
	redownloadBalance: numeric("redownload_balance").notNull().default("0.00"), // separate depleting re-download wallet
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
 * Per-cycle prepaid spend ledger — one row per (user, cycle). The Badge is the
 * highest threshold cleared by `totalSpend` across the trailing 3 cycles. The
 * current cycle's row mirrors the levels on `accounts`.
 */
export const accountCycles = pgTable(
	"account_cycles",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(), // YYYY-MM-01
		usageGiB: integer("usage_gib").notNull().default(0),
		boostTotal: numeric("boost_total").notNull().default("0.00"),
		usageSpend: numeric("usage_spend").notNull().default("0.00"), // usageGiB × $0.03
		boostSpend: numeric("boost_spend").notNull().default("0.00"), // == boostTotal
		totalSpend: numeric("total_spend").notNull().default("0.00"), // usageSpend + boostSpend (Badge basis)
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_account_cycles_user_cycle").on(table.userId, table.billingCycle)],
);

/**
 * The re-download wallet ledger — a small prepaid balance, kept OFF the streaming
 * Usage allowance so a zero-watch-time download never distorts Time-Pool
 * distribution. `delta` is + on top-up/refund, − on a re-download debit.
 */
export const redownloadLedger = pgTable(
	"redownload_ledger",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		delta: numeric("delta").notNull(), // + top-up/refund, − re-download debit
		reason: text("reason").notNull(), // "topup" | "redownload" | "refund"
		postId: integer("post_id").references(() => posts.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_redownload_user_date").on(table.userId, table.createdAt)],
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
// The DIRECTED portion of a user's Boost; undirected boost = account.boostTotal − Σ directed.
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

/**
 * Creator-defined gate ladder. `boost` rungs populate the Boost Access table;
 * `anthers_badge` rungs are the Anthers Gate — unlocked by the viewer's rolling
 * Badge spend (the `threshold` is the Badge's min combined-spend $).
 */
export const creatorGates = pgTable(
	"creator_gates",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		gateType: text("gate_type").notNull().default("boost"), // "boost" | "anthers_badge"
		threshold: numeric("threshold").notNull(),
		label: text("label").notNull(),
		description: text("description").default(""),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_creator_gates_creator").on(table.creatorId, table.sortOrder)],
);

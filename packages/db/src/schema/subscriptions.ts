// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Support-model economics schema. A user holds an `account` carrying a **monthly amount
 * in dollars** given to Anthers (`anthersSupport`) — that amount IS their Badge (Root $3
 * / Sprout $6 / Petal $9 / Blossom $12, "+" beyond) and their Anthers subscription. Half
 * of it funds the **Time Pool**; the rest pays its share of the at-cost Payments line and
 * leaves a **remainder** funding free access and the charitable programs. What a user
 * directs at individual creators is tracked per-creator in `seed_allocations`. This file
 * also holds the shared economics tables: time (attention) events, pool distributions,
 * and creator gates.
 *
 * ⚠️ **This header described the retired model until 2026-08-19**, naming a *count* of
 * "Anthers-Seeds" at $3 each, a "rank", and streaming folded in at cost against no
 * wallet. Three of those mechanisms are gone (the unit, the rank noun, the bandwidth
 * line) — and it named **`anthersSeeds`**, a field that does not exist: the column is
 * `anthersSupport`, renamed when a count became an amount. A docblock naming a dead
 * identifier is worse than a dated one, because grepping the name it teaches finds
 * nothing at all.
 */
import { sql } from "drizzle-orm";
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
import { works } from "./content.js";

/**
 * A user's standing account (one per user). `anthersSupport` is the monthly amount in
 * dollars given to Anthers — it sets the Badge and drives billing directly, with no
 * count in between. `creatorSupportTotal` is the $ directed at creators this cycle
 * (denormalised sum of `seed_allocations`). `bandwidthUsedGiB` is a **dead column**:
 * it held the running stream consumption drawn against an allowance until 2026-08-12.
 * Delivery is free at any volume, nothing writes it, and it stays only because dropping
 * it is a migration of its own.
 */
export const accounts = pgTable("accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	anthersSupport: numeric("anthers_support").notNull().default("0.00"), // $/mo to Anthers → Badge + billing
	creatorSupportTotal: numeric("creator_support_total").notNull().default("0.00"), // $/mo directed to creators this cycle
	bandwidthUsedGiB: numeric("bandwidth_used_gib").notNull().default("0"), // DEAD since 2026-08-12
	isSelfHosting: boolean("is_self_hosting").notNull().default(false), // creator self-hosts → flat fee, no storage charge
	stripeCustomerId: text("stripe_customer_id").default(""),
	/**
	 * This creator's Stripe Product, for the line on a supporter's invoice.
	 *
	 * Lazily created the first time somebody supports them — a creator nobody supports
	 * needs no Product, and creating one eagerly would make signup depend on Stripe being
	 * reachable. See `services/billing.ts` for why a Product is needed at all.
	 */
	stripeProductId: text("stripe_product_id").default(""),
	stripeSubscriptionId: text("stripe_subscription_id").default(""), // active support subscription
	isActive: boolean("is_active").default(true),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
	canceledAt: timestamp("canceled_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-cycle economic snapshot — one row per (user, cycle) — kept for spend and
 * consumption history/analytics. Records the amount given to Anthers and what flowed:
 * Time Pool (to creators), the remainder, and stream consumption.
 */
export const accountCycles = pgTable(
	"account_cycles",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(), // YYYY-MM-01
		// 🚨 ONE column, not two. This carried `anthers_seeds` (a count) beside
		// `anthers_spend` (that count × $3) until 2026-08-16 — two descriptions of one fact,
		// which is the defect the whole Seed retirement is about. The count is gone and the
		// dollars are the record.
		anthersSupport: numeric("anthers_support").notNull().default("0.00"), // $/mo to Anthers this cycle
		creatorSupportTotal: numeric("creator_support_total").notNull().default("0.00"), // $ directed to creators
		timePool: numeric("time_pool").notNull().default("0.00"), // Time Pool budget this cycle
		foundation: numeric("foundation").notNull().default("0.00"), // remainder this cycle
		bandwidthUsedGiB: numeric("bandwidth_used_gib").notNull().default("0"), // DEAD since 2026-08-12
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
		// Time is earned by a **Work**, never by a post. A post is connective tissue and
		// earns nothing (40.05), which used to be a policy the endpoint enforced against a
		// schema that couldn't express it; now the column says so. Null only on
		// zero-duration visit pings, which are analytics and credit nothing.
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		eventType: text("event_type").notNull(), // page_view | play | watch | read | listen
		durationSeconds: integer("duration_seconds").default(0),
		/**
		 * Was this Work **Public Access** — ungated and streaming, free to everyone — at
		 * the moment the seconds were watched?
		 *
		 * 🚨 **Stamped at the write boundary, never re-derived on read**, and that is the
		 * whole point of the column. A Work's access can change after the fact: a creator
		 * may gate something they had left open, or open something they had gated. Reading
		 * today's access to decide what a viewer consumed last week gets it wrong in both
		 * directions — and one of those directions is harmful, because it would charge a
		 * supporter's free allowance for gated work they had actually paid a creator to
		 * reach.
		 *
		 * Same discipline as attention eligibility itself: decided once, where the fact is
		 * known, so no later reader can apply a different rule. `distribute-pool`
		 * deliberately applies no filter of its own for the same reason.
		 */
		publicAccess: boolean("public_access").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_attention_user_date").on(table.userId, table.createdAt),
		index("idx_attention_creator_date").on(table.creatorId, table.createdAt),
		// work_id is ON DELETE SET NULL: deleting a Work rewrites every event naming it.
		index("idx_attention_work").on(table.workId),
	],
);

/**
 * What survives when the raw attention rows are deleted — per (creator, Work, day,
 * event type) totals, with **no `user_id` column at all.**
 *
 * That absence is the whole design. 51.05 promises that raw records connecting a
 * person to a Work are kept only until their billing cycle has settled and the
 * card-dispute window has closed, after which they are *"aggregated into per-Work and
 * per-creator totals and the per-person records are deleted"* — so a complete history
 * of what someone personally watched stops existing. A rollup table that kept the
 * column "just in case" would make that sentence false, and the way to be sure it
 * can't happen is for the column not to be there.
 *
 * It also has to carry creator analytics forward. Analytics read raw events today and
 * accept a `period` of up to a year; once pruning starts, anything older than the
 * retention window would silently read as zero. So the analytics endpoints union raw
 * and rolled-up, and the creator's history is preserved at the granularity the policy
 * says they keep — per Work, per day — rather than lost along with the identities.
 *
 * `uniqueViewers` is stored per day and **cannot be summed across days** without
 * counting a returning viewer twice, which is a real limit of holding no identities:
 * the number is genuinely unrecoverable once the rows are gone. The analytics layer
 * reports unique viewers over the raw window only, and says which window that is,
 * rather than adding daily counts together and calling the total unique.
 */
export const attentionDaily = pgTable(
	"attention_daily",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Null where the underlying events had no Work (zero-duration visit pings), and
		// where a Work was deleted after the fact — `attention_events.work_id` is
		// ON DELETE SET NULL, so a rollup can inherit a null.
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		/** UTC calendar day, ISO `YYYY-MM-DD`, matching the analytics grouping. */
		day: text("day").notNull(),
		eventType: text("event_type").notNull(),
		eventCount: integer("event_count").notNull().default(0),
		totalSeconds: integer("total_seconds").notNull().default(0),
		/** Distinct viewers **on that day**. Not summable across days — see the note. */
		uniqueViewers: integer("unique_viewers").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The prune job upserts on this key, so re-running it over a day it already
		// rolled up updates rather than duplicates — which matters because the job
		// deletes the rows it summarised, and a crash between the two halves has to be
		// safe to retry.
		//
		// `COALESCE(work_id, -1)` rather than the bare column, and that is load-bearing.
		// Postgres treats NULLs as distinct in a unique index, so a plain key would let
		// every null-`work_id` row — visit pings, and any Work deleted after its events
		// were recorded — conflict with nothing, turning the upsert into an insert and
		// silently doubling those totals on a retry. `nullsNotDistinct` would say this
		// more directly but isn't in drizzle-orm 0.45's builder; the expression is
		// equivalent and works on any supported Postgres. `-1` is safe as a sentinel
		// because `works.id` is a positive serial.
		uniqueIndex("uq_attention_daily_key").on(
			table.creatorId,
			sql`COALESCE(${table.workId}, -1)`,
			table.day,
			table.eventType,
		),
		index("idx_attention_daily_creator_day").on(table.creatorId, table.day),
	],
);

// billingCycle is stored as an ISO date string (YYYY-MM-DD) — first of the month.
// A user's DIRECTED support — the monthly amount, in dollars, they have pointed at a
// creator, which clears that creator's Badges. The account's `creatorSupportTotal` is the
// sum of these. (The table name `seed_allocations` stays: it is a schema identifier whose
// meaning did not change, per the copy-rules-not-schema-rules norm.)
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
		// creatorId sits in the MIDDLE of the unique index, which cannot serve a lookup
		// by creator alone — the read behind "who gives me support".
		index("idx_seed_allocations_creator").on(table.creatorId),
	],
);

export const poolDistributions = pgTable(
	"pool_distributions",
	{
		id: serial("id").primaryKey(),
		// 🚨 BOTH are ON DELETE SET NULL, not cascade, and both are nullable — because this
		// row is a **payment record**, not a viewing one. 51.05 names it as the one thing
		// that survives account deletion ("a per-month total of how much time you spent
		// with each creator you supported"), and until 2026-08-12 a cascade on both sides
		// destroyed it. The creator side was the worse half: a creator closing their
		// account erased the payout records of everyone who had funded them — third
		// parties' financial records, deleted by someone else's action.
		//
		// Same shape as `purchases.buyer_id`: the person comes off the record, the record
		// stays. Erasure runs to personal data, and is satisfied by severing the identity
		// link rather than destroying the artifact.
		subscriberId: integer("subscriber_id").references(() => users.id, {
			onDelete: "set null",
		}),
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		billingCycle: text("billing_cycle").notNull(),
		poolAmount: numeric("pool_amount").notNull().default("0.00"), // Time Pool share
		seedAmount: numeric("seed_amount").notNull().default("0.00"), // directed-support share
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
		index("idx_pool_distributions_creator").on(table.creatorId),
	],
);

/**
 * Creator-defined gate ladder — the creator's *named* rungs.
 *
 * `threshold` is **monthly dollars**. `seed` rungs read what the viewer directs to this
 * creator this cycle; the direction is the only difference between gate types.
 *
 * 🚨 **It has been through both units and landed back on dollars, which is worth knowing
 * before anyone changes it again.** It counted dollars originally; migration `0007`
 * divided by 3 to store whole Seeds, because the price of a Seed was otherwise baked into
 * every stored gate. That reasoning died with the unit on 2026-08-16 — a creator sets
 * their own levels to any amount now, so there is no shared price to leak, and storing
 * Seeds would instead bake in a *conversion* that no longer means anything. Migration
 * `0041` multiplied back by 3.
 *
 * Naming the rungs is this table's job; deciding a Work's access is `works.seed_access`'s,
 * and a Work may gate at a threshold no rung is named for.
 */
export const creatorGates = pgTable(
	"creator_gates",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		gateType: text("gate_type").notNull().default("seed"), // "seed" | "anthers_badge"
		threshold: numeric("threshold").notNull(), // monthly $ required, both gate types
		label: text("label").notNull(),
		description: text("description").default(""),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_creator_gates_creator").on(table.creatorId, table.sortOrder)],
);

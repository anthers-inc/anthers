// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Support-model economics schema — see auth.ts for the role-classification legend.
 *
 * 🚨 This file is where the node/org boundary is *hardest* to draw, and most of it is
 * `org` by the treasury rule: 41.02 says "Payments, pools, payouts, KYC, charitable
 * accounting → Org only. Money cannot federate." A creator's *gates* (what they charge
 * for access) are the exception — those are the creator's own pricing, node-owned.
 *
 * `attentionEvents` is the table 41.02 predicts will be hardest to classify, and it
 * is: org-role by volume and by being pool-accounting input, node-role by being about
 * one creator's work. See the per-table comment and the findings in 41.02.
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
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
// org — a user's support account carries the billing relationship (Stripe customer,
// subscription, period). 41.02: "Payments, pools, payouts → Org only. Money cannot
// federate." The `isSelfHosting` flag is a creator-side claim but the org prices it.
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

	// ── Adult access (wiki 40.09 § The funding type is the age signal) ──
	// Three columns and no fourth, and the shortness is the design rather than a first
	// pass. Reaching the Adult rung needs the account-level opt-in AND a verification;
	// what is kept of the verification is that it happened, when, and by which method.
	//
	// 🚨 **There is no verification database, and no date of birth crosses our boundary.**
	// The method is the FUNDING TYPE of a card — card issuers require the primary
	// accountholder to be 18, so a credit-funded charge carries an age signal that a
	// payment on its own does not. We read Stripe's `funding`, keep the verdict, and keep
	// nothing about the card: no brand, no last4, no fingerprint, no funding value. That
	// is what satisfies the non-retention requirement state law puts on verifiers by
	// construction rather than by policy.
	//
	// ⚠️ **Never add a biometric method here.** Illinois BIPA, Texas CUBI and Washington's
	// MHMDA all penalize the collection rather than the purpose, and BIPA carries a
	// private right of action. Facial age estimation is out on those grounds and not on
	// preference.
	//
	// The reader's own choice — "do you ever want to be shown Adult work, anywhere?".
	// Separate from the verification because they answer different questions and either
	// can be true without the other: somebody may verify and later turn the setting off.
	adultOptIn: boolean("adult_opt_in").notNull().default(false),
	// When adulthood was verified, or null if it never has been. A timestamp rather than
	// a boolean so a method that later needs re-verifying has something to measure from.
	adultVerifiedAt: timestamp("adult_verified_at", { withTimezone: true }),
	// Which method did it — `card_funding` is the only value there is. Recorded rather
	// than assumed so that a second method, if one is ever built, does not make the
	// existing rows ambiguous about what was actually checked.
	adultVerifiedMethod: text("adult_verified_method"),

	// ── What the reader has asked to meet, per rung ──
	// `hide` | `blur` | `show`, and two columns rather than one because the two rungs get
	// SEPARATE controls. A reader who wants difficult work unblurred has said nothing about
	// whether they want explicit work at all, and one setting covering both would make them
	// say it (wiki 40.09).
	//
	// ⚠️ **The defaults live in `@anthers/shared/content-rating`, not here.** A signed-out
	// visitor has no row at all and must still get the Mature blur, so the default has to be
	// applied by whatever reads the preference rather than by the column — a column default
	// would be right for accounts and silently absent for everybody else. Null means "never
	// answered", which is what lets the shared default move without rewriting stored rows.
	matureDisplay: text("mature_display"),
	adultDisplay: text("adult_display"),

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
// org — a per-cycle economic snapshot, kept for org-side spend/consumption analytics.
// Money record; org-only.
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

// both — the table 41.02 predicts will resist classification, and does. Org-role by
// volume (the highest-write table, "Time-event ingestion → Org") and by being
// pool-accounting input. Node-role by being about *one creator's* work (`workId`,
// `creatorId`). The row's *subject* is node content; the row's *purpose* is org
// accounting. Classified `both` because neither half is decorative — the node needs
// to know a Work earned minutes, the org needs to distribute them. This is the finding
// to carry to 41.02: the boundary runs through the middle of this table, not between
// it and its neighbours.
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
		 * known, so no later reader can apply a different rule.
		 *
		 * 🚨 **Two readers depend on this flag and they must not diverge.** The Public
		 * Access meter (`services/public-access.ts`) spends a viewer's monthly allowance
		 * against it, and `distribute-pool` pays the Time Pool against it — because
		 * distributor-pays says the pool buys the commons and nothing else. Gated work the
		 * viewer cleared, work they bought, and their own catalogue are all `false` here
		 * and earn nothing from the pool; whoever cleared the gate or made the purchase
		 * already paid that creator in full, and paying again would dilute exactly the
		 * Public Access creators the pool exists for.
		 *
		 * ⚠️ **"Never re-derived" is not "never filtered", and reading it the second way is
		 * what caused the bug.** `distribute-pool` summed every row until 2026-08-26,
		 * having taken this note as licence to ignore the stamp rather than as an
		 * instruction not to recompute it. Filtering on the recorded value is the discipline
		 * working; joining back to `works` at distribution time is the thing forbidden.
		 */
		publicAccess: boolean("public_access").notNull().default(false),
		/**
		 * Did these seconds arrive through a **share link** rather than from the account
		 * named by `user_id`?
		 *
		 * 🚨 **`user_id` is the SHARER on these rows, not the person who watched**, and that
		 * is the point rather than an inaccuracy. A share-link viewer has no account, so the
		 * time is attributed to whoever shared the link — which is what makes it attributable
		 * at all, and the Time Pool cannot pay a creator for time it cannot attribute to
		 * anybody. Nothing here identifies the viewer, and nothing should: they are a stranger
		 * we deliberately did not ask to sign up.
		 *
		 * Two readers, drawing two different boundaries, and they are not the same boundary:
		 *
		 *   - The **share-link budget** (`services/public-access.ts`) counts every row with
		 *     this flag, `public_access` or not, because what it bounds is *relay volume* —
		 *     how much viewing one person may fund for strangers — rather than commons
		 *     consumption.
		 *   - **`distribute-pool`** splits the sharer's Time Pool by it, capping the shared
		 *     side at `SHARE_LINK_POOL_FRACTION`, so a link that goes viral cannot dilute what
		 *     the sharer's own watching pays the creators they actually chose.
		 *
		 * ⚠️ A creator sharing their **own** Work writes rows with `public_access: false`, so
		 * the seconds are still metered against the relay budget and earn nothing. Paying a
		 * creator out of their own pool is the same refusal the owner branch already makes in
		 * `resolveAccessSync`; a share context has a null viewer, so that branch cannot make it
		 * here and the stamp does it instead.
		 */
		viaShareLink: boolean("via_share_link").notNull().default(false),
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
// org — the daily rollup is the org's analytics and the privacy-preserving survivor
// of raw event deletion (51.05: "aggregated into per-Work and per-creator totals and
// the per-person records are deleted"). No `userId` column by design — this is the org's
// anonymized record, not a node record.
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
// org — a user's directed support to a creator, this cycle. The billing contract is
// org-side (41.02: "Subscriber relationships: Both; Billing contract org-side"). The
// `atprotoUri` column anticipates a future where the canonical assertion moves to the
// user's repo, but today the row is the org's billing record.
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

// org — a pool distribution is a *payment record* (the doc comment says so: "this row
// is a payment record, not a viewing one"). Both FKs are set-null because financial
// records outlive accounts. 41.02: money cannot federate; this is the org's ledger.
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
		// The **Public Access** seconds that earned `poolAmount`, not all the time this
		// viewer spent with this creator. It is the numerator of the pool split, so it has
		// to be the same set of seconds the money was divided by — a row whose seconds and
		// dollars came from different populations could not be audited against each other,
		// and the subscriber's Time Pool pie would draw a slice with no payout beside it.
		// Total time with a creator is a different question, answered by
		// `GET /api/subscriptions/attention/summary`.
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
// node — a creator's own gate ladder is their pricing, node-owned content. The org
// reads it to resolve access, but the creator defines it. This is the one table in
// this file where the creator, not the org, owns the row.
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

/**
 * A guardian's controls on one account, behind a pin.
 *
 * 🚨 **Its own table rather than columns on `accounts`, because the pin changes who may write
 * these rows.** Everything on `accounts` is the account holder's to set; everything here is
 * set by whoever holds the pin, and the account holder may be a child who must not be able to
 * lift their own restrictions. Putting the two in one table would make "who may write this
 * column?" a per-column rule enforced by convention, which is precisely how a lock stops being
 * one. A row's absence is the default: no pin, no controls.
 *
 * ⚠️ **Nothing here is a fact about content, and the shapes are chosen to keep it that way.**
 * The lists hold creator ids and Work types — the viewer's opinions about them — and no rating,
 * note or access row is touched. A guardian's settings must never leak into anybody else's
 * catalogue, which they cannot do from here.
 *
 * See `@anthers/shared/parental-controls` for the policy the rows are read against; this table
 * stores it and decides nothing.
 */
export const parentalControls = pgTable("parental_controls", {
	userId: integer("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	/**
	 * argon2id, the same primitive as a password.
	 *
	 * ⚠️ A pin is four to eight digits, so it is *weak by design* — a guardian types it often
	 * and in front of the person it restricts. Hashing it properly does not make it strong; it
	 * makes a database read useless to somebody who gets one, which is the part that is worth
	 * having. Rate limiting is what bounds guessing, and lives at the route.
	 */
	pinHash: text("pin_hash").notNull(),
	/** Locks the content-rating display settings — see the policy module's own note. */
	lockMaturity: boolean("lock_maturity").notNull().default(false),
	/** `{ defaultAllow, rules }` over creator ids. One shape serves allow- and blocklists. */
	creators: jsonb("creators").$type<{
		defaultAllow: boolean;
		rules: { key: string; allow: boolean; dailySeconds: number | null }[];
	}>(),
	/** The same shape over Work types (`video`, `text`, `game`, …). */
	types: jsonb("types").$type<{
		defaultAllow: boolean;
		rules: { key: string; allow: boolean; dailySeconds: number | null }[];
	}>(),
	/**
	 * Whole-app consumption caps, in seconds. Null is uncapped.
	 *
	 * ⚠️ **These bound time spent CONSUMING Works, which is the only time Anthers measures.**
	 * Browsing a catalogue is not counted and cannot honestly be — there is no event for it —
	 * so the panel says "time watching, reading and playing" rather than "time in the app".
	 * Naming it screen time would promise a measurement that does not exist.
	 */
	dailySeconds: integer("daily_seconds"),
	weeklySeconds: integer("weekly_seconds"),
	monthlySeconds: integer("monthly_seconds"),
	languageFilter: boolean("language_filter").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

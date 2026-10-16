// SPDX-License-Identifier: Apache-2.0
/**
 * Traffic analytics — first-party measurement of where visitors come from and what
 * they open, in Anthers' own tables: the sibling of the attention family in
 * `subscriptions.ts`, kept deliberately apart from it.
 *
 * 🚨 **The boundary is the money.** `attention_events` measures seconds on content and
 * pays the Time Pool; these tables measure visits, referrers, paths and card displays
 * and pay nobody. Nothing here may ride the attention tables and nothing of attention
 * may ride these — the Roadmap states the impressions half of that as a warning, and
 * this file is the code of it.
 *
 * 🚨 **No identity, by construction rather than by discipline.** `traffic_events`
 * carries no user id, no IP-derived visitor hash, nothing fingerprint-shaped; the one
 * identity-like value is `session_id`, a UUID the *client* generated for this one tab
 * session (`sessionStorage`, dying with the tab — see `packages/shared/src/traffic.ts`
 * for the reasoning). Unique-visitor counts are distinct sessions and are honest about
 * what that undercounts, exactly as `attention_daily.unique_views`'s note is. Raw rows
 * are pruned by `jobs/prune-traffic.ts` into `traffic_daily`, which has no session
 * column at all — same shape, and for the same reason, as the attention rollup's
 * missing `user_id`.
 *
 * org — site-wide measurement about Anthers' audience, never a creator's anything and
 * never a person's anything. The role is the whole file's: every table here is
 * anonymous telemetry, so `node` never enters it and a future creator-node port has
 * nothing here to carry.
 */

import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// ── Raw page views ───────────────────────────────────────────────────────────

// org — see the file legend. The raw form is the only place a session id exists.
export const trafficEvents = pgTable(
	"traffic_events",
	{
		id: serial("id").primaryKey(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		/**
		 * The page's pathname only — never the query string. Query strings carry other
		 * sites' tracking data (a `?fbclid=`, a search term) and bring nothing the
		 * analytics needs: page identity is the path.
		 */
		path: text("path").notNull(),
		/** Host-only referrer, or null when the browser sent none. Full referrer URLs are discarded at intake — same reasoning as `path`. */
		referrerHost: text("referrer_host"),
		/** The classification decided at intake (`classifyReferrerSource`); stored, never re-derived on read. */
		referrerSource: text("referrer_source").notNull(), // direct | search | social | other
		/**
		 * The path the visitor was on immediately before, when the client knew one
		 * (an in-site navigation). This is what makes a path→path flow — the entry
		 * funnel's middle — readable from raw rows without a session join.
		 */
		previousPath: text("previous_path"),
		/** The client-generated per-tab session id. Not an identity: see the file legend. */
		sessionId: text("session_id").notNull(),
		/** Broad device class from the user agent: desktop | mobile | tablet. */
		device: text("device").notNull(),
	},
	(table) => [
		// The prune job's cutoff scan.
		index("idx_traffic_created").on(table.createdAt),
		// The creator read resolves traffic by path prefix (`/@handle/…`), which a btree serves.
		index("idx_traffic_path").on(table.path),
	],
);

// ── The identity-free daily rollup ───────────────────────────────────────────

// org — the anonymized survivor of raw deletion: same shape as attention_daily, no
// session column at all, by the same argument the attention rollup's file note makes.
export const trafficDaily = pgTable(
	"traffic_daily",
	{
		id: serial("id").primaryKey(),
		/** UTC calendar day, ISO `YYYY-MM-DD`, matching the analytics grouping. */
		day: text("day").notNull(),
		path: text("path").notNull(),
		referrerSource: text("referrer_source").notNull(),
		device: text("device").notNull(),
		/** Page views recorded that day for this (path, source, device). */
		views: integer("views").notNull().default(0),
		/**
		 * Distinct sessions **within that day**. Not summable across days, and the
		 * analytics layer reports it only over windows it can see raw rows for — the
		 * same honesty rule `attention_daily`'s `unique_viewers` note carries.
		 */
		sessions: integer("sessions").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The prune job upserts on this key; every column is NOT NULL so the key is
		// total (the nullsNotDistinct caveat attention_daily needs does not arise here).
		uniqueIndex("uq_traffic_daily_key").on(
			table.day,
			table.path,
			table.referrerSource,
			table.device,
		),
		index("idx_traffic_daily_day").on(table.day),
	],
);

// ── Card impressions (Discover) ──────────────────────────────────────────────

// org — counts only; no session, no device, nothing personal of any kind.
export const cardImpressions = pgTable(
	"card_impressions",
	{
		id: serial("id").primaryKey(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		/** What was shown: a project card or a creator card. */
		subjectKind: text("subject_kind").notNull(), // project | creator
		/**
		 * The subject's row id — `projects.id` or `users.id` per `subjectKind`.
		 * Polymorphic on purpose and without a foreign key on it: one column carrying
		 * both subjects is one ingest shape rather than two, and neither subject's
		 * deletion may rewrite this history (a deleted Work "outlives everything" in
		 * the same spirit — here the *display* history does).
		 */
		subjectId: integer("subject_id").notNull(),
		/** What happened: the card was shown (rendered into the viewport) or clicked. */
		kind: text("kind").notNull(), // shown | click
		/** Which surface displayed the card. `discover` today; new surfaces add values. */
		surface: text("surface").notNull().default("discover"),
	},
	(table) => [
		index("idx_card_impressions_created").on(table.createdAt),
		index("idx_card_impressions_subject").on(table.subjectKind, table.subjectId),
	],
);

// org — the rollup of the above, plus the creator attribution resolved at rollup time.
export const cardImpressionsDaily = pgTable(
	"card_impressions_daily",
	{
		id: serial("id").primaryKey(),
		/** UTC calendar day, ISO `YYYY-MM-DD`. */
		day: text("day").notNull(),
		subjectKind: text("subject_kind").notNull(),
		subjectId: integer("subject_id").notNull(),
		surface: text("surface").notNull().default("discover"),
		/** Times the card counted as shown that day. */
		shown: integer("shown").notNull().default(0),
		/** Times the card itself was clicked that day. */
		clicked: integer("clicked").notNull().default(0),
		/**
		 * The creator the subject belongs to, resolved by `prune-traffic` when it
		 * aggregates (a project's `projects.creator_id`; a creator subject's own id),
		 * so the creator dashboard reads one table rather than re-deriving the join.
		 * Null when the subject row was deleted before pruning — the display history
		 * survives its subject, unattributed.
		 */
		creatorId: integer("creator_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_card_impressions_daily_key").on(
			table.day,
			table.subjectKind,
			table.subjectId,
			table.surface,
		),
		index("idx_card_impressions_daily_creator").on(table.creatorId, table.day),
	],
);

// ── Relations ────────────────────────────────────────────────────────────────
// None declared, on purpose. Every read of these tables is an aggregate over explicit
// column selects — there is no relational navigation into works, projects or users
// anywhere, and none is wanted: these rows are counts, not content. Adding relations
// here later is a decision that says what a traffic row navigates *to*.

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation — see auth.ts for the role-classification legend. Both tables are `org`
 * by the separation 41.02 mandates ("Moderation / labeling → Org + ATProto labelers;
 * separation of moderation from hosting, per the Bluesky model"). The *subjects* are
 * node content (comments, ratings); the *records* are the org's operator judgments.
 *
 * Both tables are polymorphic over (subject_type, subject_id) with no FK on the
 * subject, which is already the "soft cross-boundary FK" pattern 41.02's decision #2
 * asks for — the org references node content by id without a constraint that would
 * break if the content moved to a node.
 */
/**
 * Moderation — reports from users, and the append-only record of what an
 * operator did about them.
 *
 * The shape follows one rule that the rest of this feature is built to keep:
 * **removing user content is a state transition on the content row, never a
 * DELETE.** So the moderated rows (`comments`, `ratings`) carry a
 * `moderation_status`, and *everything else* — who decided, why, and when —
 * lives here, in a log that is only ever appended to. Current state is cheap to
 * filter on at read time; the history is never in the way of a query and never
 * lost to one.
 *
 * Both tables are polymorphic over `(subject_type, subject_id)` rather than
 * carrying a `comment_id` and a `rating_id`. That's deliberate: the operator
 * queue is one list over both kinds, and a third moderatable kind (a post, a
 * profile, a review) should be a new value, not a new column and a new
 * branch in every query. The cost is no foreign key on the subject, which is
 * why `hideSubject`/`restoreSubject` in `services/moderation.ts` are the only
 * writers — they resolve the subject row first, so a log entry can't name a
 * subject that never existed.
 *
 * The two `users` references are `set null`, not `cascade`, and that is the
 * point of the whole file: a moderation record has to outlive the account it is
 * about. If deleting a reporter erased their reports, or deleting an operator
 * erased their decisions, the audit trail would be a function of who still has
 * an account.
 */

import { relations } from "drizzle-orm";
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * A user's report of a comment or rating.
 *
 * One row per (reporter, subject): a second report of the same thing by the same
 * person is idempotent, not a second queue entry. Reports from *different* people
 * do stack, and the queue orders by that count — the only signal available with
 * no automated filtering behind it.
 */
// org — a user's report is an operator-queue item; the org decides. The subject is
// node content (comment/rating), referenced polymorphically with no FK (the soft
// cross-boundary pattern). Both `users` FKs are set-null: the record outlives the
// reporter and the resolver.
export const moderationReports = pgTable(
	"moderation_reports",
	{
		id: serial("id").primaryKey(),
		subjectType: text("subject_type").notNull(), // comment | rating
		subjectId: integer("subject_id").notNull(),
		// Nullable + set null: the report is a record, and it survives its reporter.
		reporterId: integer("reporter_id").references(() => users.id, { onDelete: "set null" }),
		reason: text("reason").notNull(), // MODERATION_REASONS value
		details: text("details").notNull().default(""),
		status: text("status").notNull().default("open"), // open | resolved | dismissed
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
		/**
		 * When the reporter's own words and their identity were dropped — see
		 * `services/retention.ts`. `details` is `notNull` and defaults to `""`, so
		 * without this stamp a blank report is ambiguous between *"redacted on
		 * schedule"* and *"reported with no comment"*, which are different facts.
		 * Also what keeps the sweep from rescanning settled rows forever.
		 */
		redactedAt: timestamp("redacted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One standing report per person per item — re-reporting is a no-op, so a
		// single user can't inflate the count the queue sorts by.
		uniqueIndex("uq_moderation_report_reporter_subject").on(
			table.reporterId,
			table.subjectType,
			table.subjectId,
		),
		index("idx_moderation_reports_subject").on(table.subjectType, table.subjectId),
		index("idx_moderation_reports_status").on(table.status, table.createdAt),
		// Both users FKs are ON DELETE SET NULL, so an account deletion still has to find
		// every row that names it.
		index("idx_moderation_reports_resolved_by").on(table.resolvedBy),
	],
);

/**
 * The append-only record of a moderation decision. Nothing updates or deletes
 * these rows; a reversal is a new `restore` row, so the history reads as the
 * sequence of decisions actually taken.
 */
// org — the append-only log of operator decisions. Org-only by the Bluesky model:
// the authority that moderates is separated from the host. The `actorRole` column
// anticipates ATProto labelers ("the authority is always us" is the assumption not
// to bake in), which is the future org-role extension.
export const moderationActions = pgTable(
	"moderation_actions",
	{
		id: serial("id").primaryKey(),
		subjectType: text("subject_type").notNull(), // comment | rating
		subjectId: integer("subject_id").notNull(),
		action: text("action").notNull(), // hide | restore
		// Nullable + set null for the same reason as reporterId: the decision
		// outlives the account that made it.
		actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
		// Which authority decided. One operator today; comments carry atproto_uri,
		// so "the authority is always us" is exactly the assumption not to bake in.
		actorRole: text("actor_role").notNull().default("operator"),
		reason: text("reason").notNull().default(""), // MODERATION_REASONS value, or "" on a restore
		note: text("note").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_moderation_actions_subject").on(table.subjectType, table.subjectId, table.createdAt),
		index("idx_moderation_actions_created").on(table.createdAt),
		index("idx_moderation_actions_actor").on(table.actorId),
	],
);

// Only the `one` sides are declared. There is no `many()` counterpart on `users`
// on purpose: a user relating to "reports about them" isn't expressible here
// anyway (the subject is polymorphic), and every moderation query joins
// explicitly rather than going through the relational API.
export const moderationReportsRelations = relations(moderationReports, ({ one }) => ({
	reporter: one(users, { fields: [moderationReports.reporterId], references: [users.id] }),
	resolver: one(users, { fields: [moderationReports.resolvedBy], references: [users.id] }),
}));

export const moderationActionsRelations = relations(moderationActions, ({ one }) => ({
	actor: one(users, { fields: [moderationActions.actorId], references: [users.id] }),
}));

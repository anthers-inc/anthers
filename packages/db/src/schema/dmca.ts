// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DMCA — notices under 17 U.S.C. § 512(c), counter-notices under § 512(g)(3),
 * and the statutory clocks that connect them.
 *
 * Deliberately a SEPARATE table from `moderation_reports`, for the same reason
 * the moderation vocabulary refuses to carry a copyright reason: a DMCA notice
 * is a claim about the world, made under penalty of perjury, with required
 * elements and a statutory clock — not "one operator looking at one artifact."
 * Sharing the moderation tables would mean nullable columns nothing else uses
 * and a reason enum that isn't a reason enum.
 *
 * What transfers from the moderation surface is the shape rather than the
 * tables: the append-only `moderation_actions` log gains a `work` subject type
 * entry on every takedown/restore, so the audit trail reads as the sequence of
 * decisions actually taken. The `dmca_notices` table carries the notice's own
 * lifecycle (received → screening → actioned → counter_noticed → restored /
 * rejected / withdrawn), which is a different clock from "what did the operator
 * do about the content."
 *
 * The two `users` references are `set null`, matching `moderation_actions`:
 * a decision outlives the account that made it, and a notice outlives the
 * complainant's relationship with us. The Work FK is `cascade` — a deleted Work
 * takes its notices with it, which is correct because the notice is about that
 * Work specifically.
 */

import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { works } from "./content.js";

/**
 * A counter-notice under § 512(g)(3). Stored as jsonb on the notice rather than
 * a separate table because it is 1:1 with the notice and carries no independent
 * lifecycle — a counter-notice is filed once, or not at all.
 */
export interface CounterNotice {
	/** The subscriber's name — § 512(g)(3)(C). */
	subscriberName: string;
	/** Postal address — § 512(g)(3)(C). */
	subscriberAddress: string;
	/** Telephone number — § 512(g)(3)(C). */
	subscriberPhone: string;
	/**
	 * Consent to federal jurisdiction + agreement to accept service of process
	 * from the complainant — § 512(g)(3)(D). Stored as the text the subscriber
	 * was shown and agreed to, not a boolean.
	 */
	jurisdictionConsent: string;
	/** Good-faith statement under penalty of perjury — § 512(g)(3)(A). */
	goodFaithStatement: string;
	/**
	 * The counter-notice attestation text, at the version the subscriber saw it.
	 * Same reason as `attestationTextSnapshot` on the notice: the form text is
	 * copy and copy gets edited, but what someone agreed to is fixed at the
	 * moment they agreed.
	 */
	attestationTextSnapshot: string;
	/** When the counter-notice was filed. */
	filedAt: string;
}

/**
 * The lifecycle of a DMCA notice. Distinct from the content's `takedown_status`
 * (which is about the Work) and from `moderation_actions` (which is about what
 * an operator did to the content). A notice carries its own clock.
 *
 * `received` → `screening` → `actioned` (the Work is taken down)
 *                  ↘ `rejected` (a facially defective notice; the reach-back
 *                                 under § 512(c)(3)(B)(ii) is recorded)
 * `actioned` → `counter_noticed` (the creator filed a counter-notice)
 *                   → `restored` (the 10–14 business day window closed, or the
 *                                   creator conceded, and the Work is back up)
 *                   ↘ `withdrawn` (the complainant withdrew the notice)
 *
 * `suitFiledAt` is set separately — a court action to restrain the subscriber
 * prevents the restore timer from firing, regardless of the notice's status.
 */
export type DmcaNoticeStatus =
	| "received"
	| "screening"
	| "actioned"
	| "rejected"
	| "counter_noticed"
	| "restored"
	| "withdrawn";

export const DMCA_NOTICE_STATUSES: readonly DmcaNoticeStatus[] = [
	"received",
	"screening",
	"actioned",
	"rejected",
	"counter_noticed",
	"restored",
	"withdrawn",
];

/**
 * A DMCA notice — the complaint from a copyright holder or their agent.
 *
 * The six required elements (§ 512(c)(3)(A)(i)–(vi)) are individual columns
 * rather than a jsonb blob so the intake form can validate each independently
 * and the rejection copy can name which one failed. The two attestation
 * fields (good-faith belief + authorization under penalty of perjury) and the
 * `fairUseConsidered` flag (Lenz v. Universal) are stored alongside, and the
 * `attestationTextSnapshot` preserves the exact text the complainant was shown
 * at the version they saw it — the form copy is editable, but what someone
 * agreed to is fixed at the moment they agreed.
 */
export const dmcaNotices = pgTable(
	"dmca_notices",
	{
		id: serial("id").primaryKey(),
		// The Work the notice targets. A DMCA notice is always against a Work
		// (for now); the moderation surface handles comments/ratings/users.
		workId: integer("work_id").references(() => works.id, { onDelete: "cascade" }),
		// The complainant — § 512(c)(3)(A)(iv): contact information including
		// address, telephone number, and email if available.
		complainantName: text("complainant_name").notNull(),
		complainantEmail: text("complainant_email").notNull(),
		complainantAddress: text("complainant_address").notNull(),
		complainantPhone: text("complainant_phone").default(""),
		// § 512(c)(3)(A)(ii): identification of the copyrighted work claimed to
		// be infringed.
		copyrightedWorkDescription: text("copyrighted_work_description").notNull(),
		// § 512(c)(3)(A)(iii): identification of the material claimed to be
		// infringing, with information reasonably sufficient to locate it.
		infringingMaterialDescription: text("infringing_material_description").notNull(),
		// § 512(c)(3)(A)(v): good-faith belief statement.
		goodFaithStatement: text("good_faith_statement").notNull(),
		// § 512(c)(3)(A)(vi): accuracy statement + authorization under penalty
		// of perjury. Note the perjury clause attaches only to *authorization
		// to act*, not to the accuracy of the claim or the good-faith belief.
		authorizationStatement: text("authorization_statement").notNull(),
		// Lenz v. Universal (9th Cir. 2016): failure to consider fair use can
		// support § 512(f) liability. Not required by the statute, but standard
		// practice and cheap to ask.
		fairUseConsidered: boolean("fair_use_considered").notNull(),
		// The attestation text the complainant was shown, stored verbatim. Not
		// a FK to today's copy — a later edit to the form text doesn't change
		// what a past notice said they agreed to.
		attestationTextSnapshot: text("attestation_text_snapshot").notNull(),
		// Notice lifecycle.
		status: text("status").$type<DmcaNoticeStatus>().notNull().default("received"),
		receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
		actionedAt: timestamp("actioned_at", { withTimezone: true }),
		rejectedAt: timestamp("rejected_at", { withTimezone: true }),
		// Counter-notice (§ 512(g)(3)) — null until filed.
		counterNotice: jsonb("counter_notice").$type<CounterNotice | null>(),
		counterNoticeFiledAt: timestamp("counter_notice_filed_at", { withTimezone: true }),
		// When the restore timer may fire — 10–14 business days after the
		// counter-notice was filed, per § 512(g)(2)(C). Null until a counter-notice
		// is filed.
		restoreNoEarlierThan: timestamp("restore_no_earlier_than", { withTimezone: true }),
		// If the complainant filed a court action to restrain the subscriber
		// (§ 512(g)(2)(C)), recording this prevents the restore timer from
		// firing. Set separately from the notice status.
		suitFiledAt: timestamp("suit_filed_at", { withTimezone: true }),
		// Operator who acted — set null, same as moderation_actions.actorId.
		actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
		actorRole: text("actor_role").notNull().default("operator"),
		note: text("note").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The operator queue: ordered by status then recency.
		index("idx_dmca_notices_status").on(table.status, table.receivedAt),
		// A Work's notice history.
		index("idx_dmca_notices_work").on(table.workId, table.createdAt),
		// The restore timer sweep scans for counter_noticed rows whose window
		// has passed and no suit was filed.
		index("idx_dmca_notices_restore").on(table.status, table.restoreNoEarlierThan),
		// The actor who decided — the decision outlives the account.
		index("idx_dmca_notices_actor").on(table.actorId),
	],
);

export const dmcaNoticesRelations = relations(dmcaNotices, ({ one }) => ({
	work: one(works, { fields: [dmcaNotices.workId], references: [works.id] }),
	actor: one(users, { fields: [dmcaNotices.actorId], references: [users.id] }),
}));

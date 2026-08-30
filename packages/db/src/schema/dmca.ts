// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DMCA schema — see auth.ts for the role-classification legend.
 *
 * `dmca_notices` is `org` by the Keeper model (Keepers and the Appointment Model names DMCA as non-delegable floor
 * work with a statutory clock). The *subject* is a node Work (referenced by id with
 * set-null, the soft cross-boundary pattern); the *notice* is a legal claim the org
 * must screen, act on, and clock — not something a creator node processes. The
 * complainant is a member of the public with no account; the creator is the subject of
 * the claim. Neither end is the org, but the obligation is.
 */
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
 *
 * So is `finalizedAt`: a takedown becoming final is what releases the buyer
 * refunds, and it is deliberately NOT a status — see the column comment for why
 * making it one would have barred a late counter-notice.
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
// org — a DMCA notice is a statutory claim the org must process under § 512. The
// Work is node content (referenced by id, set-null); the notice itself is the org's
// legal record, with clocks and finality the org owns. Both `users` FKs are set-null:
// the notice outlives the complainant's and operator's accounts.
export const dmcaNotices = pgTable(
	"dmca_notices",
	{
		id: serial("id").primaryKey(),
		// The Work the notice targets. A DMCA notice is always against a Work
		// (for now); the moderation surface handles comments/ratings/users.
		//
		// 🚨 **`set null`, not `cascade`** (changed 2026-08-16). It was `cascade`,
		// on the reasoning that a notice is about that Work specifically — which is
		// true and is the wrong conclusion, because it made the *infringer* able to
		// erase the record of their own infringement by deleting the Work. § 512(i)
		// conditions the safe harbor on a repeat-infringer policy that is
		// *reasonably implemented*, and the terms now published say we judge a
		// pattern; a pattern held in rows the subject can delete is not a record.
		// Same reasoning `moderation_reports` already applies to accounts: a
		// decision outlives what it was about.
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		// The Work's title at the time the notice was filed. Snapshotted for the
		// same reason `attestationTextSnapshot` is: once `workId` can go null, the
		// join that rendered the queue can return nothing, and a notice nobody can
		// read is a record only in the technical sense.
		workTitle: text("work_title").notNull().default(""),
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
		// ── Finality, and why it is a timestamp rather than a status ──────────
		// A takedown becomes FINAL when the creator has had a fair chance to
		// counter-notice and hasn't (`counterNoticeDueBy` passes), or when they
		// concede. Finality is what releases the buyer refunds — the brief's
		// reasoning: refunding at removal and then restoring on day 12 leaves a
		// refunded buyer holding restored access, and spends the remainder on a
		// claim that turned out to be wrong.
		//
		// 🚨 These are TIMESTAMPS, deliberately, not a `final` entry in
		// `DmcaNoticeStatus`. A status would have closed the counter-notice door
		// — the route admits a counter-notice only on an `actioned` notice — and
		// § 512(g) sets NO deadline for filing one. A self-imposed deadline that
		// bars a late counter-notice is exactly the competitor-removal weapon the
		// brief refuses to build. So the window governs *when we refund*, and
		// never *whether the creator may still answer*.
		/** When the creator's counter-notice window closes. Set at takedown. */
		counterNoticeDueBy: timestamp("counter_notice_due_by", { withTimezone: true }),
		/** When the takedown became final and the buyer refunds were released. */
		finalizedAt: timestamp("finalized_at", { withTimezone: true }),
		/** `no_counter_notice` | `conceded` — how finality was reached. */
		finalizedReason: text("finalized_reason").notNull().default(""),
		/**
		 * How many buyers were refunded at finality. Derivable from `purchases`,
		 * and stored anyway: it is a record of what the finalization DID, which is
		 * the same reason `moderation_actions` exists beside `moderation_status`.
		 */
		buyersRefunded: integer("buyers_refunded").notNull().default(0),
		// Operator who acted — set null, same as moderation_actions.actorId.
		actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
		actorRole: text("actor_role").notNull().default("operator"),
		note: text("note").notNull().default(""),
		/**
		 * When the complainant's contact details were blanked — see
		 * `services/retention.ts`.
		 *
		 * 🚨 **Its job is to make a blank field READABLE.** Every contact column here
		 * is `notNull`, so redaction writes `""`, and without this stamp an empty
		 * address is ambiguous between *"we deleted it on schedule"* and *"it was
		 * never given"* — which are opposite facts about whether the notice was ever
		 * valid. It is also what stops the sweep rescanning the same rows forever.
		 */
		redactedAt: timestamp("redacted_at", { withTimezone: true }),
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
		// The finality sweep scans for actioned rows whose counter-notice window
		// has passed and that have not been finalized yet.
		index("idx_dmca_notices_finality").on(table.status, table.counterNoticeDueBy),
		// The actor who decided — the decision outlives the account.
		index("idx_dmca_notices_actor").on(table.actorId),
	],
);

export const dmcaNoticesRelations = relations(dmcaNotices, ({ one }) => ({
	work: one(works, { fields: [dmcaNotices.workId], references: [works.id] }),
	actor: one(users, { fields: [dmcaNotices.actorId], references: [users.id] }),
}));

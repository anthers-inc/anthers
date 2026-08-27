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
import {
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { works } from "./content.js";

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
		/**
		 * When somebody was actually told, out of band, that this report exists.
		 *
		 * Only floor-level reasons (`FLOOR_MODERATION_REASONS`) ever get a value here;
		 * everything else stays null forever and is answered by an operator opening the
		 * console. **Null on a floor report means the alert has not gone out yet**, which
		 * is what the retry sweep selects on.
		 *
		 * 🚨 The column exists because the alert has to be *durable*, and an email is not.
		 * Sending inline and hoping is how "a queue nobody watches" becomes "an email
		 * nobody sent" one layer down — the same class of defect as a retention promise
		 * with no sweep behind it. The report row is written first and committed, so the
		 * worst case is a late alert rather than a lost one.
		 */
		escalatedAt: timestamp("escalated_at", { withTimezone: true }),
		/**
		 * Resend's own id for the alert, stored so delivery is checkable rather than assumed.
		 *
		 * ⭐ **`escalated_at` says the provider ACCEPTED the message; this is what lets
		 * anybody find out what happened next.** Without it the strongest claim available is
		 * *"we handed it to Resend and it did not complain"*, which is a fact about our side
		 * of a network call rather than about a human being told. With it,
		 * `emailDeliveryStatus` can ask whether the receiving server took it.
		 *
		 * Null on an alert that never went, and null on one sent before this column existed.
		 */
		escalationMessageId: text("escalation_message_id"),
		/**
		 * What the provider last told us became of that message — `delivered`, `bounced`,
		 * `complained`, and so on.
		 *
		 * ⭐ **Pushed to us by a webhook rather than polled.** Asking Resend directly would
		 * need an API key that can READ mail, and the production key is send-only by
		 * design; broadening it would widen the blast radius of the credential most exposed
		 * in production, to answer a question the provider is willing to simply tell us.
		 * So `POST /api/webhooks/resend` records the answer as it arrives.
		 *
		 * ⚠️ **Delivered is not read.** This says the receiving server accepted the message,
		 * never that a person saw it — mail filed into spam is `delivered` here and is still
		 * a failure of the thing the alert is for.
		 */
		escalationDeliveryEvent: text("escalation_delivery_event"),
		/** When that event happened, per the provider. Null until one arrives. */
		escalationDeliveryAt: timestamp("escalation_delivery_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The retry sweep's index: floor reports still waiting to be escalated. Partial
		// would be tighter, but the table is small and the predicate is on two columns
		// the sweep already filters by.
		index("idx_moderation_reports_escalation").on(table.escalatedAt, table.reason),
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

/**
 * An illegal-content report from anybody at all, including somebody with no account.
 *
 * 🚨 **A separate table from `moderation_reports`, and 40.12 says why in as many words:**
 * *"This is not a moderation decision — it is a detection-and-report pipeline with a
 * different destination, and running it through the ordinary queue would lose it."* The
 * ordinary queue is polymorphic over `(subject_type, subject_id)` and assumes a row in one
 * of our own tables; a member of the public has a **URL**, which is what DSA Art. 16
 * actually asks them for — *"a clear indication of the exact electronic location of that
 * information, such as the exact URL"*. Shoehorning that into a subject id would mean
 * inventing one for everything that failed to resolve.
 *
 * The shape copied here is `dmca_notices`: a public, no-auth, statutory intake with its
 * own required elements and its own queue. It is the closest existing thing and it works.
 *
 * ⚠️ **`reporter_id` is null for most rows and that is the ordinary case, not a redaction.**
 * DSA Art. 16 requires the mechanism be open to anyone, so an account is never asked for.
 * `redacted_at` is what distinguishes "we dropped their details on schedule" from "they
 * never gave us any" — the same ambiguity `moderation_reports.redacted_at` exists to
 * resolve, arrived at from the opposite direction.
 */
export const abuseReports = pgTable(
	"abuse_reports",
	{
		id: serial("id").primaryKey(),
		/**
		 * The location, exactly as the reporter typed it. Never normalized and never
		 * replaced by the id below: what they told us is the record, and our reading of it
		 * is a derivation that can be wrong.
		 */
		url: text("url").notNull(),
		/**
		 * The Work that URL resolved to, when it resolved to one. Null is ordinary — the
		 * link may name a post, a profile, something already gone, or nothing we host.
		 * `set null` for the same reason `dmca_notices.work_id` is: otherwise the subject
		 * of a report could erase the record of it by deleting the Work.
		 */
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		/** A `MODERATION_REASONS` value. The floor reasons are what escalate. */
		reason: text("reason").notNull(),
		/** DSA Art. 16's "sufficiently substantiated explanation". Required, never blank. */
		details: text("details").notNull(),
		/**
		 * Where to write back, if they want an answer. **Optional on purpose**: Art. 16
		 * requires a confirmation of receipt only *where* an address is given, and
		 * requiring one would turn an anonymous reporting route into an identified one.
		 */
		reporterEmail: text("reporter_email").notNull().default(""),
		/** Set only when the reporter happened to be signed in. Usually null. */
		reporterId: integer("reporter_id").references(() => users.id, { onDelete: "set null" }),
		status: text("status").notNull().default("open"), // open | resolved | dismissed
		/**
		 * When a human was actually told, out of band. Null means the alert is still owed,
		 * which is what the retry sweep selects on — the same durability design as
		 * `moderation_reports.escalated_at`, and for the same reason: an email is not a
		 * record, so the row commits first and the send follows.
		 */
		escalatedAt: timestamp("escalated_at", { withTimezone: true }),
		/**
		 * Resend's own id for the alert, stored so delivery is checkable rather than assumed.
		 *
		 * ⭐ **`escalated_at` says the provider ACCEPTED the message; this is what lets
		 * anybody find out what happened next.** Without it the strongest claim available is
		 * *"we handed it to Resend and it did not complain"*, which is a fact about our side
		 * of a network call rather than about a human being told. With it,
		 * `emailDeliveryStatus` can ask whether the receiving server took it.
		 *
		 * Null on an alert that never went, and null on one sent before this column existed.
		 */
		escalationMessageId: text("escalation_message_id"),
		/**
		 * What the provider last told us became of that message — `delivered`, `bounced`,
		 * `complained`, and so on.
		 *
		 * ⭐ **Pushed to us by a webhook rather than polled.** Asking Resend directly would
		 * need an API key that can READ mail, and the production key is send-only by
		 * design; broadening it would widen the blast radius of the credential most exposed
		 * in production, to answer a question the provider is willing to simply tell us.
		 * So `POST /api/webhooks/resend` records the answer as it arrives.
		 *
		 * ⚠️ **Delivered is not read.** This says the receiving server accepted the message,
		 * never that a person saw it — mail filed into spam is `delivered` here and is still
		 * a failure of the thing the alert is for.
		 */
		escalationDeliveryEvent: text("escalation_delivery_event"),
		/** When that event happened, per the provider. Null until one arrives. */
		escalationDeliveryAt: timestamp("escalation_delivery_at", { withTimezone: true }),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
		/** When the reporter's own words and contact address were dropped. See above. */
		redactedAt: timestamp("redacted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The retry sweep's selection: reports nobody has been told about yet.
		index("idx_abuse_reports_escalation").on(table.escalatedAt, table.reason),
		index("idx_abuse_reports_status").on(table.status, table.createdAt),
		index("idx_abuse_reports_work").on(table.workId),
		index("idx_abuse_reports_resolved_by").on(table.resolvedBy),
	],
);

export const abuseReportsRelations = relations(abuseReports, ({ one }) => ({
	work: one(works, { fields: [abuseReports.workId], references: [works.id] }),
	reporter: one(users, { fields: [abuseReports.reporterId], references: [users.id] }),
}));

/**
 * A suspension of automated destruction — the general legal hold, of which a
 * CyberTipline preservation is the first caller.
 *
 * 🚨 **Why this is general rather than a CSAM-specific flag.** § 4.4 of the Document
 * Retention and Destruction Policy calls itself "a build requirement disguised as a
 * policy clause": every scheduled deletion Anthers operates has to be capable of
 * being switched off, because "a retention rule that cannot be switched off is a
 * defect to be fixed, not a defense." A hold placed for one obligation is the same
 * mechanism a subpoena, an audit or a live suit needs, so a CSAM-only version would
 * be built twice and the two would disagree about whether the work was done.
 *
 * **A hold is a state, never a delete, in both directions.** Lifting one stamps
 * `lifted_at` and leaves the row, so the record of what was preserved and why
 * outlives the preservation — the same reasoning as `moderation_actions`.
 *
 * `expires_at` exists because the statutory holds have their own clocks: 18 U.S.C.
 * § 2258A(h) preserves for **one year** from the report. Null means indefinite,
 * which is what a live suit gets.
 *
 * ⚠️ The subject is polymorphic and carries no FK, like the tables above — and here
 * that is load-bearing rather than stylistic: a hold on a user has to survive
 * everything that would otherwise cascade from that user's row, which is precisely
 * what it exists to prevent.
 */
export const legalHolds = pgTable(
	"legal_holds",
	{
		id: serial("id").primaryKey(),
		/** "user" | "work" | "report" | "abuse_report" — what is being preserved. */
		subjectType: text("subject_type").notNull(),
		subjectId: integer("subject_id").notNull(),
		/** Why, in the operator's words. Never blank: a hold nobody can explain is a bug. */
		reason: text("reason").notNull(),
		/** Null for a hold placed by a job rather than a person. */
		placedBy: integer("placed_by").references(() => users.id, { onDelete: "set null" }),
		placedAt: timestamp("placed_at", { withTimezone: true }).defaultNow().notNull(),
		/** When the hold stops applying on its own. Null = indefinite, lifted by hand. */
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		/** Set when a human lifts it. The row stays; this is what makes it inactive. */
		liftedAt: timestamp("lifted_at", { withTimezone: true }),
		note: text("note").notNull().default(""),
	},
	(table) => [
		// Every sweep asks the same question — "is this subject held right now?" — so
		// the index is on the lookup, with lifted_at included to keep the active check
		// off the heap.
		index("idx_legal_holds_subject").on(table.subjectType, table.subjectId, table.liftedAt),
	],
);

export const legalHoldsRelations = relations(legalHolds, ({ one }) => ({
	placer: one(users, { fields: [legalHolds.placedBy], references: [users.id] }),
}));

/**
 * One object moved into the quarantine prefix, and why.
 *
 * 🚨 **A record, never a rendering.** § 5.2 of 60.13 makes it a policy commitment that
 * the operator surface shows the finding — the key, the Work, the uploader, the match
 * classification and the timestamps — and **never the material**. That is why there is
 * no thumbnail column, no excerpt, and no preview key here: building a viewer over this
 * table would take a policy amendment, not a migration. § 2258B conditions the
 * provider's immunity on minimizing how many people can see such depictions, and a
 * console that renders one widens that population every time somebody opens it.
 *
 * **A row per object rather than per Work**, because the finding names a key: a Work
 * carries a source, a thumbnail, any number of assets and a transcode output, and a
 * restore has to put each one back exactly where the database still says it is. The
 * incident is reconstructed by grouping on `work_id` and `placed_at`, which is what the
 * operator list does.
 *
 * `original_key` is what the rest of the database still points at — `works.source_key`,
 * `assets.file`, a transcode's output URL — and is deliberately NOT rewritten when the
 * object moves. Rewriting them would scatter the knowledge that something is quarantined
 * across four tables, where `quarantine_status` and this row now hold it in two.
 */
/**
 * What a detection vendor said, verbatim in its own terms.
 *
 * 🚨 **`matchType` is separated from `classification` because they answer different legal
 * questions.** *Lawshe v. Verizon* read § 2258B immunity as covering reasonable reliance
 * on a **hash match** tagged as apparent CSAM; whether a *perceptual near* match sits
 * inside that reading is genuinely open, and a vendor may decline to warrant the accuracy
 * of its own similarity calculation while warranting a cryptographic one. Recording only
 * "it matched" would make the two indistinguishable after the fact, which is precisely
 * when the distinction would be needed.
 */
export interface VendorMatch {
	/** Which service answered — `arachnid-shield`, and whatever follows it. */
	vendor: string;
	/** Their word for it, never ours. `csam`, `harmful-abusive-material`, … */
	classification: string;
	/** `exact` is a cryptographic hash match; `near` is perceptual and weaker. */
	matchType: "exact" | "near" | "none";
	/** When they told us, so a retention sweep can age this out on its own clock. */
	receivedAt: string;
}

/**
 * One detection scan of one stored object.
 *
 * ⭐ **Keyed on the storage key rather than on the Work**, because that is the only
 * identifier both upload paths share. `POST /api/content/media-upload/direct` buffers
 * bytes in the handler, but `POST /api/content/media-upload/presign` hands the browser a
 * presigned PUT and the API never sees them — so the object exists in R2 before anything
 * here knows about it, and the key is what arrives first. Wiki 40.12 § *The ingest
 * inventory* has the full asymmetry.
 *
 * ⚠️ **A row means the question was asked, not that the content is safe.** `determination`
 * carries `unscannable` for an object no usable fingerprint could be computed for, which
 * is different from `clean` in the way that matters: one is an answer and the other is the
 * absence of one. Nothing may read the presence of a row as a clean bill of health.
 */
export const mediaScans = pgTable(
	"media_scans",
	{
		id: serial("id").primaryKey(),
		/** The stored object this is about. One scan per key; a re-scan replaces the row. */
		storageKey: text("storage_key").notNull().unique(),
		/**
		 * The Work it belongs to, when it belongs to one. **Nullable on purpose**: avatars,
		 * covers and other profile images are scanned too and have no Work behind them.
		 */
		workId: integer("work_id").references(() => works.id, { onDelete: "cascade" }),
		/**
		 * The PDQ perceptual hash we computed, hex, in the reference byte order.
		 *
		 * ⭐ **This is ours, not the vendor's, and it is safe to keep.** It is a fingerprint
		 * of our own user's file computed on our own hardware — no part of it is Match Data,
		 * so none of the retention or agent-access limits on `vendor_match` apply. Keeping
		 * it is what lets a corpus update be re-checked later without re-reading the object.
		 */
		pdqHash: text("pdq_hash"),
		/** PDQ's own 0-100 confidence. Below the service's floor the hash is not matched on. */
		pdqQuality: integer("pdq_quality"),
		/**
		 * **The Corporation's own determination** — `clean`, `apparent-csam`,
		 * `harmful-abusive`, or `unscannable`. Our vocabulary, never a vendor's.
		 *
		 * 🚨 `harmful-abusive` is **not** a reporting trigger. § 7.3 of 60.13, and the
		 * reasoning is in `services/safety-scan.ts` — the vendor defines that classification
		 * as material that may not be illegal, so reporting on it would report material the
		 * vendor itself says may be lawful.
		 */
		determination: text("determination").notNull(),
		/**
		 * What the vendor said, when one answered.
		 *
		 * 🚨 **NEVER let this reach an agent**, on the same terms as the identically-named
		 * column on `media_quarantine` — Shield § 6(b)/(c) forbid generative-AI use of Match
		 * Data, and § 13(e) forbids retaining it past its purpose. Our determination above
		 * is the permanent, agent-readable half.
		 */
		vendorMatch: jsonb("vendor_match").$type<VendorMatch | null>(),
		scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("media_scans_work_idx").on(table.workId),
		index("media_scans_determination_idx").on(table.determination),
	],
);

export const mediaQuarantine = pgTable(
	"media_quarantine",
	{
		id: serial("id").primaryKey(),
		/**
		 * The Work the object belonged to. `set null` rather than `cascade`, on the same
		 * reasoning as `works.creator_id`: the record of a quarantine has to outlive
		 * whatever it named, and a cascade here would erase the evidence that something
		 * was preserved at the moment the thing it was about went away.
		 */
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		/** Who uploaded it, captured at quarantine time so the record survives their deletion. */
		uploaderId: integer("uploader_id").references(() => users.id, { onDelete: "set null" }),
		/** Where the object lives in the rest of the database. */
		originalKey: text("original_key").notNull(),
		/** Where it actually is now — `quarantine/` + the original key. */
		quarantineKey: text("quarantine_key").notNull(),
		/** source | thumbnail | asset | audio | hls — which of a Work's objects this is. */
		objectKind: text("object_kind").notNull(),
		/**
		 * How this arrived: `report` (a person filed one), `scan` (a detection vendor), or
		 * `operator` (somebody acted directly). It decides what the finding is worth.
		 *
		 * 🚨 A `scan` finding is a **hash match** and a classifier's output is triage only.
		 * *Lawshe v. Verizon* (2025) read § 2258B immunity as covering reasonable reliance
		 * on a hash match tagged as apparent CSAM but not on merely uncertain indications,
		 * which is why the two may never collapse into one value here. § 7.3 of 60.13
		 * states it as a rule — and note that a match alone is not the trigger; **the
		 * classification the match carries is**.
		 */
		source: text("source").notNull(),
		/**
		 * **The Corporation's own determination**, in its own vocabulary — what *we*
		 * concluded this material is.
		 *
		 * 🚨 **This is deliberately NOT a vendor's answer, and the separation is the whole
		 * point of the two columns.** § 7.6 of 60.13: a detection vendor's data is an input
		 * to our determination and never a substitute for it. Shield by Project Arachnid
		 * says outright that its classifications "are not classifications made by law
		 * enforcement and are not intended to be presented, construed, or interpreted as
		 * final determinations on legality" — so a record resting on one would rest on
		 * something its author disclaims.
		 *
		 * ⭐ Two practical consequences follow, and both are why the split exists. This
		 * column is **permanent**, because it is what answers an appeal years later and what
		 * a CyberTipline report states; a vendor's terms may require its data to be
		 * time-limited, and ours must not age out with theirs. And this column is **safe for
		 * an agent to read**, where `vendor_match` is not — see the note there.
		 */
		classification: text("classification").notNull().default(""),
		/**
		 * What a detection vendor returned, kept apart from our own determination above.
		 *
		 * 🚨 **NEVER let this reach an agent.** Shield's terms (§ 6(b) and § 6(c)) forbid
		 * using Match Data to train artificial intelligence *or as input data for generative
		 * artificial intelligence*. Pasting a value from here into an agent session — or an
		 * agent running a query that returns it — is a prohibited use, not a stylistic
		 * preference. Anthers is built with agents reading this repository, so the rule has
		 * to live where the column does. The Agents Hub carries it too.
		 *
		 * ⚠️ **Time-limited, unlike `classification`.** A vendor may require that its data
		 * not be retained beyond the purpose it was provided for, with carve-outs for legal
		 * compliance — which covers the § 2258A(h) preservation year and does not cover
		 * keeping it forever because our appeal story wants it. Null once aged out, while
		 * our own determination stays.
		 *
		 * jsonb rather than columns because each vendor's vocabulary is its own and we have
		 * not chosen one: expect a classification, a match type, and whatever else the
		 * particular service returns.
		 */
		vendorMatch: jsonb("vendor_match").$type<VendorMatch | null>(),
		/** The report that triggered this, when one did. */
		reportId: integer("report_id").references(() => moderationReports.id, {
			onDelete: "set null",
		}),
		/**
		 * The Work's `visibility` before the quarantine delisted it.
		 *
		 * Recorded rather than assumed, so clearing a finding restores what the creator
		 * actually chose. `services/dmca.ts` avoids the problem entirely by never touching
		 * `visibility` — quarantine cannot, because a listed Work still shows its thumbnail,
		 * and for this material the thumbnail may BE the finding.
		 */
		priorVisibility: text("prior_visibility").notNull().default(""),
		placedBy: integer("placed_by").references(() => users.id, { onDelete: "set null" }),
		placedAt: timestamp("placed_at", { withTimezone: true }).defaultNow().notNull(),
		/**
		 * When the object was put back. Set on a cleared finding; the row stays either way,
		 * so "why did this come back?" has an answer years later.
		 */
		clearedAt: timestamp("cleared_at", { withTimezone: true }),
		clearedBy: integer("cleared_by").references(() => users.id, { onDelete: "set null" }),
		note: text("note").notNull().default(""),
	},
	(table) => [
		// The operator list, and the per-Work lookup a clear does.
		index("idx_media_quarantine_work").on(table.workId, table.clearedAt),
		index("idx_media_quarantine_placed").on(table.placedAt),
	],
);

/**
 * A creator's appeal against an operator's correction of their Work's maturity rating.
 *
 * 🚨 **The appeal is part of the rating feature rather than a later refinement**, and 40.09
 * is emphatic about why: the adults-only category is payment-gated, so an over-cautious call
 * does not merely add a warning to a work — it puts it behind a paywall. For a queer
 * coming-of-age story wrongly flagged, that is exactly the harm the category exists to
 * prevent, produced by the mechanism meant to prevent it. Shipping a correction path without
 * a way to contest it would build only the half that can do damage.
 *
 * ⚠️ **`work_id` cascades, unlike every other reference in this file, and the difference is
 * the subject rather than an inconsistency.** A moderation report is about a person's
 * conduct and has to outlive the account and the artifact, because § 512(i) needs the
 * pattern; an appeal is about the rating of one Work and means nothing once that Work no
 * longer exists. The creator reference is `set null` on the usual footing: the decision
 * outlives whoever made it.
 */
export const workRatingAppeals = pgTable(
	"work_rating_appeals",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		/** What the creator says the rating should be. `MaturityRating` in `@anthers/shared`. */
		requestedMaturity: text("requested_maturity").notNull(),
		/** What it was when they appealed, so a granted appeal can be read years later. */
		correctedMaturity: text("corrected_maturity").notNull(),
		/** The creator's own words. Required — an appeal with no argument is not one. */
		statement: text("statement").notNull(),
		/** `open` | `granted` | `upheld`. */
		status: text("status").notNull().default("open"),
		resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		/** The operator's answer, shown to the creator. Their appeal deserves a reply. */
		resolutionNote: text("resolution_note").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The operator queue reads open appeals oldest-first; the per-Work lookup is what
		// refuses a second open appeal on the same Work.
		index("idx_rating_appeals_status").on(table.status, table.createdAt),
		index("idx_rating_appeals_work").on(table.workId, table.status),
	],
);

export const workRatingAppealsRelations = relations(workRatingAppeals, ({ one }) => ({
	work: one(works, { fields: [workRatingAppeals.workId], references: [works.id] }),
	creator: one(users, { fields: [workRatingAppeals.creatorId], references: [users.id] }),
	resolver: one(users, { fields: [workRatingAppeals.resolvedBy], references: [users.id] }),
}));

export const mediaQuarantineRelations = relations(mediaQuarantine, ({ one }) => ({
	work: one(works, { fields: [mediaQuarantine.workId], references: [works.id] }),
	uploader: one(users, { fields: [mediaQuarantine.uploaderId], references: [users.id] }),
	placer: one(users, { fields: [mediaQuarantine.placedBy], references: [users.id] }),
}));

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

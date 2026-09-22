// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation — the one place that files a report, hides a subject, restores it,
 * and assembles the operator's queue.
 *
 * Routes here are deliberately thin: the report endpoint is user-facing and the
 * hide/restore endpoints are admin-gated, so the logic lives in one module both
 * can call rather than being duplicated on either side of the gate. That also
 * makes the whole feature testable without a browser, the same way
 * `resolveAccessSync` is.
 *
 * The invariant this module exists to hold: **hiding is an UPDATE, never a
 * DELETE.** Nothing here removes a comment or a review row. `hideSubject` flips
 * `moderation_status` and appends to `moderation_actions`; `restoreSubject`
 * flips it back and appends again. The content, its author, and its timestamps
 * are all still there afterwards — which is why an appeal, a creator-side tool,
 * or a labeler that disagrees with us can be built later as a feature instead of
 * a migration. If you are adding a moderation action and reach for `db.delete`,
 * that is the bug.
 *
 * Subjects are polymorphic (`comment` | `review` | `user` | `work`). The two content kinds
 * share a shape, so `CONTENT_SUBJECTS` is the single table mapping each to its Drizzle
 * table, and another content kind means one entry there rather than a new branch in every
 * query. `user` and `work` do not share that shape and are resolved on their own in
 * `findSubject`.
 */

import { db } from "@anthers/db/client";
import {
	adminAccounts,
	comments,
	invoiceLines,
	invoices,
	moderationActions,
	moderationReports,
	posts,
	reviews,
	sessions,
	users,
	works,
} from "@anthers/db/schema";
import { verdictLabel } from "@anthers/shared/content";
import {
	isLegalReason,
	isModeratableContent,
	LEGAL_MODERATION_REASONS,
	MODERATION_NOTE_MAX,
	type ModerationActionType,
	type ModerationActorRole,
	type ModerationSubjectType,
	moderationReasonLabel,
	REPORT_DETAILS_MAX,
} from "@anthers/shared/moderation";
import { alias } from "drizzle-orm/pg-core";
import { and, count, desc, eq, exists, inArray, isNotNull, isNull, lte, max, or, sql } from "drizzle-orm";
import { commentRoots, REPLY_SUBJECT_TYPE } from "./comment-thread.js";
import { abuseAlertsEnabled, sendAbuseAlert } from "./email.js";
import { resumePausedRenewals } from "./invoices.js";
import { notify } from "./notifications.js";
import { queueRecordSync } from "./record-sync.js";
import { restoreStickersOnSubject, voidStickersOnSubject } from "./sticker-void.js";

/** Whether an account is suspended right now. The one predicate every reader shares. */
export function isAccountSuspended(row: {
	suspendedAt: Date | null;
	suspendedUntil: Date | null;
}): boolean {
	if (!row.suspendedAt) return false;
	return !row.suspendedUntil || row.suspendedUntil.getTime() > Date.now();
}

/**
 * Subject type → the table it lives in. The only place the mapping is written down.
 *
 * `user` is deliberately absent. The two entries here are *content* tables sharing a
 * shape — an `id`, an author, and a `moderation_status` — and everything keyed off
 * this map (hide, restore, the browse filters) assumes all three columns. A `users`
 * row has none of them in that sense: it has no author but is one, and its moderation
 * state is the `suspended_at`/`suspended_until` pair on the row itself, which
 * `suspendAccount`/`unsuspendAccount` write instead. Adding `users` here to make the
 * map look complete is what would produce a hide path that half-works.
 */
const CONTENT_SUBJECTS = {
	comment: comments,
	review: reviews,
} as const;

type ContentSubjectType = keyof typeof CONTENT_SUBJECTS;

export interface ModerationSubjectRow {
	id: number;
	/**
	 * The author, for content. For a `user` subject this is the subject itself.
	 *
	 * Null on a **tombstoned** row — the author deleted their account and the comment
	 * or review stayed so the thread around it still reads. Moderation still applies to
	 * it: the words are still there, and hiding them is still the operator's call.
	 */
	userId: number | null;
	/**
	 * Always `"visible"` for a `user` subject — an account's moderation state is the
	 * `suspended_at`/`suspended_until` pair on its row, not this string, which exists
	 * so report validation reads one shape for every subject type.
	 */
	moderationStatus: string;
}

/**
 * Load a subject row, or null if it doesn't exist. Every write path resolves first.
 *
 * The `user` branch exists so a person report can be validated the same way a comment
 * report is — a report naming an account that isn't there would sit in the queue with
 * nothing to render, exactly the orphan case `subjectStillExists` cleans up after.
 *
 * The `work` branch exists so a copyright complaint filed as a user report can be
 * validated the same way. A Work takedown is a DMCA action with its own service
 * (`services/dmca.ts`) and does NOT route through `hideSubject` — `isModeratableContent`
 * returns false for `work`, which keeps the moderation hide/restore path from accepting
 * a Work it can't handle. But a Work CAN be reported (the operator needs a one-click
 * "this is a copyright claim → here is the path"), so `findSubject` resolves it.
 */
export async function findSubject(
	subjectType: ModerationSubjectType,
	subjectId: number,
): Promise<ModerationSubjectRow | null> {
	if (subjectType === "user") {
		const [row] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, subjectId))
			.limit(1);
		return row ? { id: row.id, userId: row.id, moderationStatus: "visible" } : null;
	}

	if (subjectType === "work") {
		const [row] = await db
			.select({ id: works.id, userId: works.creatorId, moderationStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, subjectId))
			.limit(1);
		// A Work carries a `takedown_status` rather than a `moderation_status`, but the
		// `ModerationSubjectRow` shape is the contract every caller reads. `active` is
		// the Work's normal state and maps to "visible" for a caller that doesn't know
		// about takedowns; `taken_down` maps to "hidden". The DMCA service reads the
		// real column directly.
		return row
			? {
					id: row.id,
					userId: row.userId,
					moderationStatus: row.moderationStatus === "taken_down" ? "hidden" : "visible",
				}
			: null;
	}

	const table = CONTENT_SUBJECTS[subjectType as ContentSubjectType];
	const [row] = await db
		.select({
			id: table.id,
			userId: table.userId,
			moderationStatus: table.moderationStatus,
		})
		.from(table)
		.where(eq(table.id, subjectId))
		.limit(1);
	return row ?? null;
}

/**
 * File a report. Idempotent per (reporter, subject): a second report of the same
 * item by the same person updates their reason rather than adding a queue entry,
 * so one user can't inflate the count the queue sorts by.
 *
 * Self-reporting is allowed on purpose FOR CONTENT. Neither a comment nor a review
 * can be deleted by anyone today — not even its author — so a report is currently the
 * only way an author can ask for their own words to come down. It is refused for a
 * `user` subject, where it means nothing: the route rejects that case before getting
 * here, since "report yourself" has no reading that helps anyone.
 */
export async function fileReport(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	reporterId: number;
	reason: string;
	details?: string;
}): Promise<{ reportId: number }> {
	const details = (input.details ?? "").trim().slice(0, REPORT_DETAILS_MAX);
	const [row] = await db
		.insert(moderationReports)
		.values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			reporterId: input.reporterId,
			reason: input.reason,
			details,
		})
		.onConflictDoUpdate({
			target: [
				moderationReports.reporterId,
				moderationReports.subjectType,
				moderationReports.subjectId,
			],
			// Re-reporting reopens: an operator dismissed the earlier reason, not
			// every future one, and the reporter is telling us something changed.
			set: {
				reason: input.reason,
				details,
				status: "open",
				resolvedAt: null,
				resolvedBy: null,
				resolvedByAdminId: null,
			},
		})
		.returning({ id: moderationReports.id });

	// The row is committed before anything is sent, and that ordering is the design.
	// A legal report that reaches the database and fails to reach a person is late;
	// one that fails to reach the database because an email provider was down is
	// gone. `escalateReport` swallows its own failure for the same reason — the
	// sweep below re-selects anything still unescalated.
	if (isLegalReason(input.reason)) await escalateReport(row.id);

	return { reportId: row.id };
}

/**
 * Tell a human, out of band, that a legal report exists.
 *
 * 🚨 **What this deliberately does not carry.** The reported content never appears in
 * the message — not the comment text, not the reporter's quotation of it, not a
 * thumbnail. What goes out is a *locator*: which subject, which reason, when, and
 * where to look. § 2258B conditions the provider's immunity on minimizing who has
 * access to reported depictions, and an alert that reproduces the material into an
 * inbox is the easiest way to widen that population without deciding to. The
 * reporter's own words are included because they are what makes the alert
 * actionable, and because they are text a reporter wrote rather than the material.
 *
 * Returns true when the alert went out and the row was stamped. Never throws: the
 * caller has already committed the report, and a failure here is the sweep's problem
 * rather than the reporter's.
 */
export async function escalateReport(reportId: number): Promise<boolean> {
	const [report] = await db
		.select({
			id: moderationReports.id,
			subjectType: moderationReports.subjectType,
			subjectId: moderationReports.subjectId,
			reason: moderationReports.reason,
			details: moderationReports.details,
			createdAt: moderationReports.createdAt,
			escalatedAt: moderationReports.escalatedAt,
		})
		.from(moderationReports)
		.where(eq(moderationReports.id, reportId))
		.limit(1);

	if (!report) return false;
	if (report.escalatedAt) return true; // Already told somebody; don't tell them twice.
	if (!isLegalReason(report.reason)) return false;

	const label = moderationReasonLabel(report.reason);
	const subject = `[Anthers] Floor report: ${label} on ${report.subjectType} ${report.subjectId}`;
	const html = [
		`<p><strong>${label}</strong> reported on <strong>${report.subjectType} ${report.subjectId}</strong>.</p>`,
		`<p>Report ID ${report.id}, filed ${report.createdAt.toISOString()}.</p>`,
		report.details
			? `<p>What the reporter said:</p><blockquote>${escapeHtml(report.details)}</blockquote>`
			: "<p>The reporter left no description.</p>",
		"<p>Open the moderation queue in the admin console to act on it.</p>",
		"<p>If this is child sexual abuse material, an enticement of a child, or child sex trafficking, stop here and follow the incident runbook. Do not open the content.</p>",
	].join("\n");

	const { sent, messageId } = await sendAbuseAlert({ subject, html });
	if (!sent) return false;

	// The provider's id is stored beside the stamp, because the stamp alone can only ever
	// say "Resend accepted it". With the id, `GET /api/admin/escalation-delivery` can ask
	// what actually became of the message — which is the question the alert exists to answer.
	await db
		.update(moderationReports)
		.set({ escalatedAt: new Date(), escalationMessageId: messageId })
		.where(eq(moderationReports.id, reportId));
	return true;
}

/**
 * Floor reports nobody has been told about. The sweep's selection, exported so a test
 * can assert on it without sending anything.
 *
 * ⚠️ It deliberately ignores `status`. A report an operator has already resolved still
 * gets its alert, because "somebody dismissed it before anyone outside the console was
 * told" is precisely the hole the alert exists to close.
 */
export async function pendingEscalations(): Promise<number[]> {
	const rows = await db
		.select({ id: moderationReports.id })
		.from(moderationReports)
		.where(
			and(
				isNull(moderationReports.escalatedAt),
				inArray(moderationReports.reason, [...LEGAL_MODERATION_REASONS]),
			),
		)
		.orderBy(moderationReports.createdAt);
	return rows.map((r) => r.id);
}

/** Retry every legal report that has not reached a person yet. Returns how many did. */
export async function runEscalationSweep(): Promise<number> {
	// Nothing this process can do about them — see `abuseAlertsEnabled`. Refusing here rather
	// than once per row is the difference between one log line and hundreds, every five
	// minutes, for as long as a backlog sits in a developer's database.
	if (!abuseAlertsEnabled()) return 0;
	const ids = await pendingEscalations();
	let sent = 0;
	for (const id of ids) if (await escalateReport(id)) sent++;
	return sent;
}

/** Minimal entity escaping — the reporter's text is untrusted and goes into an email. */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/**
 * Hide a subject and record why. Returns null if the subject doesn't exist, and
 * `"not_moderatable"` for a subject type that cannot be hidden at all.
 *
 * That second outcome is what a **person** report gets. Hiding an account is
 * suspension, and suspension has to answer what becomes of the person's Works, their
 * buyers' purchases, the support pointed at them and any payout mid-flight — none of
 * which is decided. So a person report reaches the queue and an operator dismisses it
 * or acts out of band; the account action is stated as missing rather than stubbed
 * into something that half-works.
 *
 * Both writes are one transaction: a hidden row with no record of who hid it is
 * exactly the state this feature exists to prevent. Open reports against the
 * subject are resolved in the same transaction — acting on the content is the
 * answer to the report, and leaving them open would make the queue re-serve work
 * that's already done.
 */
export async function hideSubject(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** The admin account acting. */
	adminId: number;
	actorRole?: ModerationActorRole;
	reason: string;
	note?: string;
}): Promise<{ status: "hidden" } | "not_moderatable" | null> {
	if (!isModeratableContent(input.subjectType)) return "not_moderatable";

	const subject = await findSubject(input.subjectType, input.subjectId);
	if (!subject) return null;

	const table = CONTENT_SUBJECTS[input.subjectType as ContentSubjectType];
	const note = (input.note ?? "").trim().slice(0, MODERATION_NOTE_MAX);

	await db.transaction(async (tx) => {
		await tx.update(table).set({ moderationStatus: "hidden" }).where(eq(table.id, input.subjectId));

		await tx.insert(moderationActions).values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			action: "hide" satisfies ModerationActionType,
			adminActorId: input.adminId,
			actorRole: input.actorRole ?? "operator",
			reason: input.reason,
			note,
		});

		await tx
			.update(moderationReports)
			.set({ status: "resolved", resolvedAt: new Date(), resolvedByAdminId: input.adminId })
			.where(
				and(
					eq(moderationReports.subjectType, input.subjectType),
					eq(moderationReports.subjectId, input.subjectId),
					eq(moderationReports.status, "open"),
				),
			);

		// A Sticker can ride a comment, and one Anthers hid stops paying the thread's creator.
		if (input.subjectType === "comment") {
			await voidStickersOnSubject("comment", input.subjectId, tx);
		}
	});

	// ⚠️ Hiding writes nothing to the network — the record stays where its author put it, and the
	// planner answers `keep` without opening a repository. It is asked for anyway, so that the
	// decision about what a hide does to a record lives in the planner and nowhere else.
	void queueRecordSync(input.subjectType as ContentSubjectType, input.subjectId);

	return { status: "hidden" };
}

/**
 * Put a hidden subject back. A reversal is a NEW `restore` row, never an edit or
 * deletion of the `hide` row that preceded it — the log reads as the sequence of
 * decisions actually taken, including the ones we changed our minds about.
 *
 * Restoring does NOT reopen the reports the hide resolved. The operator has seen
 * them and decided twice; re-queuing the same item would be the queue arguing
 * with the person reading it.
 */
export async function restoreSubject(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** The admin account acting. */
	adminId: number;
	actorRole?: ModerationActorRole;
	note?: string;
}): Promise<{ status: "visible" } | "not_moderatable" | null> {
	// Symmetric with `hideSubject`: nothing that can't be hidden can be restored, and
	// saying so here means the pair can't drift into a state where one accepts a
	// subject type the other rejects.
	if (!isModeratableContent(input.subjectType)) return "not_moderatable";

	const subject = await findSubject(input.subjectType, input.subjectId);
	if (!subject) return null;

	const table = CONTENT_SUBJECTS[input.subjectType as ContentSubjectType];
	const note = (input.note ?? "").trim().slice(0, MODERATION_NOTE_MAX);

	await db.transaction(async (tx) => {
		await tx
			.update(table)
			.set({ moderationStatus: "visible" })
			.where(eq(table.id, input.subjectId));

		await tx.insert(moderationActions).values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			action: "restore" satisfies ModerationActionType,
			adminActorId: input.adminId,
			actorRole: input.actorRole ?? "operator",
			reason: "",
			note,
		});

		// Through `tx`, where the comment already reads as visible. A Sticker stays voided while
		// the Work its thread hangs off is still removed.
		if (input.subjectType === "comment") {
			await restoreStickersOnSubject("comment", input.subjectId, tx);
		}
	});

	// A comment hidden before its record was ever written gets one now, since it is visible again.
	void queueRecordSync(input.subjectType as ContentSubjectType, input.subjectId);

	return { status: "visible" };
}

/**
 * Answer a reporter who has filed what is really a copyright claim, and point
 * them at the path that can actually handle it.
 *
 * 🚨 **This takes no action on the content, and that is the whole point.** A user
 * report is not a DMCA notice: the six reason codes are answerable by one
 * operator looking at one artifact, and copyright ownership is the opposite —
 * a claim about the world, made under penalty of perjury, with required elements
 * and a statutory clock. So a report reasoned as `illegal` or `other` that turns
 * out to be a copyright complaint must **never** become a removal. It gets
 * cleared from the queue and its reporter gets told where to go.
 *
 * The § 512(c)(3)(B)(ii) reach-back has the same shape and is worth noticing:
 * where a defective *notice* substantially complies, we help the sender fix it
 * rather than binning it. This is that instinct applied one step earlier, to
 * someone who has not filed a notice at all.
 *
 * The reports are dismissed rather than resolved because nothing was done to the
 * content — `dismiss` is already the console's "I looked, it's fine" outcome, and
 * "I looked, and this belongs somewhere else" closes the same way.
 */
export async function routeToCopyright(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** The admin account acting. */
	adminId: number;
}): Promise<{ dismissed: number; reportersNotified: number }> {
	const rows = await db
		.update(moderationReports)
		.set({ status: "dismissed", resolvedAt: new Date(), resolvedByAdminId: input.adminId })
		.where(
			and(
				eq(moderationReports.subjectType, input.subjectType),
				eq(moderationReports.subjectId, input.subjectId),
				eq(moderationReports.status, "open"),
			),
		)
		.returning({ id: moderationReports.id, reporterId: moderationReports.reporterId });

	// One message per person, not per report: someone who filed twice about the
	// same thing does not need telling twice. `reporterId` is null once the
	// reporter deleted their account — there is nobody left to answer.
	const reporters = new Set(rows.map((r) => r.reporterId).filter((id): id is number => id != null));
	for (const userId of reporters) {
		await notify({
			userId,
			category: "activity",
			kind: "report_routed_copyright",
			title: "Your report looks like a copyright claim",
			body: "Thanks for reporting this. What you've described is a copyright claim, and that is a different process from a content report — it has legal requirements we can't meet on your behalf, and we can't remove anything on a report alone. If you own the copyright, or act for the owner, you can file a formal notice at /copyright and we will act on it. We have closed the report; filing the notice is the step that matters.",
			linkPath: "/copyright",
			dedupeKey: `report-routed-copyright:${input.subjectType}:${input.subjectId}:${userId}`,
		});
	}

	return { dismissed: rows.length, reportersNotified: reporters.size };
}

/** Dismiss a subject's open reports without touching the content. */
export async function dismissReports(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** The admin account acting. */
	adminId: number;
}): Promise<{ dismissed: number }> {
	const dismissed = await db
		.update(moderationReports)
		.set({ status: "dismissed", resolvedAt: new Date(), resolvedByAdminId: input.adminId })
		.where(
			and(
				eq(moderationReports.subjectType, input.subjectType),
				eq(moderationReports.subjectId, input.subjectId),
				eq(moderationReports.status, "open"),
			),
		)
		.returning({ id: moderationReports.id });
	return { dismissed: dismissed.length };
}

// ── Account suspension ─────────────────────────────────────────────────────

/**
 * Suspend an account and record why. Returns null if the account doesn't exist.
 *
 * Suspension is a **state, never a delete**, applied to an account on the same rule
 * as content removal. One transaction does four things, because any subset is a lie
 * about what happened:
 *
 * 1. **The row records the state.** `suspended_at` is stamped; `suspended_until` is
 *    the end for a temporary suspension and null for an indefinite one — "indefinite"
 *    is a missing value, not a different kind, and a sweep lifts an expired one with
 *    the same record an operator's lift writes. The *reasoning* never goes on the
 *    row: it is appended to `moderation_actions`, so the row answers only "is this
 *    account suspended" and the log answers everything an appeal would ask.
 * 2. **Sessions are destroyed.** A suspended account cannot act — validation refuses
 *    a living session and sign-in refuses a new one — so the tokens are deleted
 *    outright; leaving them would make the refusal one check per reader rather than
 *    one fact. Deleting sessions is not deleting content: a session is a credential,
 *    and `deleteExpiredSessions` already destroys them as routine hygiene.
 * 3. **The decision is appended** as a `suspend` row naming the admin who decided
 *    and the reason they gave. A suspended account with no record of who suspended
 *    it is precisely the state the append-only log exists to prevent.
 * 4. **Open reports against the account are resolved** in the same transaction —
 *    acting on the person is the answer to the report, exactly as `hideSubject` treats
 *    acting on the content.
 *
 * What this deliberately does NOT touch, each chosen rather than emergent:
 *
 * - **Nothing is written to the account's ATProto repository**, and its DID, handle
 *   and records resolve exactly as before. Suspension is an Anthers-platform act;
 *   pretending to reach the identity layer would overclaim a reach the wiki's *How
 *   Removal Works* already says Anthers does not have. Reinstatement therefore
 *   rebuilds nothing.
 * - **The account's Works and purchases are untouched at this layer.** Their pages
 *   stop serving because every reader filters on the account's state; a buyer's
 *   existing Library access survives, because what you buy stays yours. Any final
 *   disposition of the catalog belongs to repeat-infringer termination, which is
 *   built on this state and not part of it.
 * - **Subscriptions and payouts are governed by their own services.** This is the
 *   account state those mechanisms read, not their implementation.
 * - **Legal holds are not consulted.** A hold suspends *destruction*; suspension
 *   destroys nothing, so a preservation order has nothing to say here — and a hold
 *   that could keep an account dark would be a preservation tool doing moderation.
 */
export async function suspendAccount(input: {
	userId: number;
	/** The admin account acting. */
	adminId: number;
	reason: string;
	note?: string;
	/** When the suspension lifts itself. Omit for an indefinite suspension. */
	until?: Date | null;
}): Promise<{ status: "suspended" } | null> {
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);
	if (!account) return null;

	const note = (input.note ?? "").trim().slice(0, MODERATION_NOTE_MAX);

	await db.transaction(async (tx) => {
		await tx
			.update(users)
			.set({ suspendedAt: new Date(), suspendedUntil: input.until ?? null })
			.where(eq(users.id, input.userId));

		await tx.delete(sessions).where(eq(sessions.userId, input.userId));

		await tx.insert(moderationActions).values({
			subjectType: "user",
			subjectId: input.userId,
			action: "suspend" satisfies ModerationActionType,
			adminActorId: input.adminId,
			actorRole: "operator",
			reason: input.reason,
			note,
		});

		await tx
			.update(moderationReports)
			.set({ status: "resolved", resolvedAt: new Date(), resolvedByAdminId: input.adminId })
			.where(
				and(
					eq(moderationReports.subjectType, "user"),
					eq(moderationReports.subjectId, input.userId),
					eq(moderationReports.status, "open"),
		),
			);
	});

	// The holder is told, by email, the moment the state lands. `essential` category:
	// nobody may opt out of being told their account was acted on. The message names the
	// reason category and any end, and points at the appeal path — a suspension somebody
	// learns of from a generic sign-in failure is a support ticket, not a moderation record.
	// The dedupe keys on THIS suspension (by its timestamp), so a re-suspension after a
	// lift mails again while a retry of this same action does not.
	void notify({
		userId: input.userId,
		category: "essential",
		kind: "account_suspended",
		title: "Your Anthers account has been suspended",
		body:
			`Anthers has suspended your account${input.until ? ` until ${input.until.toISOString()}` : ""}. ` +
			`Reason: ${moderationReasonLabel(input.reason)}. ` +
			`While suspended you cannot sign in, and your presence and your works are not shown publicly. ` +
			`If you believe this is a mistake, reply to this email to appeal.`,
		linkPath: "/suspended",
		dedupeKey: `account-suspended:${input.userId}:${Date.now()}`,
	}).catch(() => {});

	return { status: "suspended" };
}

/**
 * Lift a suspension. The reversal is a NEW `unsuspend` row, never an edit of the
 * `suspend` row — the log reads as the sequence of decisions actually taken,
 * including this one.
 *
 * `adminId` is null when the expiry sweep lifts a suspension whose `suspended_until`
 * has passed: the two null actor columns then read as "automated", same convention
 * as everywhere else in the log. Returns null if the account doesn't exist, and is a
 * no-op on an account that is not suspended.
 */
export async function unsuspendAccount(input: {
	userId: number;
	/** The admin account acting, when a person lifted it. Null from the expiry sweep. */
	adminId?: number | null;
	note?: string;
}): Promise<{ status: "visible" } | null> {
	const [account] = await db
		.select({ id: users.id, suspendedAt: users.suspendedAt })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);
	if (!account) return null;
	if (!account.suspendedAt) return { status: "visible" };

	const note = (input.note ?? "").trim().slice(0, MODERATION_NOTE_MAX);

	await db.transaction(async (tx) => {
		await tx
			.update(users)
			.set({ suspendedAt: null, suspendedUntil: null })
			.where(eq(users.id, input.userId));

		await tx.insert(moderationActions).values({
			subjectType: "user",
			subjectId: input.userId,
			action: "unsuspend" satisfies ModerationActionType,
			adminActorId: input.adminId ?? null,
			actorRole: "operator",
			reason: "",
			note,
		});
	});

	// Renewal pause is a state rather than a canceled subscription, so this is the moment
	// the months that ran under suspension rejoin the books — their paid invoices come off
	// `paused` and land against the reinstatement month, where settlement credits what the
	// suspension withheld. Deliberately NOT in the transaction above: a Stripe id was
	// already its own record, and a re-key whose insert had to roll back the whole lift
	// would hold a suspension open on a bookkeeping failure.
	const resumed = await resumePausedRenewals(input.userId, new Date());
	if (resumed > 0) console.log(`moderation: resumed ${resumed} paused renewal(s) on reinstatement`);

	// Told, whoever lifted it — an operator's reversal or the clock. The dedupe keys on
	// the lift itself (`Date.now()`), symmetric with the suspension notice: a later
	// re-suspension and lift is a fresh sequence and mails again.
	void notify({
		userId: input.userId,
		category: "essential",
		kind: "account_reinstated",
		title: "Your Anthers account is reinstated",
		body:
			"Your account's suspension has ended and you can sign in again. " +
			"Your presence and your works are shown publicly once more, and any support paused during the suspension resumes at its next renewal.",
		linkPath: "/login",
		dedupeKey: `account-reinstated:${input.userId}:${Date.now()}`,
	}).catch(() => {});

	return { status: "visible" };
}

/**
 * Lift every temporary suspension whose end has passed. The sweep's job.
 *
 * Each account is its own `unsuspendAccount` call — its own transaction and its own
 * `unsuspend` record — so one failure strands nobody else and the log still reads as
 * one decision per account. Both actor columns are null on each, which is how the
 * log says "the clock lifted this one".
 */
export async function liftExpiredSuspensions(now: Date = new Date()): Promise<number> {
	const due = await db
		.select({ id: users.id })
		.from(users)
		.where(and(isNotNull(users.suspendedAt), isNotNull(users.suspendedUntil), lte(users.suspendedUntil, now)));

	let lifted = 0;
	for (const account of due) {
		const result = await unsuspendAccount({ userId: account.id, note: "Suspension reached its scheduled end." });
		if (result) lifted += 1;
	}
	if (lifted > 0) console.log(`moderation: lifted ${lifted} expired suspension(s)`);
	return lifted;
}

/**
 * Tell each supporter of a suspended creator that their renewal is paused.
 *
 * Runs from a sweep rather than inline in `suspendAccount` for two reasons. First, the
 * supporter set is derived from the invoice ledger — a supporter is whoever's invoice
 * carried a line naming this creator — and that read wants no part of the suspension
 * transaction. Second, each notice is idempotent by its dedupe key, so a sweep that
 * re-runs after a partial failure tells nobody twice, and an hour's latency on a
 * billing notice is invisible where a sign-in refusal's is not.
 *
 * One notice per (supporter, creator, suspension), keyed on the suspension's own
 * `suspendedAt` so a re-suspension after a lift correctly tells supporters again. The
 * message says what is true: renewal is paused (not canceled), it resumes if the
 * suspension lifts, cancel any time. `essential`, because money is moving (or rather,
 * deliberately not moving) and that is not a thing anyone gets to be un-told.
 */
export async function notifySupportersOfSuspensions(): Promise<number> {
	// The line names the creator (`creatorId` non-null is a creator line; null is the
	// Anthers line) and the invoice names the supporter. Two `users` joins: the line's
	// creator for the suspension state, the invoice's supporter for who to tell.
	const creator = alias(users, "creator");
	const rows = await db
		.selectDistinct({
			supporterId: invoices.userId,
			creatorId: invoiceLines.creatorId,
			suspendedAt: creator.suspendedAt,
			creatorHandle: creator.atprotoHandle,
		})
		.from(invoiceLines)
		.innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
		.innerJoin(creator, eq(invoiceLines.creatorId, creator.id))
		.where(and(isNotNull(invoiceLines.creatorId), isNotNull(creator.suspendedAt), isNotNull(invoices.userId)));

	let sent = 0;
	for (const row of rows) {
		if (row.supporterId == null || row.creatorId == null || row.suspendedAt == null) continue;
		const { emailed } = await notify({
			userId: row.supporterId,
			category: "essential",
			kind: "subscription_paused_suspension",
			title: "Your support is paused while this creator is suspended",
			body:
				`The creator you support (@${row.creatorHandle ?? "unknown"}) has been suspended. ` +
				`Your renewal did not charge and will not while the suspension stands — this is a pause, not a cancellation. ` +
				`If the suspension lifts, your support resumes at its next renewal. You can cancel any time from your account settings.`,
			linkPath: "/settings",
			dedupeKey: `subscription-paused-suspension:${row.supporterId}:${row.creatorId}:${row.suspendedAt.getTime()}`,
		});
		if (emailed) sent += 1;
	}
	if (sent > 0)
		console.log(`moderation: notified ${sent} supporter(s) of a suspension pausing their renewal`);
	return sent;
}

// ── The operator queue ──────────────────────────────────────────────────────

/** What the console renders for one moderatable item. */
export interface QueueItem {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** The comment text, or a review's verdict and words — whatever the operator has to judge. */
	excerpt: string;
	verdict: string | null;
	moderationStatus: string;
	createdAt: string;
	author: { id: number; handle: string } | null;
	/**
	 * Where the item lives, so an operator can go read it in context.
	 *
	 * `kind` exists because that is no longer always a post: comments hang off a Post or a
	 * Work, and reviews only off a Work. Calling this `post` and quietly filling it with a
	 * Work's slug would send the operator to a 404. A reported *person* carries a
	 * `profile` context pointing at their own profile — the report is about a pattern, so
	 * the place to go look is everything they've said.
	 */
	context: { kind: "post" | "work" | "profile"; slug: string; title: string } | null;
	/**
	 * Whether an operator can hide this from the console at all. False for a person —
	 * see `hideSubject`. The console needs to know before it renders a button that
	 * would only ever return 400.
	 */
	moderatable: boolean;
	/**
	 * The Work's content rating, on a reported Work and nowhere else.
	 *
	 * Present so the console can offer the one thing an operator can actually do to a
	 * Work from this queue — correct its rating — without a second round trip per row,
	 * and so the row shows what it currently says. Null on every other subject type,
	 * which have no rating to carry.
	 */
	maturity?: string | null;
	openReports: number;
	totalReports: number;
	reasons: string[];
	details: string[];
	/**
	 * Whether every legal report on this subject has actually reached a human, and
	 * when the last one did.
	 *
	 * 🚨 **An operator could not tell before this existed.** `escalated_at` is the only
	 * record that somebody outside the console was told, and the console — the one place a
	 * legal report is looked at — did not read it. So the two failure modes the stamp
	 * exists to separate were both invisible from here: an alert that never sent, and an
	 * alert that sent to a mailbox nobody was watching.
	 *
	 * `null` on a subject with no legal reports at all, which is the ordinary case
	 * and is deliberately distinct from `false`.
	 */
	legalAlerted: boolean | null;
	/** When the most recent legal report on this subject was escalated, or null. */
	lastEscalatedAt: string | null;
	lastAction: {
		action: string;
		reason: string;
		note: string;
		createdAt: string;
		actor: string | null;
	} | null;
}

export type QueueFilter = "reported" | "comments" | "reviews" | "people" | "hidden";

export const QUEUE_LIMIT = 100;

/**
 * Assemble the operator's list.
 *
 * `reported` — the queue proper: anything with an open report, most-reported first.
 * `comments` / `reviews` — recent activity, so an operator can act on something
 *   nobody reported. Reviews carry words and a report control, so the queue is fed
 *   by readers; browse stays because acting before anyone complains is still worth
 *   being able to do.
 * `people` — reported accounts only. Unlike the two above, this is NOT a browse over
 *   recent rows: "every account, newest first" is a user directory, not a moderation
 *   surface, and reading one under a moderation header invites acting on someone
 *   nobody complained about.
 * `hidden` — what we've already taken down, which is how a restore gets found. It
 *   cannot contain a person: an account has no hidden state to be in.
 */
export async function loadQueue(filter: QueueFilter): Promise<QueueItem[]> {
	const subjectTypes: ModerationSubjectType[] =
		filter === "comments" ? ["comment"] : filter === "reviews" ? ["review"] : ["comment", "review"];

	// 1. Pick the (type, id) pairs this filter is about.
	let keys: { subjectType: ModerationSubjectType; subjectId: number }[];

	if (filter === "reported") {
		// Orphans are excluded HERE, in SQL, rather than after hydration below.
		//
		// Reports are polymorphic with no FK on the subject, so deleting a post cascades
		// its comments away and strands their reports. Hydration already drops those — but
		// it runs *after* this `LIMIT`, so a stranded report still consumed a slot and then
		// disappeared. With enough of them the queue returns almost nothing while
		// `summary.openReports` insists there is work, and *which* live items survive comes
		// down to how Postgres happens to break ties among equal report counts. Observed on
		// a dev database carrying 114 reported subjects of which 113 were orphaned: the one
		// real entry made the page only sometimes, which is what made `moderation.test.ts`
		// flaky rather than any timing.
		//
		// Ordering also gains a tie-break. Report counts are mostly 1, so `count DESC` alone
		// left the order — and therefore the contents of the page — unspecified. Newest
		// first among equals: an operator refreshing the queue should not see it reshuffle.
		// `subjectStillExists` is the predicate `moderationSummary` already uses, reused
		// rather than restated so the queue and its own headline count cannot disagree.
		const rows = await db
			.select({
				subjectType: moderationReports.subjectType,
				subjectId: moderationReports.subjectId,
				n: count(moderationReports.id),
				newest: max(moderationReports.createdAt),
			})
			.from(moderationReports)
			.where(and(eq(moderationReports.status, "open"), subjectStillExists))
			.groupBy(moderationReports.subjectType, moderationReports.subjectId)
			.orderBy(desc(count(moderationReports.id)), desc(max(moderationReports.createdAt)))
			.limit(QUEUE_LIMIT);
		keys = rows.map((r) => ({
			subjectType: r.subjectType as ModerationSubjectType,
			subjectId: r.subjectId,
		}));
	} else if (filter === "people") {
		// Reported accounts only — see the note on the filter. Same orphan predicate and
		// same tie-break as `reported`, restricted to the one subject type.
		const rows = await db
			.select({
				subjectId: moderationReports.subjectId,
				n: count(moderationReports.id),
				newest: max(moderationReports.createdAt),
			})
			.from(moderationReports)
			.where(
				and(
					eq(moderationReports.status, "open"),
					eq(moderationReports.subjectType, "user"),
					subjectStillExists,
				),
			)
			.groupBy(moderationReports.subjectId)
			.orderBy(desc(count(moderationReports.id)), desc(max(moderationReports.createdAt)))
			.limit(QUEUE_LIMIT);
		keys = rows.map((r) => ({ subjectType: "user" as const, subjectId: r.subjectId }));
	} else {
		keys = [];
		for (const subjectType of subjectTypes as ContentSubjectType[]) {
			const table = CONTENT_SUBJECTS[subjectType];
			const rows = await db
				.select({ id: table.id })
				.from(table)
				.where(filter === "hidden" ? eq(table.moderationStatus, "hidden") : undefined)
				.orderBy(desc(table.createdAt))
				.limit(QUEUE_LIMIT);
			keys.push(...rows.map((r) => ({ subjectType, subjectId: r.id })));
		}
	}

	if (keys.length === 0) return [];

	// 2. Hydrate each subject type in one query, then stitch. The branches differ only
	//    in the column carrying the thing an operator has to judge — a comment's text,
	//    a review's verdict, a person's profile — so the row they produce is shared.
	const items = new Map<string, QueueItem>();
	const key = (t: string, id: number) => `${t}:${id}`;

	const commentIds = keys.filter((k) => k.subjectType === "comment").map((k) => k.subjectId);
	const reviewIds = keys.filter((k) => k.subjectType === "review").map((k) => k.subjectId);
	const userIds = keys.filter((k) => k.subjectType === "user").map((k) => k.subjectId);
	const workIdKeys = keys.filter((k) => k.subjectType === "work").map((k) => k.subjectId);

	type QueueContext = QueueItem["context"];

	/**
	 * Resolve `(kind, id)` pairs to the slug and title an operator can navigate to.
	 *
	 * Batched by kind rather than joined per row, because a comment's subject is
	 * polymorphic — there is no single table to LEFT JOIN against, which is the price the
	 * moderation tables already pay for their own polymorphism.
	 */
	async function loadContexts(
		refs: { kind: "post" | "work"; id: number }[],
	): Promise<Map<string, QueueContext>> {
		const out = new Map<string, QueueContext>();
		const postIds = [...new Set(refs.filter((r) => r.kind === "post").map((r) => r.id))];
		const workIds = [...new Set(refs.filter((r) => r.kind === "work").map((r) => r.id))];
		if (postIds.length > 0) {
			const rows = await db
				.select({ id: posts.id, slug: posts.slug, title: posts.title })
				.from(posts)
				.where(inArray(posts.id, postIds));
			for (const r of rows) {
				out.set(`post:${r.id}`, { kind: "post", slug: r.slug, title: r.title ?? "" });
			}
		}
		if (workIds.length > 0) {
			const rows = await db
				.select({ id: works.id, slug: works.slug, title: works.title })
				.from(works)
				.where(inArray(works.id, workIds));
			for (const r of rows) {
				out.set(`work:${r.id}`, { kind: "work", slug: r.slug, title: r.title ?? "" });
			}
		}
		return out;
	}

	function base(
		subjectType: ModerationSubjectType,
		r: {
			id: number;
			userId: number | null;
			handle: string | null;
			moderationStatus: string;
			createdAt: Date;
		},
		context: QueueContext,
	): Omit<QueueItem, "excerpt" | "verdict"> {
		return {
			subjectType,
			subjectId: r.id,
			moderationStatus: r.moderationStatus,
			createdAt: r.createdAt.toISOString(),
			author: r.handle && r.userId != null ? { id: r.userId, handle: r.handle } : null,
			context,
			moderatable: isModeratableContent(subjectType),
			openReports: 0,
			totalReports: 0,
			reasons: [],
			details: [],
			legalAlerted: null,
			lastEscalatedAt: null,
			lastAction: null,
		};
	}

	if (commentIds.length > 0) {
		const rows = await db
			.select({
				id: comments.id,
				userId: comments.userId,
				handle: users.atprotoHandle,
				subjectType: comments.subjectType,
				subjectId: comments.subjectId,
				moderationStatus: comments.moderationStatus,
				createdAt: comments.createdAt,
				body: comments.body,
			})
			.from(comments)
			.leftJoin(users, eq(comments.userId, users.id))
			.where(inArray(comments.id, commentIds));
		// ⚠️ **A reply is about a comment, and the page an operator needs is the post above it.**
		// Its own `subject_id` names the comment it answers, so reading that as a post's id would
		// link the queue to whichever post happens to share the number.
		const replyRoots = await commentRoots(
			rows.filter((r) => r.subjectType === REPLY_SUBJECT_TYPE).map((r) => r.id),
		);
		const rootOf = (r: (typeof rows)[number]) =>
			r.subjectType === REPLY_SUBJECT_TYPE
				? replyRoots.get(r.id)
				: { subjectType: r.subjectType, subjectId: r.subjectId };
		const roots = rows.map(rootOf).filter((root) => root !== undefined);
		const contexts = await loadContexts(
			roots.map((root) => ({
				kind: root.subjectType === "work" ? "work" : "post",
				id: root.subjectId,
			})),
		);
		for (const r of rows) {
			const root = rootOf(r);
			items.set(key("comment", r.id), {
				...base(
					"comment",
					r,
					root ? (contexts.get(`${root.subjectType}:${root.subjectId}`) ?? null) : null,
				),
				excerpt: r.body,
				verdict: null,
			});
		}
	}

	if (reviewIds.length > 0) {
		const rows = await db
			.select({
				id: reviews.id,
				userId: reviews.userId,
				handle: users.atprotoHandle,
				workId: reviews.workId,
				moderationStatus: reviews.moderationStatus,
				createdAt: reviews.createdAt,
				verdict: reviews.verdict,
				body: reviews.body,
			})
			.from(reviews)
			.leftJoin(users, eq(reviews.userId, users.id))
			.where(inArray(reviews.id, reviewIds));
		const contexts = await loadContexts(
			rows
				.filter((r) => r.workId != null)
				.map((r) => ({ kind: "work" as const, id: r.workId as number })),
		);
		for (const r of rows) {
			items.set(key("review", r.id), {
				...base("review", r, r.workId != null ? (contexts.get(`work:${r.workId}`) ?? null) : null),
				// Verdict first so the operator sees where the reviewer landed, then the
				// words that justify it — the words are the part there's actually a call to
				// make on. `body` is empty on rows predating the write-time text requirement.
				excerpt: r.body ? `${verdictLabel(r.verdict)} — ${r.body}` : verdictLabel(r.verdict),
				verdict: r.verdict,
			});
		}
	}

	// A reported person. The subject IS the author here, which is why `base` takes the
	// user row twice — a person's report is about them, not about something of theirs.
	//
	// The excerpt is the profile the operator would land on: display name and bio, the
	// only text an account carries. It is deliberately thin, and it is meant to be: a
	// person report is judged from the reporter's `details` plus the profile it points
	// at, which is exactly why `details` is required for this subject type.
	if (userIds.length > 0) {
		const rows = await db
			.select({
				id: users.id,
				handle: users.atprotoHandle,
				displayName: users.displayName,
				bio: users.bio,
				createdAt: users.createdAt,
			})
			.from(users)
			.where(inArray(users.id, userIds));
		for (const r of rows) {
			// An account that has not finished onboarding has no handle and no profile to
			// link to. It should not be reportable in the first place — there is nothing of
			// theirs to see — but the queue is built from reports, and a report names an id
			// rather than a handle, so this has to render rather than crash. The id is the
			// only thing an operator can act on, so the id is what it says; the empty slug
			// is how the console is told there is nowhere to go.
			const handle = r.handle ? `@${r.handle}` : `account #${r.id}`;
			const label = r.displayName ? `${r.displayName} (${handle})` : handle;
			items.set(key("user", r.id), {
				...base(
					"user",
					{
						id: r.id,
						userId: r.id,
						handle: r.handle,
						moderationStatus: "visible",
						createdAt: r.createdAt,
					},
					{ kind: "profile", slug: r.handle ?? "", title: label },
				),
				excerpt: r.bio ? `${label} — ${r.bio}` : label,
				verdict: null,
			});
		}
	}

	// A reported Work.
	//
	// 🚨 **The key list has always been able to contain one and hydration never could**,
	// so a reported Work reached this point and was silently dropped — it consumed a slot
	// in the `LIMIT` above and then vanished, exactly the orphan failure the `reported`
	// branch documents at length and guards against for a different cause. Nothing noticed
	// because until the report taxonomy gained a reason that names a Work, the only way to
	// file one was a copyright complaint routed out by hand.
	//
	// ⚠️ `moderatable` is false, from `isModeratableContent`, and that is correct rather
	// than an omission: a Work has no `moderation_status` and hiding one is a takedown or a
	// quarantine, each with its own service and its own record. What an operator CAN do
	// from here is correct its rating.
	if (workIdKeys.length > 0) {
		const rows = await db
			.select({
				id: works.id,
				creatorId: works.creatorId,
				handle: users.atprotoHandle,
				slug: works.slug,
				title: works.title,
				description: works.description,
				maturity: works.maturity,
				createdAt: works.createdAt,
			})
			.from(works)
			.leftJoin(users, eq(works.creatorId, users.id))
			.where(inArray(works.id, workIdKeys));
		for (const r of rows) {
			items.set(key("work", r.id), {
				...base(
					"work",
					{
						id: r.id,
						userId: r.creatorId,
						handle: r.handle,
						// A Work's own removal states live in `takedown_status` and
						// `quarantine_status`, neither of which is this column's vocabulary.
						moderationStatus: "visible",
						createdAt: r.createdAt,
					},
					{ kind: "work", slug: r.slug, title: r.title ?? "" },
				),
				// Title and blurb: what the operator can judge without opening it, and the
				// rating they may be being asked to correct.
				excerpt: r.description
					? `${r.title ?? "Untitled"} — ${r.description.slice(0, 400)}`
					: (r.title ?? "Untitled"),
				verdict: null,
				maturity: r.maturity,
			});
		}
	}

	if (items.size === 0) return [];

	// 3. Attach report counts + reasons for everything on the list (not just the
	//    reported filter — an operator browsing recent comments should still see
	//    that one of them has three standing reports).
	//
	//    Both this query and the next filter on subject id ALONE, which over-fetches:
	//    comment #5 and rating #5 are different subjects with the same id. The
	//    `items.get(key(type, id))` lookup is what disambiguates them — a row whose
	//    (type, id) pair isn't on the list finds no item and is dropped. Filtering on
	//    the pairs in SQL would mean a row-constructor IN clause for a handful of
	//    surplus rows on a page-sized list.
	const reportRows = await db
		.select({
			subjectType: moderationReports.subjectType,
			subjectId: moderationReports.subjectId,
			status: moderationReports.status,
			reason: moderationReports.reason,
			details: moderationReports.details,
			escalatedAt: moderationReports.escalatedAt,
		})
		.from(moderationReports)
		.where(
			inArray(
				moderationReports.subjectId,
				[...items.values()].map((i) => i.subjectId),
			),
		);

	for (const r of reportRows) {
		const item = items.get(key(r.subjectType, r.subjectId));
		if (!item) continue;
		item.totalReports += 1;
		if (r.status === "open") item.openReports += 1;
		if (!item.reasons.includes(r.reason)) item.reasons.push(r.reason);
		if (r.details) item.details.push(r.details);

		// Only legal reasons are ever owed an alert, so only they may answer this. An
		// ordinary report has a permanently null `escalated_at`, and folding those in would
		// make every spam report read as "nobody was told" — which is true and is not a
		// problem, and would bury the case where it IS a problem.
		if (!isLegalReason(r.reason)) continue;
		if (r.escalatedAt) {
			const stamp = r.escalatedAt.toISOString();
			if (!item.lastEscalatedAt || stamp > item.lastEscalatedAt) item.lastEscalatedAt = stamp;
		}
		// False wins over true: one un-alerted legal report is the thing worth surfacing,
		// however many of its neighbors went out.
		item.legalAlerted = item.legalAlerted === false ? false : Boolean(r.escalatedAt);
	}

	// 4. Attach the most recent decision, so a hidden item shows who hid it and why.
	const actionRows = await db
		.select({
			subjectType: moderationActions.subjectType,
			subjectId: moderationActions.subjectId,
			action: moderationActions.action,
			reason: moderationActions.reason,
			note: moderationActions.note,
			createdAt: moderationActions.createdAt,
			actor: adminAccounts.displayName,
		})
		.from(moderationActions)
		.leftJoin(adminAccounts, eq(moderationActions.adminActorId, adminAccounts.id))
		.where(
			inArray(
				moderationActions.subjectId,
				[...items.values()].map((i) => i.subjectId),
			),
		)
		.orderBy(desc(moderationActions.createdAt));

	for (const a of actionRows) {
		const item = items.get(key(a.subjectType, a.subjectId));
		// Rows arrive newest-first, so the first one we see for a subject is the latest.
		if (!item || item.lastAction) continue;
		item.lastAction = {
			action: a.action,
			reason: a.reason,
			note: a.note,
			createdAt: a.createdAt.toISOString(),
			actor: a.actor,
		};
	}

	const list = [...items.values()];
	if (filter === "reported") {
		list.sort((a, b) => b.openReports - a.openReports || b.createdAt.localeCompare(a.createdAt));
	} else {
		list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	return list.slice(0, QUEUE_LIMIT);
}

/**
 * A report whose subject still exists.
 *
 * Reports are polymorphic, so there is no foreign key holding them to their
 * subject, and every path that removes content leaves reports behind: deleting a
 * post cascades its comments and reviews away, deleting an account cascades that
 * user's, and the gauntlet fixture clears comments between runs. Those orphans
 * can never appear in the queue — `loadQueue` hydrates from the content tables,
 * so a report naming a row that isn't there finds nothing to render and is
 * dropped.
 *
 * The counts have to agree with that, or the console shows "3 open reports" over
 * an empty queue and the operator has no way to clear it. Filtering on the read
 * side rather than deleting reports at each cascade point is the version that
 * can't be forgotten by the next thing that deletes content — and it keeps the
 * reports themselves, which are records, rather than quietly erasing them.
 *
 * The `user` branch matters more than the other two, not less: `users` is the row
 * everything else cascades FROM, so a deleted account strands not only its own
 * reports but every report about it. Both `users` FKs on the report are `set null`
 * for the actor and reporter side — deliberately, so the record outlives the account
 * — and the *subject* side has no FK at all, so this predicate is the only thing
 * standing between a deleted account and a permanently unclearable queue entry.
 */
const subjectStillExists = or(
	and(
		eq(moderationReports.subjectType, "comment"),
		exists(
			db.select({ one: sql`1` }).from(comments).where(eq(comments.id, moderationReports.subjectId)),
		),
	),
	and(
		eq(moderationReports.subjectType, "review"),
		exists(
			db.select({ one: sql`1` }).from(reviews).where(eq(reviews.id, moderationReports.subjectId)),
		),
	),
	and(
		eq(moderationReports.subjectType, "user"),
		exists(db.select({ one: sql`1` }).from(users).where(eq(users.id, moderationReports.subjectId))),
	),
	and(
		eq(moderationReports.subjectType, "work"),
		exists(db.select({ one: sql`1` }).from(works).where(eq(works.id, moderationReports.subjectId))),
	),
);

/**
 * Headline counts for the console: open reports, and what's currently hidden.
 *
 * `reportedPeople` is counted separately from `openReports` rather than being
 * inferred from it, because it is the one bucket with no in-app remedy — an operator
 * seeing it needs to know it is there precisely because clearing it means acting
 * somewhere other than this console.
 */
export async function moderationSummary(): Promise<{
	openReports: number;
	reportedSubjects: number;
	reportedPeople: number;
	hiddenComments: number;
	hiddenReviews: number;
}> {
	const [open] = await db
		.select({
			reports: count(moderationReports.id),
			subjects: sql<number>`count(DISTINCT (${moderationReports.subjectType}, ${moderationReports.subjectId}))::int`,
			people: sql<number>`count(DISTINCT ${moderationReports.subjectId}) FILTER (WHERE ${moderationReports.subjectType} = 'user')::int`,
		})
		.from(moderationReports)
		.where(and(eq(moderationReports.status, "open"), subjectStillExists));

	const [hiddenC] = await db
		.select({ n: count(comments.id) })
		.from(comments)
		.where(eq(comments.moderationStatus, "hidden"));
	const [hiddenR] = await db
		.select({ n: count(reviews.id) })
		.from(reviews)
		.where(eq(reviews.moderationStatus, "hidden"));

	return {
		openReports: Number(open?.reports ?? 0),
		reportedSubjects: Number(open?.subjects ?? 0),
		reportedPeople: Number(open?.people ?? 0),
		hiddenComments: Number(hiddenC?.n ?? 0),
		hiddenReviews: Number(hiddenR?.n ?? 0),
	};
}

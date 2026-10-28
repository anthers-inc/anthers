// SPDX-License-Identifier: Apache-2.0
/**
 * Illegal-content reports from anybody at all — the notice-and-action route that does
 * not ask who you are.
 *
 * 🚨 **The gap this closes.** `POST /api/moderation/reports` sits behind `requireAuth`,
 * so until this existed a signed-out person had no way to report illegal content on
 * Anthers at all. DSA Art. 16 requires a mechanism open to **anyone** rather than to
 * members, and the address registered with NCMEC was published nowhere a member of the
 * public could find it. An email address closed the live gap; this is the form.
 *
 * **Why this is not `services/moderation.ts`.** the child-safety coverage map, which is deliberately not public states it directly: *"This is not
 * a moderation decision — it is a detection-and-report pipeline with a different
 * destination, and running it through the ordinary queue would lose it."* The ordinary
 * queue is polymorphic over a row in one of our own tables; a member of the public has a
 * URL, which is what the statute asks them for. The shape copied instead is
 * `services/dmca.ts` — a public, no-auth statutory intake with its own queue.
 *
 * ⭐ **The durability design is inherited from `escalateReport` and is the same one.**
 * The row commits, then the send follows, and its `outbound_emails` row is what says a
 * human was actually told. A `try/catch` that logs turns *"a queue nobody watches"* into
 * *"an email nobody sent"*, one layer down; the retry sweep re-selects anything the
 * ledger has no send stamp for. That matters more here than for an in-app report, because
 * the person who filed this may have no account and therefore no other way to ever hear
 * anything.
 */

import { db } from "@anthers/db/client";
import { abuseReports, outboundEmails, works } from "@anthers/db/schema";
import { ABUSE_EMAIL } from "@anthers/shared/constants";
import {
	isLegalReason,
	LEGAL_MODERATION_REASONS,
	moderationReasonLabel,
} from "@anthers/shared/moderation";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { abuseAlertsEnabled, escapeHtml, sendAbuseAlert } from "./email.js";
import { allHeldSubjectIds } from "./legal-hold.js";

/** DSA Art. 16 asks for a substantiated explanation; this is what "substantiated" costs. */
export const ABUSE_DETAILS_MIN = 10;
export const ABUSE_DETAILS_MAX = 4000;
export const ABUSE_URL_MAX = 2000;

export interface FileAbuseReportInput {
	/** The location, exactly as typed. Stored verbatim. */
	url: string;
	reason: string;
	details: string;
	/** Optional — see the schema note on why requiring one would be the wrong trade. */
	reporterEmail?: string;
	/** Present only if they happened to be signed in. */
	reporterId?: number | null;
}

/**
 * Which Work a reported URL names, when it names one.
 *
 * Anthers addresses a Work as `/works/{slug}-{publicId}`, and the **publicId is the
 * durable half** — a rename changes the slug and leaves the id, which is exactly why the
 * scheme exists. So the id is what this matches on and the slug is ignored.
 *
 * ⚠️ **Failing to resolve is an ordinary outcome, never an error.** The link may name a
 * post, a profile, something already gone, or a site that is not ours; a reporter pasting
 * the wrong thing must still get their report filed, because the alternative is a form
 * that rejects the person least able to work out why. The URL they typed is the record.
 */
export async function resolveReportedWork(url: string): Promise<number | null> {
	const match = /\/works\/[^/?#]*?-(\d{6,})(?:[/?#]|$)/.exec(url);
	if (!match) return null;
	const publicId = Number(match[1]);
	if (!Number.isSafeInteger(publicId)) return null;
	const [row] = await db
		.select({ id: works.id })
		.from(works)
		.where(eq(works.publicId, publicId))
		.limit(1);
	return row?.id ?? null;
}

/**
 * File a report and, for a legal reason, tell a human out of band.
 *
 * Not idempotent, unlike `fileReport`. That one deduplicates on (reporter, subject) so a
 * single account cannot inflate the count the queue sorts by — a defense that needs an
 * identified reporter to work at all. Here there is deliberately no identity, so the
 * equivalent protection has to live at the edge rather than in the key.
 */
export async function fileAbuseReport(input: FileAbuseReportInput): Promise<{ reportId: number }> {
	const url = input.url.trim().slice(0, ABUSE_URL_MAX);
	const [row] = await db
		.insert(abuseReports)
		.values({
			url,
			workId: await resolveReportedWork(url),
			reason: input.reason,
			details: input.details.trim().slice(0, ABUSE_DETAILS_MAX),
			reporterEmail: (input.reporterEmail ?? "").trim().slice(0, 320),
			reporterId: input.reporterId ?? null,
		})
		.returning({ id: abuseReports.id });

	// Committed first, sent second — see the module note.
	if (isLegalReason(input.reason)) await escalateAbuseReport(row.id);

	return { reportId: row.id };
}

/**
 * Tell a human that a public report exists.
 *
 * 🚨 **Carries the locator and never the content**, exactly as `escalateReport` does, and
 * for the statutory reason rather than for tidiness: § 2258B conditions the provider's
 * immunity on minimizing how many people have access to reported depictions, and an alert
 * that reproduces the material into an inbox widens that population without anyone
 * deciding to. What goes out is the URL, the reason, the time, and the reporter's own
 * words — which are text a reporter wrote rather than the material, and are what makes
 * the alert actionable at all.
 *
 * Never throws. The report is already committed, and a failure here is the sweep's
 * problem rather than the reporter's.
 */
export async function escalateAbuseReport(reportId: number): Promise<boolean> {
	const [report] = await db
		.select()
		.from(abuseReports)
		.where(eq(abuseReports.id, reportId))
		.limit(1);

	if (!report) return false;
	// One alert per report, ever: the ledger row is the latch. A row without a send stamp
	// is an alert that was decided on and did not go, which the retry sweep tries again.
	const mailKey = `abuse-escalation:${report.id}`;
	const [existing] = await db
		.select({ id: outboundEmails.id, sentAt: outboundEmails.sentAt })
		.from(outboundEmails)
		.where(eq(outboundEmails.dedupeKey, mailKey))
		.limit(1);
	if (existing?.sentAt) return true;
	if (!isLegalReason(report.reason)) return false;

	const label = moderationReasonLabel(report.reason);
	const subject = `[Anthers] Public report: ${label}`;
	const html = [
		`<p><strong>${label}</strong> reported by a member of the public.</p>`,
		`<p>Reported location: <code>${escapeHtml(report.url)}</code></p>`,
		report.workId
			? `<p>That resolves to Work ${report.workId}.</p>`
			: "<p>That did not resolve to a Work on Anthers — read the link as given.</p>",
		`<p>Report ID ${report.id}, filed ${report.createdAt.toISOString()}.</p>`,
		`<p>What the reporter said:</p><blockquote>${escapeHtml(report.details)}</blockquote>`,
		report.reporterEmail
			? `<p>They left <code>${escapeHtml(report.reporterEmail)}</code> to be reached at.</p>`
			: "<p>They left no address, so there is nobody to reply to.</p>",
		"<p>Open the public reports queue in the admin console to act on it.</p>",
		"<p>If this is child sexual abuse material, an enticement of a child, or child sex trafficking, stop here and follow the incident runbook. Do not open the content.</p>",
	].join("\n");

	// The row is written BEFORE the send, so a crash between them loses an alert rather
	// than duplicating one; a refused send leaves `sentAt` null for the sweep.
	const [mailRow] = existing
		? [existing]
		: await db
				.insert(outboundEmails)
				.values({
					dedupeKey: mailKey,
					kind: "escalation",
					recipient: ABUSE_EMAIL,
					subject,
					detail: {
						reportKind: "abuse_report",
						reportId: String(report.id),
						reason: report.reason,
					},
				})
				.returning({ id: outboundEmails.id, sentAt: outboundEmails.sentAt });

	const { sent, messageId } = await sendAbuseAlert({ subject, html });
	if (!sent) return false;

	// The provider's id rides with the stamp so the delivery webhook can say what became of
	// the message, which is the question the alert exists to answer.
	await db
		.update(outboundEmails)
		.set({ sentAt: new Date(), messageId })
		.where(eq(outboundEmails.id, mailRow.id));
	return true;
}

/**
 * Public reports nobody has been told about. Exported so a test can assert on the
 * selection without sending anything.
 *
 * ⚠️ Ignores `status`, like its `moderation_reports` counterpart: a report an operator
 * resolved still gets its alert, because *"somebody dismissed it before anyone outside the
 * console was told"* is precisely the hole the alert exists to close.
 */
export async function pendingAbuseEscalations(): Promise<number[]> {
	const rows = await db
		.select({ id: abuseReports.id })
		.from(abuseReports)
		.leftJoin(
			outboundEmails,
			eq(outboundEmails.dedupeKey, sql`'abuse-escalation:' || ${abuseReports.id}`),
		)
		.where(
			and(
				inArray(abuseReports.reason, [...LEGAL_MODERATION_REASONS]),
				isNull(outboundEmails.sentAt),
			),
		)
		.orderBy(abuseReports.createdAt);
	return rows.map((r) => r.id);
}

/** Retry every public report that has not reached a person yet. Returns how many did. */
export async function runAbuseEscalationSweep(): Promise<number> {
	// Same refusal as the escalation sweep — see `abuseAlertsEnabled`.
	if (!abuseAlertsEnabled()) return 0;
	const ids = await pendingAbuseEscalations();
	let sent = 0;
	for (const id of ids) if (await escalateAbuseReport(id)) sent++;
	return sent;
}

/**
 * Drop the reporter's words and contact address on reports past the clock.
 *
 * The counterpart of `redactClosedModerationReports`, and it exists for the same reason a
 * new table always needs one: a PII-carrying table with no retention behind it is exactly
 * the gap this whole lane was opened to close. What survives is the report, its URL, its
 * reason and its outcome — the record of what was reported and what we did; what goes is
 * the free text a member of the public wrote and the address they left.
 *
 * 🚨 A redaction is a destruction for legal-hold purposes even though nothing here says
 * DELETE, so a held report keeps both until the hold lifts.
 */
export async function redactClosedAbuseReports(
	cutoff: Date,
	now = new Date(),
): Promise<{ redacted: number }> {
	const settled = sql`coalesce(${abuseReports.resolvedAt}, ${abuseReports.createdAt}) <= ${cutoff.toISOString()}::timestamptz`;
	const held = await allHeldSubjectIds("abuse_report", now);
	const notHeld = held.length > 0 ? notInArray(abuseReports.id, held) : undefined;

	const rows = await db
		.update(abuseReports)
		.set({ details: "", reporterEmail: "", reporterId: null, redactedAt: now })
		.where(
			and(isNull(abuseReports.redactedAt), sql`${abuseReports.status} <> 'open'`, settled, notHeld),
		)
		.returning({ id: abuseReports.id });

	return { redacted: rows.length };
}

/**
 * Close a public report, with or without having acted on what it named.
 *
 * 🚨 **A queue with no way to act on it is not a queue**, and this table shipped without
 * one — every row stayed `open` forever, so the list could only grow and an operator had
 * no way to say *"I looked."* The two outcomes mirror `services/moderation.ts`:
 * `resolved` means something was done about the content, `dismissed` means it was read and
 * needed nothing.
 *
 * ⚠️ **Closing a report does not un-owe its alert**, and that asymmetry is deliberate.
 * `pendingAbuseEscalations` ignores `status` on purpose, because *"somebody dismissed it
 * before anyone outside the console was told"* is precisely the hole the alert exists to
 * close. So a dismissed legal report still gets its email.
 */
export async function closeAbuseReport(input: {
	reportId: number;
	/** The admin account acting. */
	adminId: number;
	outcome: "resolved" | "dismissed";
}): Promise<boolean> {
	const rows = await db
		.update(abuseReports)
		.set({
			status: input.outcome,
			resolvedAt: new Date(),
			resolvedBy: input.adminId,
		})
		.where(and(eq(abuseReports.id, input.reportId), eq(abuseReports.status, "open")))
		.returning({ id: abuseReports.id });
	return rows.length > 0;
}

/** What the operator's list carries. Metadata and the reporter's words — never a rendering. */
export interface AbuseQueueItem {
	id: number;
	url: string;
	workId: number | null;
	reason: string;
	details: string;
	reporterEmail: string;
	status: string;
	escalatedAt: string | null;
	createdAt: string;
}

/** The operator's list of public reports. Open ones first, newest first. */
export async function loadAbuseQueue(
	opts: { includeClosed?: boolean; limit?: number } = {},
): Promise<AbuseQueueItem[]> {
	const rows = await db
		.select()
		.from(abuseReports)
		.where(opts.includeClosed ? undefined : eq(abuseReports.status, "open"))
		.orderBy(desc(abuseReports.createdAt))
		.limit(opts.limit ?? 200);

	// The alert evidence lives on the mail ledger; one query answers the page.
	const escalatedAtById = new Map<number, Date>();
	if (rows.length > 0) {
		const mails = await db
			.select({ dedupeKey: outboundEmails.dedupeKey, sentAt: outboundEmails.sentAt })
			.from(outboundEmails)
			.where(
				inArray(
					outboundEmails.dedupeKey,
					rows.map((r) => `abuse-escalation:${r.id}`),
				),
			);
		for (const mail of mails) {
			if (!mail.sentAt) continue;
			const id = Number(mail.dedupeKey.split(":")[1]);
			if (Number.isFinite(id)) escalatedAtById.set(id, mail.sentAt);
		}
	}

	return rows.map((r) => ({
		id: r.id,
		url: r.url,
		workId: r.workId,
		reason: r.reason,
		details: r.details,
		reporterEmail: r.reporterEmail,
		status: r.status,
		escalatedAt: escalatedAtById.get(r.id)?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString(),
	}));
}

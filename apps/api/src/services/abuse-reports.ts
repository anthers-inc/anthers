// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * **Why this is not `services/moderation.ts`.** 40.12 states it directly: *"This is not
 * a moderation decision — it is a detection-and-report pipeline with a different
 * destination, and running it through the ordinary queue would lose it."* The ordinary
 * queue is polymorphic over a row in one of our own tables; a member of the public has a
 * URL, which is what the statute asks them for. The shape copied instead is
 * `services/dmca.ts` — a public, no-auth statutory intake with its own queue.
 *
 * ⭐ **The durability design is inherited from `escalateReport` and is the same one.**
 * The row commits, then the send follows, and `escalated_at` is what says a human was
 * actually told. A `try/catch` that logs turns *"a queue nobody watches"* into *"an email
 * nobody sent"*, one layer down; the retry sweep re-selects anything still null. That
 * matters more here than for an in-app report, because the person who filed this may have
 * no account and therefore no other way to ever hear anything.
 */

import { db } from "@anthers/db/client";
import { abuseReports, works } from "@anthers/db/schema";
import { ABUSE_EMAIL } from "@anthers/shared/constants";
import {
	FLOOR_MODERATION_REASONS,
	isFloorReason,
	moderationReasonLabel,
} from "@anthers/shared/moderation";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { sendEmail } from "./email.js";
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
 * File a report and, for a floor-level reason, tell a human out of band.
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
	if (isFloorReason(input.reason)) await escalateAbuseReport(row.id);

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
	if (report.escalatedAt) return true; // Already told somebody; don't tell them twice.
	if (!isFloorReason(report.reason)) return false;

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
		"<p>If this is child sexual abuse material, an enticement of a child, or child sex trafficking, stop here and follow the incident runbook (60.14). Do not open the content.</p>",
	].join("\n");

	const sent = await sendEmail({ to: ABUSE_EMAIL, subject, html });
	if (!sent) return false;

	await db
		.update(abuseReports)
		.set({ escalatedAt: new Date() })
		.where(eq(abuseReports.id, reportId));
	return true;
}

/**
 * Public reports nobody has been told about. Exported so a test can assert on the
 * selection without sending anything.
 *
 * ⚠️ Ignores `status`, like its `moderation_reports` counterpart: a report an operator
 * resolved still gets its alert, because *"somebody dismissed it before anyone outside the
 * console was told"* is precisely the hole the floor exists to close.
 */
export async function pendingAbuseEscalations(): Promise<number[]> {
	const rows = await db
		.select({ id: abuseReports.id })
		.from(abuseReports)
		.where(
			and(
				isNull(abuseReports.escalatedAt),
				inArray(abuseReports.reason, [...FLOOR_MODERATION_REASONS]),
			),
		)
		.orderBy(abuseReports.createdAt);
	return rows.map((r) => r.id);
}

/** Retry every public report that has not reached a person yet. Returns how many did. */
export async function runAbuseEscalationSweep(): Promise<number> {
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

	return rows.map((r) => ({
		id: r.id,
		url: r.url,
		workId: r.workId,
		reason: r.reason,
		details: r.details,
		reporterEmail: r.reporterEmail,
		status: r.status,
		escalatedAt: r.escalatedAt?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString(),
	}));
}

/** Minimal entity escaping — everything on a public report is untrusted and goes into an email. */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

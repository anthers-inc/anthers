// SPDX-License-Identifier: Apache-2.0
/**
 * Defect reports about Anthers itself, filed through the public Issue Reports page.
 *
 * 🚨 **This is the one writer of `issue_reports`, and it is NOT the reporting pipeline.**
 * `services/abuse-reports.ts` is illegal-content notice-and-action — statutory clocks, a
 * human escalation floor and mail behind it. This is plain bug intake: no mail is ever sent,
 * there is no reason taxonomy, and `never write to abuse_reports` is the boundary in both
 * directions. The separation is deliberate rather than tidiness — if this ever grew a
 * moderation outcome, a legal reason or an escalation email, it has stopped being an issue
 * report and has become one of those, and it belongs in that service instead.
 *
 * **The model: rows are report items, never work items.** The issue lands here, an operator
 * reads it in the admin console, and marks it ingested once actual work will handle it. The
 * project's task tracker (the vault board) is where that work lives, filed by hand; the
 * statuses here stay `open` → `ingested` and nothing sharper, because a "fixed" status here
 * would make this table a second, competing tracker. A fixed issue whose row still reads
 * open is fine; an ingested one whose tracker task is Done is the normal end state.
 *
 * **Signed-out filing is the point.** A person who hits the site's worst bug often has no
 * usable browser session — filing must not depend on one being valid. A session is read if
 * one happens to be present and never required, exactly as the abuse intake does.
 */

import { db } from "@anthers/db/client";
import { issueReports } from "@anthers/db/schema";
import { and, desc, eq } from "drizzle-orm";

export const ISSUE_SUMMARY_MAX = 200;
export const ISSUE_SUMMARY_MIN = 5;
export const ISSUE_DETAILS_MAX = 4000;
export const ISSUE_DETAILS_MIN = 10;
export const ISSUE_URL_MAX = 2000;
export const ISSUE_EMAIL_MAX = 320;

export interface FileIssueReportInput {
	summary: string;
	details: string;
	/** The location, exactly as typed. Stored verbatim — never normalized. */
	pageUrl?: string;
	/** Optional — where to write back, when the reporter wants an answer. */
	reporterEmail?: string;
	/** Present only if they happened to be signed in. */
	reporterId?: number | null;
}

/**
 * File a report. Returns the row's id, which the site shows as a reference number.
 *
 * No notification follows — there is no mail in this pipeline by design, and the queue is
 * the thing somebody opens. The reporter is told it arrived, and never what happens next:
 * which issues are filed, dismissed or duplicated is operator information.
 */
export async function fileIssueReport(input: FileIssueReportInput): Promise<{ issueId: number }> {
	const [row] = await db
		.insert(issueReports)
		.values({
			summary: input.summary,
			details: input.details,
			pageUrl: input.pageUrl ?? "",
			reporterEmail: input.reporterEmail ?? "",
			reporterId: input.reporterId ?? null,
		})
		.returning({ id: issueReports.id });
	return { issueId: row.id };
}

/** What the operator's list carries, in the reporter's own words. */
export interface IssueQueueItem {
	id: number;
	summary: string;
	details: string;
	pageUrl: string;
	reporterEmail: string;
	status: string;
	/** The signed-in filer's account id, when one was present. Usually null. */
	reporterId: number | null;
	createdAt: string;
	ingestedAt: string | null;
}

/** The operator's list of issue reports. Open ones first, newest first. */
export async function loadIssueQueue(
	opts: { includeIngested?: boolean; limit?: number } = {},
): Promise<IssueQueueItem[]> {
	const rows = await db
		.select()
		.from(issueReports)
		.where(opts.includeIngested ? undefined : eq(issueReports.status, "open"))
		.orderBy(desc(issueReports.createdAt))
		.limit(opts.limit ?? 200);

	return rows.map((r) => ({
		id: r.id,
		summary: r.summary,
		details: r.details,
		pageUrl: r.pageUrl,
		reporterEmail: r.reporterEmail,
		status: r.status,
		reporterId: r.reporterId,
		createdAt: r.createdAt.toISOString(),
		ingestedAt: r.ingestedAt?.toISOString() ?? null,
	}));
}

/**
 * Mark a report ingested — the one action this queue exists for.
 *
 * Ingested means an operator has read it and actual work in the task tracker owns it. It
 * is an idempotent-shaped write guarded the same way `closeAbuseReport` is: only an `open`
 * row transitions, so two operators at once cannot disagree, and the second answer is a
 * 404 the console renders as "already handled".
 */
export async function ingestIssueReport(input: {
	issueId: number;
	/** The admin account acting. */
	adminId: number;
}): Promise<boolean> {
	const rows = await db
		.update(issueReports)
		.set({
			status: "ingested",
			ingestedAt: new Date(),
			ingestedBy: input.adminId,
		})
		.where(and(eq(issueReports.id, input.issueId), eq(issueReports.status, "open")))
		.returning({ id: issueReports.id });
	return rows.length > 0;
}

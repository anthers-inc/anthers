// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation — the user-facing half. One endpoint: report a comment, a review, or a
 * **person**.
 *
 * The operator half lives in `routes/admin.ts`, behind the admin host and an admin account's
 * session, because the admin app is where it belongs and that router is already gated. Both halves
 * call `services/moderation.ts`, which is where the rules actually are.
 *
 * Reporting requires a session but NOT a verified email. `requireVerified` gates
 * spending money and becoming a creator; flagging abuse is neither, and the cost
 * of an unverified account filing a bad report is one row an operator dismisses.
 * The one-report-per-person-per-item unique index does the anti-spam work.
 *
 * **Reporting a person is not blocking a person**, and they are separate endpoints on
 * separate routers for that reason: a report asks an operator to judge, a block asks
 * nobody for anything. Blocking is under `/api/accounts`, beside follow.
 */

import {
	isModerationReason,
	isModerationSubjectType,
	MODERATION_REASONS,
	REPORT_DETAILS_MAX,
	reportRequiresDetails,
} from "@anthers/shared/moderation";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOptionalUserId, requireAuth } from "../middleware/auth.js";
import {
	ABUSE_DETAILS_MAX,
	ABUSE_DETAILS_MIN,
	ABUSE_URL_MAX,
	fileAbuseReport,
} from "../services/abuse-reports.js";
import {
	fileIssueReport,
	ISSUE_DETAILS_MAX,
	ISSUE_DETAILS_MIN,
	ISSUE_EMAIL_MAX,
	ISSUE_SUMMARY_MAX,
	ISSUE_SUMMARY_MIN,
	ISSUE_URL_MAX,
} from "../services/issue-reports.js";
import { fileReport, findSubject } from "../services/moderation.js";

const reportSchema = z.object({
	subjectType: z.string().refine(isModerationSubjectType, "Unknown subject type"),
	subjectId: z.number().int().positive(),
	reason: z.string().refine(isModerationReason, "Unknown reason"),
	details: z.string().max(REPORT_DETAILS_MAX).optional(),
});

/**
 * A public report names a **location**, never a subject id.
 *
 * That is what DSA Art. 16 asks a reporter for — *"a clear indication of the exact
 * electronic location of that information, such as the exact URL"* — and it is also the
 * only thing a member of the public could possibly supply. `details` carries the
 * article's "sufficiently substantiated explanation" and is required for the same reason
 * a person report requires it: without it there is nowhere for an operator to look.
 */
const abuseReportSchema = z.object({
	url: z.string().trim().min(1).max(ABUSE_URL_MAX),
	reason: z.string().refine(isModerationReason, "Unknown reason"),
	details: z.string().trim().min(ABUSE_DETAILS_MIN).max(ABUSE_DETAILS_MAX),
	// Optional, and requiring it would turn an anonymous route into an identified one.
	reporterEmail: z.string().trim().email().max(320).optional().or(z.literal("")),
});

/**
 * What the Issue Reports form accepts — no URL taxonomy, no legal reasons, just what went
 * wrong, where it went wrong, and a way to answer.
 *
 * The page's location field is **free-text on purpose**: the reporter may paste a URL or
 * describe the screen they were on, and both are the record. The email stays optional,
 * again matching the abuse intake — requiring one would turn a bug report into an
 * identified one, and a reporter who cannot file anonymously waits, or files nothing.
 */
const issueReportSchema = z.object({
	summary: z.string().trim().min(ISSUE_SUMMARY_MIN).max(ISSUE_SUMMARY_MAX),
	details: z.string().trim().min(ISSUE_DETAILS_MIN).max(ISSUE_DETAILS_MAX),
	pageUrl: z.string().trim().max(ISSUE_URL_MAX).optional().or(z.literal("")),
	reporterEmail: z.string().trim().email().max(ISSUE_EMAIL_MAX).optional().or(z.literal("")),
});

/**
 * A crude per-caller submission cap for the one public endpoint that sends mail.
 *
 * ⚠️ **Best-effort, in-memory, and per-instance — say so rather than implying more.**
 * There is no rate-limiting infrastructure in this app and inventing some here would be a
 * much wider change than this route needs; Cloudflare sits in front of every request and
 * is the real answer. What this does buy is the difference between an unauthenticated
 * endpoint that will send one email per submission forever and one that will not, which
 * is worth having even imperfectly: the authenticated route is protected by the
 * one-report-per-person-per-item unique index, and a route with no identity has no such
 * key to lean on.
 *
 * It fails OPEN. A caller whose address we cannot read is allowed through, because the
 * cost of dropping a genuine report of child sexual abuse material is not comparable to
 * the cost of an extra email.
 */
const ABUSE_WINDOW_MS = 10 * 60 * 1000;
const ABUSE_MAX_PER_WINDOW = 5;
const abuseSubmissions = new Map<string, number[]>();

function clientKeyFor(c: { req: { header: (name: string) => string | undefined } }): string {
	// Cloudflare's own header first — it is the one value an outside caller cannot forge
	// through our edge, and `x-forwarded-for` behind it is a list whose left end they can.
	return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "";
}

function tooManyFrom(key: string): boolean {
	if (!key) return false; // Fails open — see the note above.
	const now = Date.now();
	const recent = (abuseSubmissions.get(key) ?? []).filter((t) => now - t < ABUSE_WINDOW_MS);
	if (recent.length >= ABUSE_MAX_PER_WINDOW) {
		abuseSubmissions.set(key, recent);
		return true;
	}
	recent.push(now);
	abuseSubmissions.set(key, recent);
	// Bounded so a long-running process cannot accumulate a key per address seen. The map
	// is a cache of the last few minutes, and dropping it entirely only ever forgives.
	if (abuseSubmissions.size > 10_000) abuseSubmissions.clear();
	return false;
}

const ISSUE_WINDOW_MS = 10 * 60 * 1000;
const ISSUE_MAX_PER_WINDOW = 5;
const issueSubmissions = new Map<string, number[]>();

/** The issue intake's own cap — deliberately not shared with the abuse one, so a burst of one kind never starves the other's allowance. */
function tooManyIssueFrom(key: string): boolean {
	if (!key) return false; // Fails open, for the same reason the abuse cap does.
	const now = Date.now();
	const recent = (issueSubmissions.get(key) ?? []).filter((t) => now - t < ISSUE_WINDOW_MS);
	if (recent.length >= ISSUE_MAX_PER_WINDOW) {
		issueSubmissions.set(key, recent);
		return true;
	}
	recent.push(now);
	issueSubmissions.set(key, recent);
	if (issueSubmissions.size > 10_000) issueSubmissions.clear();
	return false;
}

const moderationRoutes = new Hono()
	// The taxonomy, served so the report dialog and any future client read the
	// same list the API validates against instead of keeping their own copy.
	.get("/reasons", (c) => c.json({ reasons: MODERATION_REASONS }))

	.post("/reports", requireAuth, zValidator("json", reportSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId, reason, details } = c.req.valid("json");

		// Reporting yourself is meaningful for content and meaningless for a person:
		// a report is currently the only way an author can ask for their own comment
		// to come down, but "report myself as a user" asks an operator to judge the
		// person who filed it.
		if (subjectType === "user" && subjectId === user.id) {
			return c.json({ error: "You cannot report yourself." }, 400);
		}

		// A person report has to say where to look. A comment IS its own evidence —
		// an operator opens it and sees what the reporter saw — while "harassment"
		// against an account names no artifact at all. The six reasons are unchanged;
		// it is the intake that differs, which is why this is a route check and not a
		// seventh reason code.
		if (reportRequiresDetails(subjectType) && !(details ?? "").trim()) {
			return c.json(
				{
					error: "Tell us what this person did, and where — an operator needs somewhere to look.",
					code: "details_required",
				},
				400,
			);
		}

		// Resolve the subject first: a report naming a row that doesn't exist would
		// sit in the queue forever with nothing to render and nothing to act on.
		const subject = await findSubject(subjectType, subjectId);
		if (!subject) return c.json({ error: "Not found" }, 404);

		const { reportId } = await fileReport({
			subjectType,
			subjectId,
			reporterId: user.id,
			reason,
			details,
		});

		// Deliberately no signal about what happens next: whether an item is already
		// reported, already hidden, or already dismissed is operator information, and
		// leaking it turns this endpoint into a moderation-state oracle.
		return c.json({ reported: true, reportId }, 201);
	})

	/**
	 * Report illegal content, with no account.
	 *
	 * 🚨 **Public on purpose, and that is the whole point of the endpoint.** DSA Art. 16
	 * requires a notice-and-action mechanism open to *anyone* rather than to members, and
	 * `/reports` above is behind `requireAuth` — so until this existed, a signed-out
	 * person had no route at all. `POST /api/dmca/notices` is the existing public no-auth
	 * intake and is the shape this copies, down to telling the reporter nothing about
	 * what happens next.
	 *
	 * A session is read if one happens to be present, because a signed-in person using
	 * this form is fine and knowing who they were is useful — but it is never required
	 * and never asked for.
	 */
	.post("/abuse-reports", zValidator("json", abuseReportSchema), async (c) => {
		const limited = tooManyFrom(clientKeyFor(c));
		if (limited) {
			return c.json(
				{
					error:
						"Too many reports from here in the last few minutes. If this is urgent, email abuse@anthers.org.",
					code: "rate_limited",
				},
				429,
			);
		}

		const { url, reason, details, reporterEmail } = c.req.valid("json");
		const { reportId } = await fileAbuseReport({
			url,
			reason,
			details,
			reporterEmail,
			// Optional, never required. `getOptionalUserId` returns null for a signed-out
			// caller rather than refusing, which is the difference this route exists for.
			reporterId: await getOptionalUserId(c),
		});

		// Same silence as the authenticated route and the DMCA intake: what we do next is
		// operator information. What the reporter is told is that it arrived.
		return c.json({ reported: true, reportId }, 201);
	})

	/**
	 * Report a bug or defect in Anthers itself, with no account required.
	 *
	 * 🚨 **A separate intake from `/abuse-reports` above, never a second door into it.** That
	 * route is illegal-content notice-and-action with a statutory destination and a human
	 * escalation floor; this is plain bug intake about the site working wrong, and `the two
	 * share no table, no service and no queue` is the boundary — see `services/issue-reports.ts`.
	 * A person reporting a broken button and a person reporting abuse are different callers
	 * headed to different queues, and pointing a bug report at the abuse floor would send it
	 * to a person mid-statutory-duty while a genuine abuse report filed here would wait in a
	 * bug queue nobody is watching for it.
	 *
	 * There is no mail in this pipeline by design — the admin console's queue is where these
	 * are read — so no rate cap is inherited here either, and this route carries its own,
	 * narrower than the abuse one: an unauthenticated write endpoint needs *something*, and
	 * this is the same best-effort in-memory shape rather than invented infrastructure.
	 */
	.post("/issue-reports", zValidator("json", issueReportSchema), async (c) => {
		const limited = tooManyIssueFrom(clientKeyFor(c));
		if (limited) {
			return c.json(
				{
					error: "Too many reports from here in the last few minutes. Please try again shortly.",
					code: "rate_limited",
				},
				429,
			);
		}

		const { summary, details, pageUrl, reporterEmail } = c.req.valid("json");
		const { issueId } = await fileIssueReport({
			summary,
			details,
			pageUrl,
			reporterEmail,
			// Optional, never required, for the same reason the abuse intake reads a session
			// with `getOptionalUserId` — a signed-out filer is ordinary, not an error.
			reporterId: await getOptionalUserId(c),
		});

		// What the reporter is told is that it arrived. What we do with it — triage,
		// filing, dismissal as a duplicate — is operator information, exactly as on
		// every other public intake in this app.
		return c.json({ reported: true, issueId }, 201);
	});

export { moderationRoutes };

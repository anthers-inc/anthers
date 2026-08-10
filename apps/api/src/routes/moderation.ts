// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation — the user-facing half. One endpoint: report a comment, a review, or a
 * **person**.
 *
 * The operator half lives in `routes/admin.ts`, behind `requireAdmin`, because
 * the console is where it belongs and that router is already gated. Both halves
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
import { requireAuth } from "../middleware/auth.js";
import { fileReport, findSubject } from "../services/moderation.js";

const reportSchema = z.object({
	subjectType: z.string().refine(isModerationSubjectType, "Unknown subject type"),
	subjectId: z.number().int().positive(),
	reason: z.string().refine(isModerationReason, "Unknown reason"),
	details: z.string().max(REPORT_DETAILS_MAX).optional(),
});

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
	});

export { moderationRoutes };

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation — the user-facing half. One endpoint: report a comment or a rating.
 *
 * The operator half lives in `routes/admin.ts`, behind `requireAdmin`, because
 * the console is where it belongs and that router is already gated. Both halves
 * call `services/moderation.ts`, which is where the rules actually are.
 *
 * Reporting requires a session but NOT a verified email. `requireVerified` gates
 * spending money and becoming a creator; flagging abuse is neither, and the cost
 * of an unverified account filing a bad report is one row an operator dismisses.
 * The one-report-per-person-per-item unique index does the anti-spam work.
 */

import {
	isModerationReason,
	isModerationSubjectType,
	MODERATION_REASONS,
	REPORT_DETAILS_MAX,
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

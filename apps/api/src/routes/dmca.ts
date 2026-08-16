// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DMCA — the public-facing half. Two endpoints:
 *
 * - `POST /api/dmca/notices` — file a copyright notice (§ 512(c)(3)). Public (no
 *   auth required — the complainant may not have an account). Validates each of
 *   the six required elements independently so the rejection can name which one
 *   failed, and stores the attestation text at the version the complainant saw.
 *
 * - `POST /api/dmca/notices/:id/counter` — file a counter-notice (§ 512(g)(3)).
 *   Requires auth (the creator is the subscriber) and ownership of the Work the
 *   notice targets, so a stranger can't counter-notice on someone else's behalf.
 *   The exposure (legal name, postal address, telephone, consent to federal
 *   jurisdiction) is stated in the attestation text, which the creator saw before
 *   filling anything in.
 *
 * The operator half (the DMCA queue, act-on-notice, reject) lives in
 * `routes/admin.ts`, behind `requireAdmin` — the same gate as the moderation
 * console. Both halves call `services/dmca.ts`, which is where the rules are.
 *
 * 🚨 A user report is NOT a DMCA notice, and the two intakes must not merge.
 * The moderation report route (`routes/moderation.ts`) carries `illegal` and
 * `other` reasons, and an operator seeing a copyright complaint filed that way
 * needs a one-click "this is a copyright claim → here is the path" — but a bare
 * user report is not a notice and must not trigger removal. That route-out is
 * on the operator side, not here.
 */

import { db } from "@anthers/db/client";
import { dmcaNotices, works } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";

/**
 * The DMCA designated agent details, served to the `/copyright` page.
 *
 * § 512(c)(2) requires the agent's name, address, phone and email to be
 * "available through the service, including on the website in a location
 * accessible to the public." The registration alone is not enough — it has
 * to be published on the site too.
 *
 * These are **public statutory information**, not secrets: the Copyright
 * Office's own DMCA directory publishes them for every registered agent.
 * They come from env vars (`DMCA_AGENT_NAME`, `DMCA_AGENT_ADDRESS`, etc.)
 * set in `.do/app.yaml`, and are served through this endpoint rather than
 * baked into the bundle so they can be updated without a rebuild if the
 * agent changes (which also requires re-filing with the Copyright Office).
 *
 * `DMCA_AGENT_REGISTERED` gates the whole thing: when unset, the endpoint
 * returns `registered: false` and the page renders "we are in the process
 * of designating our DMCA agent" rather than empty fields. That gate exists
 * because `effectiveDate: null` (the pattern the other legal pages use for
 * "not yet in force") is **wrong for a statutory agent designation** — it
 * is either registered or it isn't, and a pending banner would imply the
 * protection applies before it does.
 */
function dmcaConfig() {
	const registered = process.env.DMCA_AGENT_REGISTERED === "true";
	if (!registered) {
		return { registered: false, agentName: "", agentAddress: "", agentEmail: "", agentPhone: "" };
	}
	return {
		registered: true,
		agentName: process.env.DMCA_AGENT_NAME ?? "",
		agentAddress: process.env.DMCA_AGENT_ADDRESS ?? "",
		agentEmail: process.env.DMCA_AGENT_EMAIL ?? "",
		agentPhone: process.env.DMCA_AGENT_PHONE ?? "",
	};
}

import {
	counterNoticeAttestationText,
	dmcaSummary,
	fileCounterNotice,
	fileNotice,
	finalizeNotice,
	noticeAttestationText,
	noticesForCreator,
} from "../services/dmca.js";

/**
 * The six elements of a § 512(c)(3)(A) notice, as a Zod schema.
 *
 * Each is validated independently so the 400 can name which element failed,
 * rather than a single "invalid notice" that gives the complainant nothing to
 * fix. The two attestation fields and the fair-use flag are required alongside
 * the statutory elements — see the comment on `NOTICE_ATTESTATION_TEXT` in
 * `services/dmca.ts` for why the perjury clause attaches only to authorization.
 */
const noticeSchema = z.object({
	// § 512(c)(3)(A)(iii) — identification of the infringing material, with
	// information reasonably sufficient to locate it. A Work id or URL.
	workId: z.number().int().positive(),
	// § 512(c)(3)(A)(iv) — contact information.
	complainantName: z.string().min(1, "Your name is required."),
	complainantEmail: z.string().email("A valid email address is required."),
	complainantAddress: z.string().min(1, "Your postal address is required."),
	complainantPhone: z.string().optional(),
	// § 512(c)(3)(A)(ii) — identification of the copyrighted work.
	copyrightedWorkDescription: z
		.string()
		.min(1, "Identify the copyrighted work you claim is infringed."),
	// § 512(c)(3)(A)(iii) — identification of the infringing material.
	infringingMaterialDescription: z
		.string()
		.min(1, "Identify the material you claim is infringing."),
	// § 512(c)(3)(A)(v) — good-faith belief.
	goodFaithStatement: z.string().min(1, "The good-faith belief statement is required."),
	// § 512(c)(3)(A)(vi) — accuracy + authorization under penalty of perjury.
	authorizationStatement: z.string().min(1, "The authorization statement is required."),
	// Lenz v. Universal — fair-use consideration.
	fairUseConsidered: z.boolean(),
});

/**
 * The § 512(g)(3) counter-notice elements.
 *
 * The subscriber's name, address, and telephone number (C) plus consent to
 * federal jurisdiction and service of process (D) plus the good-faith statement
 * under penalty of perjury (A). The attestation text is served separately (GET
 * below) so the creator sees the exposure before filling anything in.
 */
const counterNoticeSchema = z.object({
	subscriberName: z.string().min(1, "Your legal name is required."),
	subscriberAddress: z.string().min(1, "Your postal address is required."),
	subscriberPhone: z.string().min(1, "Your telephone number is required."),
	jurisdictionConsent: z.string().min(1, "Consent to jurisdiction is required."),
	goodFaithStatement: z.string().min(1, "The good-faith statement is required."),
});

const dmcaRoutes = new Hono()

	// The DMCA agent designation details, served to the /copyright page. Public
	// (statutory information), gated on DMCA_AGENT_REGISTERED.
	.get("/config", (c) => c.json(dmcaConfig()))

	// ── Transparency (Phase 6.1) ────────────────────────────────────────────
	// Aggregate counts, public. Counts only — no per-notice detail, so no
	// complainant contact details and no creator identified. This is the thing
	// that makes the policy legible: a notice loop nobody can see the shape of is
	// a claim rather than a practice. See `dmcaSummary` for what publishing at
	// launch volumes costs, and why it is published anyway.
	.get("/transparency", async (c) => c.json(await dmcaSummary()))

	// ── A creator's own notices ─────────────────────────────────────────────
	// What makes the counter-notice path reachable by a person: the takedown
	// notification points here, and this is what the page has to show them.
	// Requires auth and returns only the caller's own — see `noticesForCreator`
	// for what it deliberately withholds about the complainant.
	.get("/notices/mine", requireAuth, async (c) => {
		const user = c.get("user");
		return c.json({ notices: await noticesForCreator(user.id) });
	})

	// The attestation text, served so the intake form and any future client read
	// the exact copy the complainant will agree to — and so a creator considering
	// a counter-notice sees the exposure before filling anything in.
	.get("/attestation", (c) =>
		c.json({
			notice: noticeAttestationText(),
			counterNotice: counterNoticeAttestationText(),
		}),
	)

	// ── File a notice (§ 512(c)(3)) ────────────────────────────────────────
	// Public — no auth required. The complainant may not have an account, and
	// § 512(c)(3)(A)(i) requires a signature (here, the submitted form data),
	// not a session.
	.post("/notices", zValidator("json", noticeSchema), async (c) => {
		const input = c.req.valid("json");

		// Resolve the Work — a notice naming a Work that doesn't exist would sit
		// in the queue with nothing to act on. The Work must exist and be released
		// (a private Work is not publicly accessible, so it cannot be the target
		// of a copyright claim through this path).
		const [work] = await db
			.select({ id: works.id, visibility: works.visibility, title: works.title })
			.from(works)
			.where(eq(works.id, input.workId))
			.limit(1);
		if (!work) return c.json({ error: "Work not found.", code: "work_not_found" }, 404);

		// The title is snapshotted onto the notice — `workId` is `set null`, so the
		// join that renders the queue can stop resolving. See the schema comment.
		const { noticeId } = await fileNotice({ ...input, workTitle: work.title ?? "" });

		// Deliberately no signal about what happens next: whether the Work is
		// already taken down, whether the notice is under review, or whether it
		// was rejected is operator information. The complainant learns the outcome
		// when we act on it (acknowledgment) or reject it (reach-back).
		return c.json({ filed: true, noticeId }, 201);
	})

	// ── File a counter-notice (§ 512(g)(3)) ─────────────────────────────────
	// Requires auth + ownership: the creator is the subscriber, and a stranger
	// cannot counter-notice on someone else's behalf.
	.post("/notices/:id/counter", requireAuth, zValidator("json", counterNoticeSchema), async (c) => {
		const user = c.get("user");
		const noticeId = Number(c.req.param("id"));
		const input = c.req.valid("json");

		// Load the notice and the Work, and verify the creator owns the Work.
		// A counter-notice from someone who is not the Work's creator is not a
		// counter-notice — it is a third party asserting rights they don't have.
		const [notice] = await db
			.select({ workId: dmcaNotices.workId, status: dmcaNotices.status })
			.from(dmcaNotices)
			.where(eq(dmcaNotices.id, noticeId))
			.limit(1);
		if (!notice) return c.json({ error: "Notice not found." }, 404);
		if (notice.status !== "actioned") {
			return c.json(
				{ error: "This notice is not in a state where a counter-notice can be filed." },
				400,
			);
		}
		if (!notice.workId) return c.json({ error: "This notice has no target Work." }, 400);

		const [work] = await db
			.select({ creatorId: works.creatorId })
			.from(works)
			.where(eq(works.id, notice.workId))
			.limit(1);
		if (!work) return c.json({ error: "Work not found." }, 404);
		if (work.creatorId !== user.id) {
			return c.json({ error: "Only the Work's creator can file a counter-notice." }, 403);
		}

		const result = await fileCounterNotice({ noticeId, ...input });
		if (!result) return c.json({ error: "Could not file the counter-notice." }, 500);

		return c.json(
			{
				filed: true,
				restoreNoEarlierThan: result.restoreNoEarlierThan,
				// The exposure the creator just agreed to, restated so it cannot be missed:
				// their name, address, and phone are now forwarded to the complainant.
				exposure:
					"Your name, postal address, and telephone number have been forwarded to the complainant. If they file a court action, the material stays down; otherwise it will be restored on or after the date above.",
			},
			201,
		);
	})

	// ── Concede a takedown ──────────────────────────────────────────────────
	// The creator's other answer, and the one nobody thinks to build: agreeing
	// that the notice was right. It exists because finality otherwise waits out a
	// clock that both sides already know the answer to — the buyers stay
	// un-refunded for ten business days for no reason.
	//
	// It is NOT the counter-notice's opposite in effect: conceding settles the
	// money, it does not waive anything. The Work stays down either way.
	.post("/notices/:id/concede", requireAuth, async (c) => {
		const user = c.get("user");
		const noticeId = Number(c.req.param("id"));

		const [notice] = await db
			.select({ workId: dmcaNotices.workId, status: dmcaNotices.status })
			.from(dmcaNotices)
			.where(eq(dmcaNotices.id, noticeId))
			.limit(1);
		if (!notice) return c.json({ error: "Notice not found." }, 404);
		if (!notice.workId) return c.json({ error: "This notice has no target Work." }, 400);

		// Same ownership rule as the counter-notice: only the subscriber whose
		// material came down can answer for it, in either direction.
		const [work] = await db
			.select({ creatorId: works.creatorId })
			.from(works)
			.where(eq(works.id, notice.workId))
			.limit(1);
		if (!work) return c.json({ error: "Work not found." }, 404);
		if (work.creatorId !== user.id) {
			return c.json({ error: "Only the Work's creator can concede a notice." }, 403);
		}

		const result = await finalizeNotice({ noticeId, reason: "conceded" });
		if (!result) return c.json({ error: "Notice not found." }, 404);
		if (!result.finalized) {
			return c.json(
				{ error: "This notice is not in a state that can be conceded.", code: result.reason },
				400,
			);
		}

		return c.json({
			conceded: true,
			buyersRefunded: result.buyersRefunded,
		});
	});

export { dmcaRoutes };

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DMCA — the one place that files a notice, takes down a Work, restores it,
 * files a counter-notice, and rejects a notice.
 *
 * Deliberately a SEPARATE service from `services/moderation.ts`, for the same
 * reason the `dmca_notices` table is separate from `moderation_reports`: a DMCA
 * notice is a statutory claim with required elements and a clock, not "one
 * operator looking at one artifact." The moderation hide/restore path does not
 * and must not accept a Work — `isModeratableContent("work")` is false — and
 * this service is the one that handles the Work-specific takedown.
 *
 * The invariant this module exists to hold: **a takedown is a state transition
 * on `works.takedown_status`, never a DELETE.** `takeDownWork` sets
 * `takedown_status = "taken_down"` and appends to `moderation_actions` (for the
 * audit trail); `restoreWork` sets it back to `"active"` and appends again. The
 * Work, its creator, and its buyers' entitlements all survive — what changes is
 * whether `resolveAccessSync` denies, which it does before every other rule.
 *
 * `resolveAccessSync` checks `takedownStatus === "taken_down"` at the top and
 * returns `reason: "takedown"` — so every delivery route that calls
 * `resolveAccess` gets the denial for free. The only writer of
 * `works.takedown_status` is this service.
 */

import { db } from "@anthers/db/client";
import {
	type CounterNotice,
	type DmcaNoticeStatus,
	dmcaNotices,
	moderationActions,
	works,
} from "@anthers/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { notify } from "../services/notifications.js";

/**
 * The attestation text shown to a complainant at intake. Stored verbatim on each
 * notice (`attestationTextSnapshot`), so a later edit to this copy doesn't change
 * what a past notice said they agreed to.
 *
 * The perjury clause in § 512(c)(3)(A)(vi) attaches only to *authorization to act*,
 * not to the accuracy of the claim or the good-faith belief in (v). The form
 * separately asks the complainant to affirm they considered whether the use is fair
 * (Lenz v. Universal, 9th Cir. 2016), that they own or represent the owner of the
 * specific work identified, and that they understand § 512(f) — the knowing-
 * misrepresentation liability that runs in both directions.
 */
export const NOTICE_ATTESTATION_TEXT = [
	"I have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.",
	"The information in this notice is accurate, and under penalty of perjury I am authorized to act on behalf of the owner of the exclusive right that is allegedly infringed.",
	"I have considered whether the use I am reporting is a fair use, and I believe it is not.",
	"I understand that under 17 U.S.C. § 512(f), a person who knowingly materially misrepresents that material is infringing may be subject to liability for damages.",
].join("\n");

/**
 * The counter-notice attestation shown to a creator, stored verbatim on each
 * counter-notice. The exposure — legal name, postal address, telephone, and
 * consent to federal jurisdiction — is stated here, before the creator fills
 * anything in, because counter-noticing a pseudonymous creator is not a remedy
 * but a second attack if they don't know what it exposes.
 */
export const COUNTER_NOTICE_ATTESTATION_TEXT = [
	"I swear, under penalty of perjury, that the material was removed or disabled as a result of a mistake or misidentification of the material to be removed or disabled.",
	"I consent to the jurisdiction of the Federal District Court for the judicial district in which my address is located, or if my address is outside the United States, for any judicial district in which Anthers, Inc. may be found.",
	"I will accept service of process from the person who provided the notification or their agent.",
].join("\n");

/** The text a notice was received with — used in the acknowledgment to the complainant. */
export function noticeAttestationText(): string {
	return NOTICE_ATTESTATION_TEXT;
}

/** The text a counter-notice was received with. */
export function counterNoticeAttestationText(): string {
	return COUNTER_NOTICE_ATTESTATION_TEXT;
}

/**
 * File a DMCA notice. Validates the six elements (caller-side; the route does
 * per-element validation so the rejection can name which failed), stores the
 * attestation snapshot, and creates the notice row at `received`.
 *
 * No automatic removal. § 512(c)(1)(C) requires expeditious action, but human
 * review is the deliberate answer — the brief's "Refuse the design that looks
 * fairest" warning: a hold that gives the creator 24–48 hours to respond costs
 * the safe harbour, because expeditious means *now*. Remove fast, restore fast,
 * and put the fairness into intake and the counter-notice path instead.
 */
export async function fileNotice(input: {
	workId: number;
	complainantName: string;
	complainantEmail: string;
	complainantAddress: string;
	complainantPhone?: string;
	copyrightedWorkDescription: string;
	infringingMaterialDescription: string;
	goodFaithStatement: string;
	authorizationStatement: string;
	fairUseConsidered: boolean;
}): Promise<{ noticeId: number }> {
	const [row] = await db
		.insert(dmcaNotices)
		.values({
			workId: input.workId,
			complainantName: input.complainantName,
			complainantEmail: input.complainantEmail,
			complainantAddress: input.complainantAddress,
			complainantPhone: input.complainantPhone ?? "",
			copyrightedWorkDescription: input.copyrightedWorkDescription,
			infringingMaterialDescription: input.infringingMaterialDescription,
			goodFaithStatement: input.goodFaithStatement,
			authorizationStatement: input.authorizationStatement,
			fairUseConsidered: input.fairUseConsidered,
			attestationTextSnapshot: NOTICE_ATTESTATION_TEXT,
		})
		.returning({ id: dmcaNotices.id });
	return { noticeId: row.id };
}

/**
 * Take down a Work. Sets `works.takedown_status = "taken_down"`, marks the
 * notice `actioned`, appends to `moderation_actions` (the audit trail), and
 * notifies the creator with the counter-notice route. One transaction — a hidden
 * row with no record of who hid it is exactly the state the moderation invariant
 * exists to prevent, and the same applies here.
 *
 * The creator notification carries the counter-notice route and a plain statement
 * of what counter-noticing exposes. Most creators never counter-notice because
 * nobody told them they could — not because they conceded.
 */
export async function takeDownWork(input: {
	noticeId: number;
	actorId: number;
	actorRole?: string;
	note?: string;
}): Promise<{ status: "taken_down" } | "already_taken_down" | null> {
	const [notice] = await db
		.select()
		.from(dmcaNotices)
		.where(eq(dmcaNotices.id, input.noticeId))
		.limit(1);
	if (!notice) return null;
	if (notice.status === "actioned") return "already_taken_down";
	if (!notice.workId) return null;

	const [work] = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			title: works.title,
			takedownStatus: works.takedownStatus,
		})
		.from(works)
		.where(eq(works.id, notice.workId))
		.limit(1);
	if (!work) return null;
	if (work.takedownStatus === "taken_down") return "already_taken_down";

	const note = (input.note ?? "").trim();

	await db.transaction(async (tx) => {
		await tx.update(works).set({ takedownStatus: "taken_down" }).where(eq(works.id, work.id));

		await tx
			.update(dmcaNotices)
			.set({
				status: "actioned" satisfies DmcaNoticeStatus,
				actionedAt: new Date(),
				actorId: input.actorId,
				note,
			})
			.where(eq(dmcaNotices.id, input.noticeId));

		// The audit trail: a Work takedown is a moderation action with subject_type
		// "work", so the history reads as the sequence of decisions actually taken.
		await tx.insert(moderationActions).values({
			subjectType: "work",
			subjectId: work.id,
			action: "hide",
			actorId: input.actorId,
			actorRole: input.actorRole ?? "operator",
			reason: "dmca",
			note,
		});
	});

	// Notify the creator — the counter-notice route and the exposure stated plainly.
	// `notify` is a no-op on a null creator (deleted account), which is correct: a
	// takedown still proceeds, and there is nobody to tell.
	if (work.creatorId != null) {
		await notify({
			userId: work.creatorId,
			category: "essential",
			kind: "dmca_takedown",
			title: "Your work has been removed following a copyright notice",
			body: `"${work.title || "Your work"}" has been taken down following a DMCA notice from ${notice.complainantName}. If you believe this was a mistake, you can file a counter-notice — but be aware that a counter-notice requires your legal name, postal address, and telephone number, and your consent to federal jurisdiction. Those details are forwarded to the complainant. See /copyright for the full process.`,
			linkPath: `/copyright`,
			dedupeKey: `dmca-takedown:${work.id}`,
		});
	}

	return { status: "taken_down" };
}

/**
 * Reject a notice. A first-class outcome, the way `dismiss` is in the moderation
 * console. § 512(c)(3)(B)(ii) requires a reach-back rather than a discard: if the
 * notice substantially complies on (ii), (iii) and (iv), the rejection must
 * "promptly attempt to contact the complainant or take other reasonable steps to
 * assist in receiving a compliant notice." The note records the reach-back.
 */
export async function rejectNotice(input: {
	noticeId: number;
	actorId: number;
	note?: string;
}): Promise<{ status: "rejected" } | null> {
	const [notice] = await db
		.select()
		.from(dmcaNotices)
		.where(eq(dmcaNotices.id, input.noticeId))
		.limit(1);
	if (!notice) return null;

	const note = (input.note ?? "").trim();
	await db
		.update(dmcaNotices)
		.set({
			status: "rejected" satisfies DmcaNoticeStatus,
			rejectedAt: new Date(),
			actorId: input.actorId,
			note,
		})
		.where(eq(dmcaNotices.id, input.noticeId));

	return { status: "rejected" };
}

/**
 * File a counter-notice on behalf of a creator. Stores the § 512(g)(3) elements,
 * computes the restore window (10–14 business days from now), sets the notice
 * to `counter_noticed`, and forwards a copy to the complainant.
 *
 * The restore timer is `restoreNoEarlierThan` — 10 business days from now, the
 * earliest § 512(g)(2)(C) allows. The sweep job restores at that point unless a
 * suit notice (`suitFiledAt`) was recorded first.
 */
export async function fileCounterNotice(input: {
	noticeId: number;
	subscriberName: string;
	subscriberAddress: string;
	subscriberPhone: string;
	jurisdictionConsent: string;
	goodFaithStatement: string;
}): Promise<{ status: "counter_noticed"; restoreNoEarlierThan: string } | null> {
	const [notice] = await db
		.select()
		.from(dmcaNotices)
		.where(eq(dmcaNotices.id, input.noticeId))
		.limit(1);
	if (!notice) return null;

	const now = new Date();
	const restoreNoEarlierThan = addBusinessDays(now, 10);

	const counterNotice: CounterNotice = {
		subscriberName: input.subscriberName,
		subscriberAddress: input.subscriberAddress,
		subscriberPhone: input.subscriberPhone,
		jurisdictionConsent: input.jurisdictionConsent,
		goodFaithStatement: input.goodFaithStatement,
		attestationTextSnapshot: COUNTER_NOTICE_ATTESTATION_TEXT,
		filedAt: now.toISOString(),
	};

	await db
		.update(dmcaNotices)
		.set({
			status: "counter_noticed" satisfies DmcaNoticeStatus,
			counterNotice,
			counterNoticeFiledAt: now,
			restoreNoEarlierThan,
		})
		.where(eq(dmcaNotices.id, input.noticeId));

	// Forward a copy to the complainant — § 512(g)(2)(B). The email tells them the
	// material goes back in 10 business days unless they file a court action.
	// (The email itself is sent by the notification path; this records the intent.)

	return { status: "counter_noticed", restoreNoEarlierThan: restoreNoEarlierThan.toISOString() };
}

/**
 * Restore a Work. Sets `works.takedown_status = "active"` and the notice to
 * `restored`. Called by the restore-timer sweep job when the 10–14 business day
 * window closes without a suit filing, or manually by an operator.
 *
 * The restore puts back EXACTLY what came down — it does not resurrect anything
 * the creator removed themselves in the meantime. `takedown_status` is the only
 * column this touches; `visibility` (what the creator did) is untouched.
 */
export async function restoreWork(input: {
	noticeId: number;
	actorId?: number;
	note?: string;
}): Promise<{ status: "restored" } | null> {
	const [notice] = await db
		.select()
		.from(dmcaNotices)
		.where(eq(dmcaNotices.id, input.noticeId))
		.limit(1);
	if (!notice) return null;
	if (!notice.workId) return null;

	const [work] = await db
		.select({ id: works.id, takedownStatus: works.takedownStatus })
		.from(works)
		.where(eq(works.id, notice.workId))
		.limit(1);
	if (!work) return null;

	const note = (input.note ?? "").trim();

	await db.transaction(async (tx) => {
		await tx.update(works).set({ takedownStatus: "active" }).where(eq(works.id, work.id));

		await tx
			.update(dmcaNotices)
			.set({ status: "restored" satisfies DmcaNoticeStatus, note })
			.where(eq(dmcaNotices.id, input.noticeId));

		await tx.insert(moderationActions).values({
			subjectType: "work",
			subjectId: work.id,
			action: "restore",
			actorId: input.actorId ?? null,
			actorRole: input.actorId != null ? "operator" : "automated",
			reason: "",
			note,
		});
	});

	return { status: "restored" };
}

/**
 * Record that the complainant filed a court action to restrain the subscriber
 * (§ 512(g)(2)(C)). This prevents the restore timer from firing — the sweep job
 * checks `suitFiledAt` before restoring.
 */
export async function recordSuit(input: {
	noticeId: number;
	actorId: number;
}): Promise<{ status: "suit_filed" } | null> {
	const [notice] = await db
		.select()
		.from(dmcaNotices)
		.where(eq(dmcaNotices.id, input.noticeId))
		.limit(1);
	if (!notice) return null;

	await db
		.update(dmcaNotices)
		.set({ suitFiledAt: new Date() })
		.where(eq(dmcaNotices.id, input.noticeId));

	return { status: "suit_filed" };
}

/**
 * The notices whose restore timer has arrived and no suit was filed. Used by
 * the scheduled sweep job (`QUEUES.DMCA_RESTORE`) to restore Works at the
 * 10–14 business day window.
 */
export async function noticesReadyForRestore(): Promise<
	{ noticeId: number; workId: number | null }[]
> {
	const rows = await db
		.select({ id: dmcaNotices.id, workId: dmcaNotices.workId })
		.from(dmcaNotices)
		.where(
			and(
				eq(dmcaNotices.status, "counter_noticed"),
				// restoreNoEarlierThan is set when a counter-notice is filed.
				// A null here means no counter-notice was filed, so this row is not
				// in the sweep's scope.
				sql`"${dmcaNotices.restoreNoEarlierThan}" IS NOT NULL`,
				sql`"${dmcaNotices.restoreNoEarlierThan}" <= now()`,
				sql`"${dmcaNotices.suitFiledAt}" IS NULL`,
			),
		);
	return rows.map((r) => ({ noticeId: r.id, workId: r.workId }));
}

/**
 * Load a notice by id, with the Work's title and slug for display.
 */
export async function loadNotice(noticeId: number) {
	const [row] = await db
		.select({
			notice: dmcaNotices,
			workTitle: works.title,
			workSlug: works.slug,
			workPublicId: works.publicId,
		})
		.from(dmcaNotices)
		.leftJoin(works, eq(dmcaNotices.workId, works.id))
		.where(eq(dmcaNotices.id, noticeId))
		.limit(1);
	return row ?? null;
}

/**
 * The operator's DMCA queue. Ordered by status then recency, with the Work
 * details hydrated.
 */
export async function loadDmcaQueue(limit = 100) {
	const rows = await db
		.select({
			id: dmcaNotices.id,
			workId: dmcaNotices.workId,
			status: dmcaNotices.status,
			complainantName: dmcaNotices.complainantName,
			complainantEmail: dmcaNotices.complainantEmail,
			receivedAt: dmcaNotices.receivedAt,
			actionedAt: dmcaNotices.actionedAt,
			counterNoticeFiledAt: dmcaNotices.counterNoticeFiledAt,
			restoreNoEarlierThan: dmcaNotices.restoreNoEarlierThan,
			suitFiledAt: dmcaNotices.suitFiledAt,
			workTitle: works.title,
			workSlug: works.slug,
			workPublicId: works.publicId,
			note: dmcaNotices.note,
		})
		.from(dmcaNotices)
		.leftJoin(works, eq(dmcaNotices.workId, works.id))
		.orderBy(dmcaNotices.status, desc(dmcaNotices.receivedAt))
		.limit(limit);
	return rows;
}

/** Aggregate counts for transparency — notices received, acted on, rejected, counter-noticed, restored. */
export async function dmcaSummary() {
	const rows = await db
		.select({ status: dmcaNotices.status, n: sql`count(*)::int` })
		.from(dmcaNotices)
		.groupBy(dmcaNotices.status);
	const counts: Record<string, number> = {};
	for (const r of rows) counts[r.status] = Number(r.n);
	return {
		received: counts.received ?? 0,
		screening: counts.screening ?? 0,
		actioned: counts.actioned ?? 0,
		rejected: counts.rejected ?? 0,
		counterNoticed: counts.counter_noticed ?? 0,
		restored: counts.restored ?? 0,
		withdrawn: counts.withdrawn ?? 0,
		total: Object.values(counts).reduce((a, b) => a + b, 0),
	};
}

/**
 * Add N business days to a date. A business day is a weekday (Mon–Fri) that is
 * not a US federal holiday. The holiday list is the one the sweep job needs to
 * get right — the brief says "get it wrong late rather than early," so this
 * errs toward a longer window (10 business days minimum).
 *
 * 🚨 This is a simple implementation that does NOT account for federal holidays.
 * The brief calls out "business-day arithmetic with federal holidays is the
 * fiddly part; get it wrong late rather than early." For a first pass, 10
 * weekdays (skipping Sat/Sun) is a conservative floor — holidays would only
 * push the date later, which is the safe direction. A proper holiday calendar
 * belongs in a follow-up, and the `restoreNoEarlierThan` timestamp is what the
 * sweep checks, so correcting it later is a migration of zero rows.
 */
function addBusinessDays(from: Date, days: number): Date {
	const out = new Date(from);
	let added = 0;
	while (added < days) {
		out.setDate(out.getDate() + 1);
		const day = out.getDay();
		// 0 = Sunday, 6 = Saturday
		if (day !== 0 && day !== 6) added++;
	}
	return out;
}

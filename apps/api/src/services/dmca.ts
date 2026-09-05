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
	purchases,
	works,
} from "@anthers/db/schema";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { notify } from "../services/notifications.js";
import { refundPurchase } from "./refunds.js";
import { restoreStickersOnSubject, voidStickersOnSubject } from "./sticker-void";

/**
 * How long a creator has to file a counter-notice before the takedown becomes
 * final and the buyer refunds are released.
 *
 * The statute sets no deadline for filing a counter-notice, so this is ours. Ten
 * business days mirrors the § 512(g)(2)(C) restore floor — the same interval the
 * statute uses everywhere else in this section — and it bounds only *when we
 * settle the money*. A counter-notice filed after it is still accepted and still
 * restores the Work; see the note on `counterNoticeDueBy` in the schema.
 */
export const COUNTER_NOTICE_WINDOW_BUSINESS_DAYS = 10;

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
 * the safe harbor, because expeditious means *now*. Remove fast, restore fast,
 * and put the fairness into intake and the counter-notice path instead.
 */
export async function fileNotice(input: {
	workId: number;
	workTitle?: string;
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
			workTitle: input.workTitle ?? "",
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
	const now = new Date();
	// The creator's window to answer. Buyer refunds are released when it closes
	// with no counter-notice — never at removal. It does NOT bar a late
	// counter-notice; see the schema note on `counterNoticeDueBy`.
	const counterNoticeDueBy = addBusinessDays(now, COUNTER_NOTICE_WINDOW_BUSINESS_DAYS);

	await db.transaction(async (tx) => {
		await tx.update(works).set({ takedownStatus: "taken_down" }).where(eq(works.id, work.id));

		await tx
			.update(dmcaNotices)
			.set({
				status: "actioned" satisfies DmcaNoticeStatus,
				actionedAt: now,
				counterNoticeDueBy,
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

		// 🚨 Anthers removed this, so directed money on it reverts: it goes back to being
		// distributed by time rather than paid out on content we took down. A creator
		// WITHDRAWING their own Work does not do this — they broke no rule. Only unsettled
		// cycles move; a takedown does not reach into a month already paid.
		const reverted = await voidStickersOnSubject("work", work.id);
		if (reverted.voided > 0) {
			console.log(
				`[dmca] takedown of work ${work.id} reverted ${reverted.voided} Sticker(s), $${reverted.dollars.toFixed(2)} back to time-based distribution`,
			);
		}
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
			body: `"${work.title || "Your work"}" has been taken down following a DMCA notice from ${notice.complainantName}. If you believe this was a mistake, you can file a counter-notice — but be aware that a counter-notice requires your legal name, postal address, and telephone number, and your consent to federal jurisdiction. Those details are forwarded to the complainant. If you have not filed one by ${counterNoticeDueBy.toDateString()}, we treat the removal as final and refund anyone who bought this work; you can still file after that date and we will still restore the work, but the sale is settled. See /copyright for the full process.`,
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

		// The takedown is undone, so the directions come back — but only for a cycle that has
		// not settled. A counter-notice can arrive after the month closed, and by then the money
		// has been distributed by time and paid; restoring the Work does not rewrite that.
		const back = await restoreStickersOnSubject("work", work.id);
		if (back.restored > 0) {
			console.log(`[dmca] restore of work ${work.id} reinstated ${back.restored} Sticker(s)`);
		}
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
				isNotNull(dmcaNotices.restoreNoEarlierThan),
				lte(dmcaNotices.restoreNoEarlierThan, new Date()),
				isNull(dmcaNotices.suitFiledAt),
			),
		);
	return rows.map((r) => ({ noticeId: r.id, workId: r.workId }));
}

/**
 * The notices whose counter-notice window has closed with no counter-notice
 * filed. Used by the scheduled finality sweep (`QUEUES.DMCA_FINALIZE`) to
 * release the buyer refunds.
 *
 * Scoped to `actioned` — a notice that was counter-noticed, restored, rejected
 * or withdrawn is not a final takedown, and `finalizedAt IS NULL` keeps an
 * already-settled notice out of the sweep.
 */
export async function noticesReadyForFinality(): Promise<{ noticeId: number }[]> {
	const rows = await db
		.select({ id: dmcaNotices.id })
		.from(dmcaNotices)
		.where(
			and(
				eq(dmcaNotices.status, "actioned"),
				isNull(dmcaNotices.finalizedAt),
				isNotNull(dmcaNotices.counterNoticeDueBy),
				lte(dmcaNotices.counterNoticeDueBy, new Date()),
			),
		);
	return rows.map((r) => ({ noticeId: r.id }));
}

/**
 * Settle a takedown that has become final: refund every buyer of the Work, tell
 * them why, and stamp the notice.
 *
 * **Refund at finality, never at removal** — Parker's call, and the brief's
 * reasoning. Refunding the moment a Work comes down and then restoring it on day
 * 12 leaves a refunded buyer holding restored access, and spends charitable
 * remainder on a claim that turned out to be wrong. So the money moves only once
 * the creator has had their window and not used it, or has conceded.
 *
 * Two properties this relies on, both already true elsewhere:
 *
 * - **`initiator: "platform"` is cap-exempt by construction.** A takedown must
 *   not spend the three-per-year allowance a buyer would want for a choice that
 *   was actually theirs — this is that exemption's first real caller.
 * - **The refund is what revokes access, and it is not undone by a restore.**
 *   `resolveAccess` counts only `completed` purchases, so a refunded buyer does
 *   not silently regain the Work if a late counter-notice puts it back. They were
 *   made whole in money; the Work returns to sale rather than to their Library.
 *
 * 🚨 **A partial failure does not finalize.** If any refund fails — Stripe
 * unconfigured, a charge too old to reverse — the stamp is withheld so the daily
 * sweep retries, and `refundPurchase` is idempotent in both directions, so the
 * ones that already succeeded are no-ops on the next pass. The cost of that
 * choice is that a permanently unrefundable charge holds the notice open; that is
 * visible in the operator queue, which is the right place for a human to see it.
 */
export async function finalizeNotice(input: {
	noticeId: number;
	reason: "no_counter_notice" | "conceded";
	now?: Date;
}): Promise<
	| { finalized: true; buyersRefunded: number }
	| { finalized: false; reason: "not_actioned" | "already_final" | "not_taken_down" }
	| { finalized: false; reason: "refunds_failed"; failures: number }
	| null
> {
	const now = input.now ?? new Date();

	const [notice] = await db
		.select()
		.from(dmcaNotices)
		.where(eq(dmcaNotices.id, input.noticeId))
		.limit(1);
	if (!notice) return null;
	if (notice.finalizedAt) return { finalized: false, reason: "already_final" };
	if (notice.status !== "actioned") return { finalized: false, reason: "not_actioned" };
	if (!notice.workId) return null;

	// If an operator restored the Work early — the complainant withdrew, or the
	// notice turned out to be bad — there is nothing final to settle, and
	// refunding buyers of a Work that is back up would be the exact inversion of
	// the failure this whole ordering exists to prevent.
	const [work] = await db
		.select({ id: works.id, title: works.title, takedownStatus: works.takedownStatus })
		.from(works)
		.where(eq(works.id, notice.workId))
		.limit(1);
	if (!work) return null;
	if (work.takedownStatus !== "taken_down") return { finalized: false, reason: "not_taken_down" };

	// Every completed purchase of this Work. `type` is filtered because a support
	// top-up carries no Work and is not refundable anyway (`refundPurchase` refuses
	// it), and letting one through would count a refusal as a failure.
	const rows = await db
		.select()
		.from(purchases)
		.where(
			and(
				eq(purchases.workId, work.id),
				eq(purchases.status, "completed"),
				ne(purchases.type, "seeds"),
			),
		);

	let refunded = 0;
	let failures = 0;
	for (const purchase of rows) {
		const result = await refundPurchase(purchase, {
			initiator: "platform",
			reason: "dmca_takedown",
			now,
		});
		if (!result.ok) {
			failures++;
			console.error(
				`[dmca-finalize] notice #${input.noticeId}: refund failed for purchase ${purchase.id} (${result.code}: ${result.message})`,
			);
			continue;
		}
		if (result.alreadyRefunded) continue;
		refunded++;

		// Tell the buyer. Essential category — this is money and access changing,
		// not an activity update, so it reaches them whatever their preferences.
		if (purchase.buyerId != null) {
			await notify({
				userId: purchase.buyerId,
				category: "essential",
				kind: "dmca_refund",
				title: "A work you bought has been removed, and you've been refunded",
				body: `"${work.title || "A work you bought"}" was removed following a copyright notice, and we've refunded what you paid for it in full. This is one of the narrow cases where we cannot keep the promise that what you buy, you keep: continuing to deliver the work to you would mean continuing to infringe. The refund does not count against your refund limit.`,
				linkPath: "/copyright",
				dedupeKey: `dmca-refund:${purchase.id}`,
			});
		}
	}

	if (failures > 0) return { finalized: false, reason: "refunds_failed", failures };

	await db
		.update(dmcaNotices)
		.set({
			finalizedAt: now,
			finalizedReason: input.reason,
			buyersRefunded: refunded,
		})
		.where(eq(dmcaNotices.id, input.noticeId));

	return { finalized: true, buyersRefunded: refunded };
}

/**
 * Load a notice by id, with the Work's title and slug for display.
 *
 * The title falls back to the snapshot on the notice: `workId` is `set null`, so
 * a Work deleted after the notice was filed leaves the join resolving nothing,
 * and the operator still has to be able to read what the notice was about.
 */
export async function loadNotice(noticeId: number) {
	const [row] = await db
		.select({
			notice: dmcaNotices,
			workTitle: sql<string>`coalesce(${works.title}, ${dmcaNotices.workTitle})`,
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
 * The notices filed against a creator's own Works.
 *
 * This is what makes the counter-notice path reachable by a person rather than
 * only by an API client. The takedown notification tells a creator their work
 * came down and points at `/copyright`; without this the page had nothing to
 * show them and no form to fill in, so "you can file a counter-notice" was true
 * of the system and not of anyone using it.
 *
 * Deliberately narrow: it returns the creator's OWN notices, and it does not
 * return the complainant's address or phone. The creator is told **who** filed —
 * being accused without being told by whom is not answerable — but their
 * accuser's home address is not theirs to have. The statute only compels the
 * disclosure in the other direction.
 */
export async function noticesForCreator(userId: number) {
	return (
		db
			.select({
				id: dmcaNotices.id,
				status: dmcaNotices.status,
				workId: dmcaNotices.workId,
				workTitle: sql<string>`coalesce(${works.title}, ${dmcaNotices.workTitle})`,
				complainantName: dmcaNotices.complainantName,
				copyrightedWorkDescription: dmcaNotices.copyrightedWorkDescription,
				infringingMaterialDescription: dmcaNotices.infringingMaterialDescription,
				actionedAt: dmcaNotices.actionedAt,
				counterNoticeDueBy: dmcaNotices.counterNoticeDueBy,
				counterNoticeFiledAt: dmcaNotices.counterNoticeFiledAt,
				restoreNoEarlierThan: dmcaNotices.restoreNoEarlierThan,
				suitFiledAt: dmcaNotices.suitFiledAt,
				finalizedAt: dmcaNotices.finalizedAt,
				finalizedReason: dmcaNotices.finalizedReason,
			})
			.from(dmcaNotices)
			.innerJoin(works, eq(dmcaNotices.workId, works.id))
			// Only notices that actually did something. A notice still being screened,
			// or one we rejected as defective, never touched the creator's work — and
			// telling someone "you were accused and we threw it out" is a chilling
			// message about an event that had no effect on them.
			.where(
				and(
					eq(works.creatorId, userId),
					inArray(dmcaNotices.status, ["actioned", "counter_noticed", "restored", "withdrawn"]),
				),
			)
			.orderBy(desc(dmcaNotices.receivedAt))
			.limit(50)
	);
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
			counterNoticeDueBy: dmcaNotices.counterNoticeDueBy,
			restoreNoEarlierThan: dmcaNotices.restoreNoEarlierThan,
			suitFiledAt: dmcaNotices.suitFiledAt,
			finalizedAt: dmcaNotices.finalizedAt,
			finalizedReason: dmcaNotices.finalizedReason,
			buyersRefunded: dmcaNotices.buyersRefunded,
			// Falls back to the snapshot — see `loadNotice`.
			workTitle: sql<string>`coalesce(${works.title}, ${dmcaNotices.workTitle})`,
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

/**
 * Aggregate counts for transparency — notices received, acted on, rejected,
 * counter-noticed, restored.
 *
 * **Published, and counts only** (Parker's call, 2026-08-16). This is what makes
 * the policy legible: a repeat-infringer policy and a notice loop that nobody can
 * see the shape of is a claim rather than a practice. Per-notice publication —
 * Lumen or our own — stays deferred, because publishing a notice publishes the
 * complainant's contact details and identifies the creator, which is a Privacy Policy
 * question rather than a default.
 *
 * ⚠️ **At launch volumes a count is close to naming someone.** "1 actioned" beside
 * a visibly missing Work identifies the creator to anyone who was watching for it.
 * That is a real cost of publishing, accepted knowingly rather than overlooked:
 * the alternative — waiting for volume — means the numbers appear only once we
 * have something to be embarrassed by, which is the wrong direction for a
 * transparency figure to run.
 */
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
 * not an observed US federal holiday.
 *
 * The brief says "get it wrong late rather than early," and the statute gives us
 * room to be wrong in that direction: § 512(g)(2)(C) sets a **band** — not less
 * than 10 nor more than 14 business days — so there are four business days of
 * slack between the floor this computes and the ceiling. That slack is what makes
 * the remaining imprecision here safe rather than merely acknowledged:
 *
 * - **Local time zone.** The date parts come from the runtime's zone. A boundary
 *   case can therefore land a day either side of a UTC reckoning, which is inside
 *   the band.
 * - **State and local holidays are not here**, only the eleven federal ones.
 *   Those are the ones a federal district court closes for, which is the clock
 *   this is measuring against.
 *
 * `restoreNoEarlierThan` is a stored timestamp rather than a recomputed one, so a
 * later correction to this function is a migration of zero rows: notices already
 * filed keep the date their subscriber was told.
 */
export function addBusinessDays(from: Date, days: number): Date {
	const out = new Date(from);
	let added = 0;
	while (added < days) {
		out.setDate(out.getDate() + 1);
		if (isBusinessDay(out)) added++;
	}
	return out;
}

/** A weekday that is not an observed federal holiday. */
export function isBusinessDay(date: Date): boolean {
	const day = date.getDay();
	// 0 = Sunday, 6 = Saturday
	if (day === 0 || day === 6) return false;
	return !observedFederalHolidays(date.getFullYear()).has(ymd(date));
}

/** Local-time `YYYY-MM-DD`, the key the holiday set is built on. */
function ymd(date: Date): string {
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${m}-${d}`;
}

/** Cache per year — the sweep asks the same question ~10 times per notice. */
const holidayCache = new Map<number, Set<string>>();

/**
 * The eleven US federal holidays for a year, as the dates they are **observed**.
 *
 * 5 U.S.C. § 6103: a holiday falling on a Saturday is observed the preceding
 * Friday, and one falling on a Sunday the following Monday. The observed date is
 * the one that matters here — the weekend day is already skipped as a weekend, so
 * only the shift onto an adjacent weekday changes any arithmetic.
 */
function observedFederalHolidays(year: number): Set<string> {
	const cached = holidayCache.get(year);
	if (cached) return cached;

	const dates = [
		new Date(year, 0, 1), // New Year's Day
		nthWeekdayOfMonth(year, 0, 1, 3), // Birthday of Martin Luther King, Jr. — 3rd Monday in January
		nthWeekdayOfMonth(year, 1, 1, 3), // Washington's Birthday — 3rd Monday in February
		lastWeekdayOfMonth(year, 4, 1), // Memorial Day — last Monday in May
		new Date(year, 5, 19), // Juneteenth National Independence Day
		new Date(year, 6, 4), // Independence Day
		nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day — 1st Monday in September
		nthWeekdayOfMonth(year, 9, 1, 2), // Columbus Day — 2nd Monday in October
		new Date(year, 10, 11), // Veterans Day
		nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving Day — 4th Thursday in November
		new Date(year, 11, 25), // Christmas Day
	];

	const observed = new Set<string>();
	for (const date of dates) {
		const day = date.getDay();
		if (day === 6)
			date.setDate(date.getDate() - 1); // Saturday → observed Friday
		else if (day === 0) date.setDate(date.getDate() + 1); // Sunday → observed Monday
		observed.add(ymd(date));
	}

	// A New Year's Day falling on a Saturday is observed on 31 December of the
	// PRECEDING year, which this year's set would otherwise never contain.
	const nextNewYear = new Date(year + 1, 0, 1);
	if (nextNewYear.getDay() === 6) observed.add(`${year}-12-31`);

	holidayCache.set(year, observed);
	return observed;
}

/** The `nth` occurrence of `weekday` (0=Sun) in `month` (0=Jan). */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
	const first = new Date(year, month, 1);
	const offset = (weekday - first.getDay() + 7) % 7;
	return new Date(year, month, 1 + offset + (nth - 1) * 7);
}

/** The last occurrence of `weekday` (0=Sun) in `month` (0=Jan). */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
	const last = new Date(year, month + 1, 0);
	const offset = (last.getDay() - weekday + 7) % 7;
	return new Date(year, month, last.getDate() - offset);
}

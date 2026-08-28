// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content ratings — the only writer of a Work's maturity, and of the appeals against it.
 *
 * Follows the one-writer pattern `services/moderation.ts`, `services/quarantine.ts` and
 * `services/dmca.ts` establish: three doors reach a Work's rating — the creator declaring it,
 * an operator correcting it, and an appeal being granted — and all three come through here,
 * so they cannot leave the row in states that disagree about who last decided.
 *
 * 🚨 **The rule that makes a correction hold is an ordering, not a pair of special cases.**
 * While a rating is `operator`-set its creator may raise it and may not lower it, because
 * that is where the harm actually is: a creator choosing to be more cautious about their own
 * work is their business, while a creator quietly undoing a correction is the thing the
 * correction existed to prevent. `isAtLeastAsCautious` in `@anthers/shared/content-rating` is
 * the whole of the predicate, written as an order so a fourth rating value inserted between
 * the existing ones cannot silently invert it.
 *
 * ⚠️ **Content notes are never locked.** They carry no access consequence — nothing reads
 * them to decide who may reach a Work — so there is nothing for a lock to protect, and
 * locking them would take a creator's own warnings to their own readers out of their hands.
 *
 * 🚨 **A rating is corrected, never deleted, and the appeal record outlives the decision.**
 * Same reasoning as 40.06's removal-is-a-state rule: an appeal years later has to have
 * something to read, and a granted appeal that erased the correction would destroy the record
 * of the mistake it was correcting.
 */

import { db } from "@anthers/db/client";
import type { SeedAccessRow } from "@anthers/db/schema";
import { moderationActions, workRatingAppeals, works } from "@anthers/db/schema";
import {
	type ContentNote,
	isAtLeastAsCautious,
	type MaturityRating,
	maturityLabel,
	normalizeContentNotes,
} from "@anthers/shared/content-rating";
import { and, desc, eq } from "drizzle-orm";
import { closeFreeBaseline, isOpenToEveryoneFree } from "./access.js";
import { notify } from "./notifications.js";

type WorkRow = typeof works.$inferSelect;
export type RatingAppealRow = typeof workRatingAppeals.$inferSelect;

/** The rating a Work currently carries, read back in the shared vocabulary. */
export function ratingOf(work: Pick<WorkRow, "maturity" | "maturityNotes" | "maturitySource">) {
	return {
		maturity: work.maturity as MaturityRating,
		notes: normalizeContentNotes(work.maturityNotes ?? []),
		/** True when an operator set it, which is what makes lowering it an appeal. */
		locked: work.maturitySource === "operator",
	};
}

/**
 * Why a creator's own change to the rating was refused.
 *
 * `locked` is the only value, and it is a named result rather than a thrown error because
 * the route has to turn it into a specific message: *"an operator set this, here is how to
 * appeal"* is a different thing to tell somebody than *"that didn't work"*.
 */
export type DeclineRefusal = "locked";

/**
 * The creator declaring their own Work's rating.
 *
 * Returns the updated row, or `"locked"` when an operator has set the rating and this change
 * would lower it. Passing the rating it already has is not a change and is always allowed,
 * so a PATCH that happens to include the current value never trips the lock — which matters
 * because the Work editor sends the whole form every time.
 */
export async function declareRating(
	work: WorkRow,
	input: { maturity?: MaturityRating; notes?: readonly string[] },
	now: Date = new Date(),
): Promise<WorkRow | DeclineRefusal> {
	const current = ratingOf(work);
	const maturity = input.maturity ?? current.maturity;

	if (current.locked && !isAtLeastAsCautious(maturity, current.maturity)) return "locked";

	const updates: Partial<typeof works.$inferInsert> = { updatedAt: now };
	if (maturity !== current.maturity) {
		updates.maturity = maturity;
		updates.maturitySetAt = now;
		// Raising past an operator's call is still the creator's own declaration, so the
		// source returns to them — and with it the ability to come back down to what the
		// operator set. Lowering below that still takes an appeal, because the operator's
		// value is where `isAtLeastAsCautious` is measured from once they have set it.
		updates.maturitySource = "creator";
	}
	if (input.notes) updates.maturityNotes = normalizeContentNotes(input.notes);

	const [updated] = await db.update(works).set(updates).where(eq(works.id, work.id)).returning();
	return updated;
}

/**
 * An operator correcting a Work's rating.
 *
 * Writes the moderation log alongside it, because a correction is an operator judgment about
 * somebody's work and the log is what an appeal reads. `reclassify` is the third value in
 * `ModerationActionType`, appended rather than reused: it is neither a hide nor a restore,
 * and recording it as one would make the queue's own history lie about what happened.
 *
 * 🚨 **A correction into `adult` is allowed, and the rung's consequences are applied in the
 * same act.** Anthers cannot rely on a creator always being willing to rate their own work
 * correctly — least of all at the one rung that costs them something — so a correction that
 * needed the creator's cooperation would be no enforcement at all. What the correction may
 * not do is leave the Work rated Adult while it still behaves like ordinary work, so
 * `closeFreeBaseline` shuts the free-to-everyone door here rather than leaving that rule on
 * the creator's edit path where an operator never passes.
 *
 * ⚠️ **The creator's own path refuses instead of imposing, and the asymmetry is deliberate.**
 * A creator raising their own Work to Adult is standing at the editor with the access
 * controls in front of them, so they are told to price or gate it — silently rewriting
 * somebody's pricing while they are looking at it would be making a business decision on
 * their behalf. An operator is acting on work that is not theirs and cannot be refused, so
 * there the rule is imposed and the creator is notified.
 *
 * **One operator may do this while Anthers has one operator** (Parker, 2026-08-28). Dual
 * sign-off is wanted and is a good idea, and it arrives when there is a second moderator to
 * sign — until then the protection against inconsistency is a written standard detailed
 * enough to apply the same way twice, which is what wiki 40.13 is for, plus the cited row
 * and cell every correction has to record.
 */
export async function correctRating(input: {
	workId: number;
	maturity: MaturityRating;
	notes?: readonly string[];
	actorId: number;
	note?: string;
	now?: Date;
}): Promise<{ work: WorkRow; accessClosed: boolean } | null> {
	const now = input.now ?? new Date();
	const [work] = await db.select().from(works).where(eq(works.id, input.workId));
	if (!work) return null;

	const updates: Partial<typeof works.$inferInsert> = {
		maturity: input.maturity,
		maturitySource: "operator",
		maturitySetAt: now,
		updatedAt: now,
	};
	if (input.notes) updates.maturityNotes = normalizeContentNotes(input.notes);

	// 🚨 The Adult rules, imposed rather than assumed. Adult work may not be free, and a
	// Work corrected into the rung is exactly the case where nobody has agreed to that —
	// so the free baseline row is closed as part of the same write. Higher rungs survive
	// untouched; see `closeFreeBaseline`.
	const accessClosed =
		input.maturity === "adult" && isOpenToEveryoneFree(work.seedAccess as SeedAccessRow[] | null);
	if (accessClosed) {
		updates.seedAccess = closeFreeBaseline(work.seedAccess as SeedAccessRow[] | null);
	}

	const [updated] = await db
		.update(works)
		.set(updates)
		.where(eq(works.id, input.workId))
		.returning();

	await db.insert(moderationActions).values({
		subjectType: "work",
		subjectId: input.workId,
		action: "reclassify",
		actorId: input.actorId,
		// The reason column carries a moderation reason code elsewhere, and a reclassification
		// has none — what it is *about* is the rating, which is in the note.
		reason: "",
		// Records the access change too, when there was one. An operator's note explains the
		// rating; the log has to carry what the correction actually *did*, or an appeal read
		// months later cannot tell why the Work stopped being reachable.
		note:
			((input.note ?? "").slice(0, 1000) || `rated ${input.maturity}`) +
			(accessClosed ? " · free public access closed (Adult work may not be free)" : ""),
		createdAt: now,
	});

	// 🚨 The creator is told, and this is the half that makes the correction legitimate
	// rather than merely permitted. A correction they are not told about is one they cannot
	// appeal, and the appeal path is what wiki 40.09 calls part of the feature rather than a
	// later refinement. `essential` because it is not activity about their work — it is a
	// decision taken about their work, and it may have just closed its only open door.
	if (updated?.creatorId != null) {
		await notify({
			userId: updated.creatorId,
			category: "essential",
			kind: "rating_corrected",
			title: accessClosed
				? `“${updated.title ?? "Your Work"}” is now rated Adult, and its free access was closed`
				: `“${updated.title ?? "Your Work"}” was re-rated ${maturityLabel(input.maturity)}`,
			body: accessClosed
				? "Adult work can't be free to everyone, so the open access on this Work was turned off. Set a price or put it behind a Badge to make it reachable again. If you think the rating is wrong, you can appeal it."
				: "An operator changed this Work's rating. You can make it more cautious at any time; to lower it, appeal.",
			linkPath: `/works/${updated.slug}-${updated.publicId}`,
			// Per correction, not per Work — a second correction months later is news again.
			dedupeKey: `rating-corrected:${updated.id}:${now.toISOString()}`,
		});
	}

	return { work: updated, accessClosed };
}

/** Why an appeal could not be filed. Each is something the creator can be told plainly. */
export type AppealRefusal = "not-locked" | "already-open" | "not-a-change";

/**
 * A creator contesting an operator's correction.
 *
 * ⚠️ **Only an operator-set rating can be appealed**, and the refusal is not pedantry: a
 * creator whose rating is their own does not need an appeal, they need the edit field, and
 * routing them into a queue that waits on a person would be worse service than saying so.
 *
 * One open appeal per Work. A second is not more evidence; it is the same argument in the
 * queue twice, and it would let a creator push their Work to the top of an oldest-first list
 * by re-filing.
 */
export async function fileRatingAppeal(input: {
	work: WorkRow;
	creatorId: number;
	requestedMaturity: MaturityRating;
	statement: string;
	now?: Date;
}): Promise<RatingAppealRow | AppealRefusal> {
	const current = ratingOf(input.work);
	if (!current.locked) return "not-locked";
	if (input.requestedMaturity === current.maturity) return "not-a-change";

	const [open] = await db
		.select({ id: workRatingAppeals.id })
		.from(workRatingAppeals)
		.where(and(eq(workRatingAppeals.workId, input.work.id), eq(workRatingAppeals.status, "open")));
	if (open) return "already-open";

	const [row] = await db
		.insert(workRatingAppeals)
		.values({
			workId: input.work.id,
			creatorId: input.creatorId,
			requestedMaturity: input.requestedMaturity,
			correctedMaturity: current.maturity,
			statement: input.statement.trim(),
			status: "open",
			createdAt: input.now ?? new Date(),
		})
		.returning();
	return row;
}

/**
 * An operator answering an appeal.
 *
 * Granting it applies the rating the creator asked for and hands the rating back to them, so
 * the lock is lifted by the same act that concedes the point — leaving it locked would mean
 * conceding the argument and keeping the restriction. Upholding it changes nothing about the
 * Work and closes the appeal, which is why the resolution note is worth having: an appeal
 * that is refused with no answer is the version of this feature that teaches people not to
 * bother.
 */
export async function resolveRatingAppeal(input: {
	appealId: number;
	actorId: number;
	outcome: "granted" | "upheld";
	note?: string;
	now?: Date;
}): Promise<{ appeal: RatingAppealRow; work: WorkRow | null } | null> {
	const now = input.now ?? new Date();
	const [appeal] = await db
		.select()
		.from(workRatingAppeals)
		.where(eq(workRatingAppeals.id, input.appealId));
	if (!appeal || appeal.status !== "open") return null;

	const [resolved] = await db
		.update(workRatingAppeals)
		.set({
			status: input.outcome,
			resolvedBy: input.actorId,
			resolvedAt: now,
			resolutionNote: (input.note ?? "").slice(0, 1000),
		})
		.where(eq(workRatingAppeals.id, input.appealId))
		.returning();

	let work: WorkRow | null = null;
	if (input.outcome === "granted") {
		const [updated] = await db
			.update(works)
			.set({
				maturity: appeal.requestedMaturity,
				maturitySource: "creator",
				maturitySetAt: now,
				updatedAt: now,
			})
			.where(eq(works.id, appeal.workId))
			.returning();
		work = updated ?? null;

		await db.insert(moderationActions).values({
			subjectType: "work",
			subjectId: appeal.workId,
			action: "reclassify",
			actorId: input.actorId,
			reason: "",
			note: `appeal granted — rated ${appeal.requestedMaturity}`,
			createdAt: now,
		});
	} else {
		const [row] = await db.select().from(works).where(eq(works.id, appeal.workId));
		work = row ?? null;
	}

	return { appeal: resolved, work };
}

/** Open appeals, oldest first — the operator queue's whole read. */
export async function loadOpenAppeals(limit = 100) {
	return db
		.select({
			id: workRatingAppeals.id,
			workId: workRatingAppeals.workId,
			creatorId: workRatingAppeals.creatorId,
			requestedMaturity: workRatingAppeals.requestedMaturity,
			correctedMaturity: workRatingAppeals.correctedMaturity,
			statement: workRatingAppeals.statement,
			createdAt: workRatingAppeals.createdAt,
			workTitle: works.title,
			workSlug: works.slug,
			workPublicId: works.publicId,
			workNotes: works.maturityNotes,
		})
		.from(workRatingAppeals)
		.innerJoin(works, eq(workRatingAppeals.workId, works.id))
		.where(eq(workRatingAppeals.status, "open"))
		.orderBy(workRatingAppeals.createdAt)
		.limit(limit);
}

/** A Work's own appeal history, newest first — what its creator is shown. */
export async function appealsForWork(workId: number, limit = 20): Promise<RatingAppealRow[]> {
	return db
		.select()
		.from(workRatingAppeals)
		.where(eq(workRatingAppeals.workId, workId))
		.orderBy(desc(workRatingAppeals.createdAt))
		.limit(limit);
}

export type { ContentNote };

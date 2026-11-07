// SPDX-License-Identifier: Apache-2.0
/**
 * Who may review a Work, and why not.
 *
 * A review is an opinion about something you have actually met, left for the people
 * deciding whether to meet it. The composer therefore answers before it is used rather
 * than after a failed post: the three refusals below are states of the reader, not
 * errors to discover by pressing a button.
 *
 * ⭐ **Consumption is the evidence each medium already produces.** A video or a track
 * credits on playback; text, images, games and software credit while the tab is visible
 * and the person is present. `attention_events` records both, under the one policy in
 * `@anthers/shared/attention`, so "has consumed this Work" is a row on the Work rather
 * than a second definition invented here. One second is enough: the review is the
 * reader's verdict, and a minutes-long floor would be a different policy with no
 * source behind it.
 *
 * ⚠️ **Raw attention rows prune after `ATTENTION_RAW_RETENTION_DAYS`**, so this evidence
 * is bounded. An existing review stays editable and removable whatever the raw rows say
 * (see the POST route), which is what keeps the gate from taking back a statement its
 * author already made.
 *
 * 🚨 **The creator's own Work is the first refusal, not a special case of access.**
 * `workAccessFor` answers `canAccess: true` for the owner, which is why authorship has
 * to be compared here rather than inferred from the access ladder.
 */
import { db } from "@anthers/db/client";
import { attentionEvents, type works } from "@anthers/db/schema";
import { isPreRelease } from "@anthers/shared/content";
import { and, eq, gt } from "drizzle-orm";

type WorkRow = typeof works.$inferSelect;

/** Why a reader cannot write a review. */
export type ReviewRefusalCode = "own_work" | "pre_release" | "unreleased" | "locked" | "unconsumed";

/** The composer's answer: open, or the one reason it is not. */
export interface ReviewEligibility {
	canReview: boolean;
	code: ReviewRefusalCode | null;
	/** Written for the reader and rendered verbatim; null when `canReview`. */
	reason: string | null;
}

const REASONS: Record<ReviewRefusalCode, string> = {
	own_work: "You can't review your own Work.",
	pre_release: "This Work isn't out yet — you can review it once it's released.",
	unreleased: "This Work hasn't been released yet.",
	locked: "Unlock this Work to review it.",
	unconsumed: "Spend some time with this Work before reviewing it.",
};

function refusal(code: ReviewRefusalCode): ReviewEligibility {
	return { canReview: false, code, reason: REASONS[code] };
}

/**
 * Whether this reader has spent any recorded time with this Work.
 *
 * `via_share_link` rows are excluded on purpose: they are attributed to the SHARER on
 * behalf of a stranger, so they say nothing about what the sharer themselves watched.
 */
async function hasConsumed(userId: number, workId: number): Promise<boolean> {
	const [row] = await db
		.select({ id: attentionEvents.id })
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, userId),
				eq(attentionEvents.workId, workId),
				eq(attentionEvents.viaShareLink, false),
				gt(attentionEvents.durationSeconds, 0),
			),
		)
		.limit(1);
	return Boolean(row);
}

/**
 * The full answer for one reader and one Work.
 *
 * The order matters: authorship is stated before access (the owner always has access),
 * and an unreleased Work is stated before its gate (there is nothing to unlock yet).
 */
export async function reviewEligibilityFor(
	userId: number,
	work: WorkRow,
	access: { canAccess: boolean },
): Promise<ReviewEligibility> {
	if (work.creatorId === userId) return refusal("own_work");
	// The page can be public while the Work is not (pre-release). Reviews open only at the
	// release, so this case is stated before the generic unreleased one.
	if (isPreRelease(work)) return refusal("pre_release");
	// `releasedAt` is when the Work went public HERE; a Work scheduled for the future is
	// still private. This is why a scheduled Work's reviews stay closed until its release.
	if (work.releasedAt == null) return refusal("unreleased");
	if (!access.canAccess) return refusal("locked");
	if (!(await hasConsumed(userId, work.id))) return refusal("unconsumed");
	return { canReview: true, code: null, reason: null };
}

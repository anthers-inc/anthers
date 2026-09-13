// SPDX-License-Identifier: Apache-2.0
/**
 * Content-model bounds shared by the API and every client.
 *
 * These live here rather than in `constants.ts` because that file is the
 * economics dials — the docs point at it as the source of truth for the model —
 * and mixing text-length limits into it muddies what it's for. They're shared at
 * all so the textarea's `maxLength` and the server's validator can't drift: a
 * client that lets someone type 2,000 characters into a 1,000-character field
 * turns a validation rule into lost work.
 */

/**
 * A review carries a verdict AND written text — a verdict can't be left on its own.
 *
 * The minimum is deliberately low, and it is not a quality filter: it's a blunt
 * instrument, and "lol" clears any threshold worth setting. The reason to require
 * text at all is that a written verdict gives a reader something to weigh and a
 * moderator something to act on, where a bare thumb is unmoderatable by
 * construction. Raising this to chase quality would mostly punish the terse.
 */
export const REVIEW_MIN = 4;
export const REVIEW_MAX = 5000;

/**
 * A review's verdict: whether the reviewer recommends the work.
 *
 * 🚨 **A verdict rather than a score on a scale** (Parker, 2026-09-12). A star
 * rating asks each person to convert a feeling into a number, which they do
 * inconsistently and mostly by picking an extreme — the distribution comes out
 * J-shaped, so the extra resolution measures nothing. Averaging it is worse
 * than useless: a mean of ordinal answers assumes the gap between 3 and 4
 * equals the gap between 4 and 5, and it does not, least of all across people.
 * A yes-or-no leaves the nuance to the aggregate, where "94% recommended" is a
 * proportion — an honest statistic rather than arithmetic performed on guesses.
 *
 * ⭐ **It also gives Anthers one opinion primitive instead of two.** Everything
 * else here aggregates up and down votes; a second, differently-shaped way to
 * say "I liked this" is a thing every reader would have to learn twice.
 *
 * ⚠️ **A string and not a boolean, and the reason is permanence.** A boolean's
 * type could never grow, and this is the record most likely to want a middle
 * verdict one day. The published Lexicon carries the same two values as an open
 * set, so adding a third is a value rather than a schema change. Somebody who
 * feels neither is meant to post nothing — posting a review is an action, and
 * having it mean something is the point.
 */
export const REVIEW_VERDICTS = ["recommended", "not-recommended"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
	return typeof v === "string" && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

/**
 * How a verdict reads to a person. Title case, because it labels a thing rather
 * than saying something about one.
 *
 * ⚠️ An unrecognized verdict is returned as-is rather than guessed at. The
 * published set is open, so a value this build has never heard of is a record
 * from a later version rather than corruption, and showing it verbatim is more
 * honest than folding it into one of the two we know.
 */
export function verdictLabel(verdict: string): string {
	if (verdict === "recommended") return "Recommended";
	if (verdict === "not-recommended") return "Not Recommended";
	return verdict;
}

/**
 * The share of visible reviews that recommend a work, 0–100, or null when there
 * are none.
 *
 * ⚠️ **Every review counts once.** Helpfulness sorts the list and does not
 * weight the aggregate: a review somebody found useful is not a stronger
 * recommendation, it is an easier one to read. If that ever changes it would
 * only be to stop counting reviews voted net-unhelpful, which is a different
 * thing from scaling their contribution.
 */
export function recommendedPercent(recommended: number, total: number): number | null {
	if (total <= 0) return null;
	return Math.round((recommended / total) * 100);
}

/** A comment's body. Matches the limit the comment route has always enforced. */
export const COMMENT_MAX = 10000;

/**
 * What a comment is attached to.
 *
 * Distinct from `ModerationSubjectType`, which is what gets *moderated* (a comment, a
 * review). This is what a comment hangs off: a **Post** — discussion of an announcement —
 * or a **Work** — discussion of the thing itself. Both are real and they are not the same
 * conversation, which is why the column is polymorphic rather than one or the other.
 */
export type CommentSubjectType = "post" | "work";

export const COMMENT_SUBJECT_TYPES: readonly CommentSubjectType[] = ["post", "work"];

export function isCommentSubjectType(value: string): value is CommentSubjectType {
	return (COMMENT_SUBJECT_TYPES as readonly string[]).includes(value);
}

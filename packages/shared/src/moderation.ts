// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation vocabulary — the report taxonomy, the subject types, and the states
 * a moderated row can hold. Pure (no clock, no DOM, no I/O), like `attention.ts`
 * and `access.ts`, so the API, the web app and any future creator-side or labeler
 * tool all read the same list rather than each hard-coding its own.
 *
 * Two decisions are frozen here, and both are deliberate:
 *
 * 1. **Removal is a STATE, not a delete.** `ModerationStatus` is the whole
 *    vocabulary a moderated row can hold, and there is no terminal value that
 *    means "gone". Hiding is reversible and leaves the row, its author, its text
 *    and its timestamps intact — which is what lets appeals, creator-side tools
 *    and composable labelers layer on later as features rather than migrations.
 *
 * 2. **The taxonomy is small on purpose.** Six reasons, chosen to be answerable
 *    by one operator looking at one comment: each either describes something the
 *    operator can see, or is `other` and carries the reporter's own words. There
 *    is deliberately no "misinformation" bucket — it is the one category that
 *    cannot be adjudicated from the artifact alone, and a queue full of reports
 *    nobody can act on trains the operator to ignore the queue. It also isn't a
 *    legal taxonomy: DMCA and other formal notice paths are a separate surface
 *    with their own required elements, not a radio button here.
 *
 * The reason a report carries and the reason an action records are the SAME
 * vocabulary, so an operator confirming a report doesn't have to translate it.
 */

/**
 * What a report or action points at.
 *
 * `comment` and `rating` are user-generated rows. `user` is a **person**, added
 * because a platform where adult creators and 13–17-year-olds share a space needs a
 * way to report a pattern of behaviour, not only the one artifact that happens to
 * have survived. `work` is a published Work — added for DMCA takedown, where the
 * target of a notice is a Work rather than a comment or a review.
 *
 * Each is a new *value* rather than a new column and a branch in every query, which
 * is the whole reason these tables were built polymorphic.
 *
 * The three are not interchangeable in what an operator may *do* with them — see
 * `isModeratableContent`.
 */
export type ModerationSubjectType = "comment" | "rating" | "user" | "work";

export const MODERATION_SUBJECT_TYPES: readonly ModerationSubjectType[] = [
	"comment",
	"rating",
	"user",
	"work",
];

export function isModerationSubjectType(value: string): value is ModerationSubjectType {
	return (MODERATION_SUBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * Subject types that carry a `moderation_status` and can therefore be hidden and
 * restored. **A `user` cannot**, and the omission is deliberate rather than pending:
 * hiding a person is account suspension, which has to answer what becomes of their
 * Works, their buyers' purchases, the support pointed at them and any payout in
 * flight. None of that is decided, so a person report routes to a human who acts out
 * of band, and the only in-app outcome is `dismiss`.
 *
 * Stating it as a predicate rather than leaving `hideSubject` to fail on a missing
 * column is what keeps the refusal legible — a 400 that says why, instead of a 500.
 */
export function isModeratableContent(value: ModerationSubjectType): boolean {
	return value === "comment" || value === "rating";
}

/**
 * Whether a report of this subject type must carry the reporter's own words.
 *
 * A comment or a review IS the evidence — an operator opens it and sees what the
 * reporter saw. A person is not: "harassment" against an account names no artifact,
 * and an operator receiving it has nothing to look at. So the six reasons stay
 * exactly as they are (renaming one is a data migration, and all six can be true of
 * a person) and the *intake* changes instead: a person report has to say where to
 * look. That is the answer to "the taxonomy may not fit a person" — it fits; what
 * doesn't transfer is the evidence being implied by the subject.
 */
export function reportRequiresDetails(value: ModerationSubjectType): boolean {
	return value === "user";
}

/**
 * The state of a moderated row. `visible` is the default every row is born with;
 * `hidden` withholds it from every public read. There is no third value, and in
 * particular no "deleted" — see the module note.
 */
export type ModerationStatus = "visible" | "hidden";

export const MODERATION_STATUSES: readonly ModerationStatus[] = ["visible", "hidden"];

/** The report taxonomy. `value` is stored; `label`/`hint` are what a reporter reads. */
export interface ModerationReason {
	value: string;
	label: string;
	hint: string;
}

export const MODERATION_REASONS: readonly ModerationReason[] = [
	{
		value: "spam",
		label: "Spam or advertising",
		hint: "Unsolicited promotion, scams, or repetitive posting.",
	},
	{
		value: "harassment",
		label: "Harassment or hate",
		hint: "Targeted abuse, or attacks on a person or group.",
	},
	{
		value: "sexual",
		label: "Sexual content",
		hint: "Explicit sexual material, or any sexual content involving minors.",
	},
	{
		value: "violence",
		label: "Violence or threats",
		hint: "Threats of harm, incitement, or graphic violence.",
	},
	{
		value: "illegal",
		label: "Illegal content",
		hint: "Content that appears to break the law.",
	},
	{
		value: "other",
		label: "Something else",
		hint: "Tell us what's wrong and an operator will read it.",
	},
] as const;

export const MODERATION_REASON_VALUES: readonly string[] = MODERATION_REASONS.map((r) => r.value);

export function isModerationReason(value: string): boolean {
	return MODERATION_REASON_VALUES.includes(value);
}

/** Human label for a stored reason code; falls back to the code for forward compatibility. */
export function moderationReasonLabel(value: string): string {
	return MODERATION_REASONS.find((r) => r.value === value)?.label ?? value;
}

/** What an operator did. Append-only vocabulary — every entry is a recorded decision. */
export type ModerationActionType = "hide" | "restore";

/**
 * Who decided. v1 has exactly one operator, but the column exists from day one
 * because comments carry `atproto_uri` and federation means the deciding
 * authority stops being a given. Backfilling "who was this authority?" onto a
 * log written under the assumption there was only ever one is the expensive
 * version of this change; a text column with a default is the cheap one.
 */
export type ModerationActorRole = "operator" | "creator" | "automated";

/** Free-text bounds, enforced identically at the API boundary and in the UI. */
export const REPORT_DETAILS_MAX = 1000;
export const MODERATION_NOTE_MAX = 1000;

/** A report's lifecycle. Resolution is a fact about the report, not about the content. */
export type ReportStatus = "open" | "resolved" | "dismissed";

export const REPORT_STATUSES: readonly ReportStatus[] = ["open", "resolved", "dismissed"];

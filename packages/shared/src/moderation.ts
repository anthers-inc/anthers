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

/** What a report or action points at. Both are user-generated rows on a post. */
export type ModerationSubjectType = "comment" | "rating";

export const MODERATION_SUBJECT_TYPES: readonly ModerationSubjectType[] = ["comment", "rating"];

export function isModerationSubjectType(value: string): value is ModerationSubjectType {
	return (MODERATION_SUBJECT_TYPES as readonly string[]).includes(value);
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

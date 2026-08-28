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

/**
 * Which of the two groups a reason belongs to.
 *
 * 🚨 **The split is legal versus rule-breaking, and not urgent versus not** (Parker,
 * 2026-08-26, and it is the sharper framing). Everything in `law` is against the law and is
 * not up for discussion, debate or discretion on Anthers — so the group says what *kind of
 * thing* the report is, and urgency is conveyed by the ordering within each group and by
 * saying so in the subtitle. A grouping by urgency would have to rank a threat against a
 * piece of pornography, which is a judgment the reporter should not be asked to make and
 * the interface should not appear to have made.
 */
export type ModerationReasonGroup = "law" | "rules";

export interface ModerationReasonGroupDef {
	key: ModerationReasonGroup;
	heading: string;
	subtitle: string;
}

/**
 * The two headings, in the order they are shown.
 *
 * The legal group is first, and that ordering is one of the three mitigations that make
 * splitting the old `sexual` reason safe — see `MODERATION_REASONS` below.
 */
export const MODERATION_REASON_GROUPS: readonly ModerationReasonGroupDef[] = [
	{
		key: "law",
		heading: "Against the Law",
		subtitle: "Not ours to weigh. These reach a person straight away.",
	},
	{
		key: "rules",
		heading: "Against Our Rules",
		subtitle: "An operator reviews these. Listed most serious first.",
	},
] as const;

/**
 * A question a reporter meets before going on, and where it sends them instead.
 *
 * One reason carries one of these and it is the load-bearing half of splitting the sexual
 * reason in two. The control **switches the selection** rather than only warning: a warning
 * a reporter can read and ignore leaves the misfiled report filed, which is the whole thing
 * this is trying to prevent.
 */
export interface ModerationReasonConfirm {
	question: string;
	/** The reason code the control moves them to. */
	switchTo: string;
	switchLabel: string;
	/** What the button that keeps the current selection says. */
	keepLabel: string;
}

/** The report taxonomy. `value` is stored; everything else is what a reporter reads. */
export interface ModerationReason {
	value: string;
	group: ModerationReasonGroup;
	label: string;
	hint: string;
	confirm?: ModerationReasonConfirm;
}

/**
 * The reasons, grouped and ordered most serious first within each group.
 *
 * ⚠️ **Splitting the old `sexual` reason trades one safety property for another, and the
 * trade only works because of three specific mitigations.** The retired reason read
 * *"Explicit sexual material, or any sexual content involving minors"* — one line spanning a
 * crime and a rule-break — which was indiscriminate and therefore safe: every reporter
 * landed in a bucket that escalates. Split, a reporter could pick the rule-break for
 * something involving a minor. What makes the split worth it: **the legal group is ordered
 * first**, **the pornography hint names what it is not**, and **selecting it poses a
 * confirmation whose control switches the selection**. Removing any one of those three
 * re-opens the hole.
 *
 * ⭐ **"Pornographic material" is the operative term and "sexually explicit" is the
 * definition, rather than the other way round** (Parker). The retired label leaned on
 * "explicit" to carry a distinction the word does not carry on its own and then defined it
 * in one word anyway. What the hint leans on instead is Anthers' own settled distinction
 * from wiki 40.13 — *subject matter is not the same as treatment* — because "explicit" is
 * only a synonym for the thing being defined. 🚨 **The hint says "what Anthers allows at
 * all" rather than naming a rung**, because the boundary sits above the top of the rating
 * scale rather than above `mature`: once `adult` exists, a hint reading "beyond mature work"
 * would invite reports against work that is correctly rated and perfectly allowed.
 *
 * 🚨 **Never list queer lives as an example of mature work.** An early draft of the
 * pornography hint read *"Anthers allows mature work — nudity, sexuality as a subject, queer
 * lives"*, which asserts precisely the premise 40.13 exists to refuse: said at that length
 * it reads as agreement that queer life is an adult concept. The refusal belongs somewhere
 * long enough to *be* a refusal, which is `/safety`, and nowhere shorter — anything that
 * fits in a hint reads as the concession rather than the refusal.
 */
export const MODERATION_REASONS: readonly ModerationReason[] = [
	{
		value: "csam",
		group: "law",
		label: "Child sexual abuse or exploitation",
		hint: "Sexual content involving anyone under 18, or an adult soliciting a minor. Reported to authorities, not only to us.",
	},
	{
		value: "violence",
		group: "law",
		label: "Threats or violence",
		hint: "Threats of harm, incitement, or graphic violence.",
	},
	{
		value: "illegal",
		group: "law",
		// ⚠️ "Appears" stays. A reporter is not a lawyer, and the heading speaks to how the
		// report is handled rather than to how certain they have to be.
		label: "Something else against the law",
		hint: "Anything else that appears to break the law, excluding copyright infringement (see below).",
	},
	{
		value: "pornography",
		group: "rules",
		label: "Pornographic material",
		hint: "Sexually explicit material beyond what Anthers allows at all. The distinction is not the subject matter but how it's treated: art that deals with sex, nudity or the body is allowed on Anthers; material made to function as pornography is not. Before reporting this, please be considerate of the notion that your personal discomfort level with a piece of mature content doesn't necessarily make it pornographic.",
		confirm: {
			question:
				"Does any of this involve someone under 18? If it might, report it as child sexual abuse or exploitation instead. That is a legal matter with a different process: it reaches a person immediately and is reported to authorities.",
			switchTo: "csam",
			switchLabel: "Report it as child sexual abuse instead",
			keepLabel: "No — everyone in it is an adult",
		},
	},
	{
		value: "unrated-mature",
		group: "rules",
		// 🚨 The label names no rung at all, and that is the choice worth keeping. Under-
		// declaration is one report whatever the size of the gap, so the reason covers the
		// whole scale — but a label reading "…that isn't marked Adult" would put the
		// expensive rung in front of every reporter deciding what to click, which is how a
		// rung meant to be rare becomes a general-purpose bucket for work somebody found
		// disturbing. That is the outcome wiki 40.13 draws its rows to prevent, and the
		// value `unrated-mature` is left alone because renaming a stored reason code would
		// rewrite what past reports said they were about.
		label: "Work that isn't rated for what it shows",
		hint: "Work rated lower than what it actually depicts — something made for adults rated General, or explicit work rated Mature. This reads how a work is treated rather than what it is about: a story dealing with violence, sex or addiction is not under-rated for its subject. An operator can correct a rating, and the creator can appeal that.",
	},
	{
		value: "harassment",
		group: "rules",
		label: "Harassment or hate",
		hint: "Targeted abuse, or attacks on a person or group.",
	},
	{
		value: "spam",
		group: "rules",
		label: "Spam or advertising",
		hint: "Unsolicited promotion, scams, or repetitive posting.",
	},
	{
		value: "other",
		group: "rules",
		label: "Something else",
		hint: "Tell us what's wrong and an operator will read it.",
	},
] as const;

/** The reasons in one group, in order. What a grouped picker iterates. */
export function reasonsInGroup(group: ModerationReasonGroup): ModerationReason[] {
	return MODERATION_REASONS.filter((r) => r.group === group);
}

export const MODERATION_REASON_VALUES: readonly string[] = MODERATION_REASONS.map((r) => r.value);

/**
 * Reason codes no longer offered, kept only so a stored row still reads as something.
 *
 * 🚨 **A retired reason is not a deleted one.** `moderation_reports.reason` and
 * `moderation_actions.reason` hold these verbatim, so rows carrying `sexual` exist and an
 * operator opening one has to see what the reporter actually picked rather than a raw code.
 * `isModerationReason` deliberately does **not** accept these — nothing may file a new one —
 * while `moderationReasonLabel` deliberately does.
 */
export const RETIRED_MODERATION_REASONS: readonly ModerationReason[] = [
	{
		value: "sexual",
		group: "law",
		label: "Sexual content",
		hint: "Explicit sexual material, or any sexual content involving minors.",
	},
] as const;

export function isModerationReason(value: string): boolean {
	return MODERATION_REASON_VALUES.includes(value);
}

/** Human label for a stored reason code; falls back to the code for forward compatibility. */
export function moderationReasonLabel(value: string): string {
	return (
		MODERATION_REASONS.find((r) => r.value === value)?.label ??
		RETIRED_MODERATION_REASONS.find((r) => r.value === value)?.label ??
		value
	);
}

/**
 * The reasons that reach Anthers no matter who else holds the scope, and that a
 * scoped Keeper will never be able to dismiss away — 40.06's floor.
 *
 * ⭐ **It is the `law` group, plus one retired code**, and stating it that way is the
 * point: the grouping a reporter sees and the routing they cannot see are the same
 * division, so a reason added to the legal group without being added here would be
 * presented as reaching a person straight away and would not.
 *
 * 🚨 **`sexual` stays in this list although nothing can file one any more.** Rows carrying
 * it were written while it was the code the form steered a child-safety reporter toward,
 * and a legacy row still has to escalate rather than going quiet. Removing it would make
 * the retirement of a *label* silently change the handling of *records*.
 *
 * This is the taxonomy half of the split. The routing half — who a non-floor report
 * goes to instead — waits on the Keeper appointment model, and does not gate this:
 * with no scopes yet, every report already reaches Anthers, and what was missing was
 * anybody being *told*.
 */
export const FLOOR_MODERATION_REASONS: readonly string[] = [
	...reasonsInGroup("law").map((r) => r.value),
	"sexual",
];

/** Does this reason demand escalation out of the queue, rather than a queue entry alone? */
export function isFloorReason(value: string): boolean {
	return FLOOR_MODERATION_REASONS.includes(value);
}

/**
 * What an operator did. Append-only vocabulary — every entry is a recorded decision.
 *
 * `reclassify` is a correction to a Work's maturity rating, and it is a third value rather
 * than a reuse of the first two because it is neither a hide nor a restore: nothing becomes
 * more or less reachable, and recording it as either would make the log lie about what
 * happened. `services/content-rating.ts` is the only thing that writes one.
 */
export type ModerationActionType = "hide" | "restore" | "reclassify";

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

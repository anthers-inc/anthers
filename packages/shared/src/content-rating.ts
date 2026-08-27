// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content ratings — the maturity a Work carries, and the notes that describe it.
 *
 * Pure (no clock, no DOM, no I/O), like `moderation.ts` and `attention.ts`, so the API, the
 * web app and any future creator-side or labeler tool read the same vocabulary rather than
 * each hard-coding its own. This file is the transcription and the place a value is added.
 *
 * **Two wiki documents own this between them and they do not overlap.** Wiki 40.13, The
 * Rating Standard, is the authority on what the values *mean* — the row-by-row table, where
 * each line falls, what may never be a factor, and worked examples. Wiki 40.09 is the
 * authority on what a rating *costs* and how that is enforced. Read 40.13 before rating
 * anything or adding a value; read 40.09 before building a surface that acts on one.
 *
 * Three decisions are frozen here.
 *
 * 1. **The rating decides access and the notes describe the work.** A Work carries exactly
 *    one `MaturityRating`, and that single value is what a viewer filter reads and what the
 *    Adult rung will attach to when it opens. The notes beside it carry no access consequence
 *    from the platform and never will — 🚨 **a note may be read by a reader's own filter and
 *    may never drive a platform default**, so the most one can cost a creator is a blur shown
 *    to somebody who asked to be warned about exactly that. The expressiveness lives off the
 *    axis that carries consequences, which is what makes it safe to have.
 *
 * 2. **`unrated` is a real state and not a missing value.** Defaulting a Work to `general`
 *    would assert a rating on a creator's behalf that nobody asked them for, and would make
 *    an unanswered question indistinguishable from an answered one. That distinction is
 *    exactly what a report of *"this is mature and is not labeled as mature"* has to be able
 *    to draw, so it is a value rather than a null.
 *
 * 3. 🚨 **Two standing principles bound what `mature` may ever mean, and neither is open
 *    here.** A queer person existing in a story does not make it mature — neither does a
 *    trans character, a same-sex relationship, or a discussion of identity, and political
 *    pressure to classify these as adult content is the pressure the category exists to
 *    resist. And subject matter is not the same as treatment: work *about* addiction,
 *    violence or sexuality is not rated for its subject, because depiction, explicitness and
 *    intent are what a rating reads. 40.13 § What Is Never a Factor carries both, together
 *    with the full list of what may never move a Work along the scale.
 */

/**
 * What a Work is rated.
 *
 * - `unrated` — nobody has said. Every Work is born here, and release is refused until
 *   somebody answers.
 * - `general` — its creator says anyone can meet it.
 * - `mature` — its creator (or an operator) says it is made for adults.
 *
 * ⚠️ **This scale is one value short of the one 40.13 defines, and `mature` gates nothing
 * today.** The standard runs `unrated` · `general` · `mature` · `adult`, so there is nothing
 * an operator can set on a Work belonging at the top of it; adding `adult` and refusing
 * release at a rung Anthers does not currently accept is its own task. Nothing above `adult`
 * is a rating at all — work that functions as pornography is disallowed outright, enforced
 * through `moderation.ts`'s taxonomy rather than by a value here. Mature work meanwhile is
 * ordinary work on Anthers, and what the rating does now is give the viewer filters
 * something to read.
 */
export type MaturityRating = "unrated" | "general" | "mature";

export const MATURITY_RATINGS: readonly MaturityRating[] = ["unrated", "general", "mature"];

export function isMaturityRating(value: string): value is MaturityRating {
	return (MATURITY_RATINGS as readonly string[]).includes(value);
}

/**
 * A rating somebody can actually choose.
 *
 * `unrated` is excluded by construction rather than by convention, so a picker cannot offer
 * it and an input type cannot accept it — it is the state a Work is born in and leaves, and
 * a client able to set it could un-release a Work by a side door.
 */
export type DeclarableMaturity = Exclude<MaturityRating, "unrated">;

export interface MaturityRatingDef {
	value: DeclarableMaturity;
	label: string;
	hint: string;
}

/** What a creator picks between. `unrated` is not offered — it is what they are leaving. */
export const MATURITY_CHOICES: readonly MaturityRatingDef[] = [
	{
		value: "general",
		label: "General",
		hint: "Anyone can meet this. Most work on Anthers is General.",
	},
	{
		value: "mature",
		label: "Mature",
		hint: "Made for adults — not because of what it is about, but because of how it treats it. A story that deals with violence, sex or addiction is not Mature for its subject; depiction, explicitness and intent are what this reads.",
	},
] as const;

/**
 * How cautious a rating is, so "more cautious" can be compared rather than enumerated.
 *
 * This is the whole of the rule that lets a creator raise their own rating after an operator
 * has corrected it while refusing to let them lower it — see `services/content-rating.ts`.
 * Writing it as an order rather than as a pair of `if`s is what keeps that rule true if a
 * fourth value is ever added between these.
 */
const CAUTION: Record<MaturityRating, number> = { unrated: 0, general: 1, mature: 2 };

/** Is `next` at least as cautious a rating as `current`? */
export function isAtLeastAsCautious(next: MaturityRating, current: MaturityRating): boolean {
	return CAUTION[next] >= CAUTION[current];
}

/** Human label for a stored rating; falls back to the code for forward compatibility. */
export function maturityLabel(value: string): string {
	if (value === "unrated") return "Unrated";
	return MATURITY_CHOICES.find((r) => r.value === value)?.label ?? value;
}

/**
 * A content note — what someone meeting this work should know is in it.
 *
 * ⭐ **These are warnings, not classifications, and nothing reads them to decide access.**
 * That is what keeps them honest: there is no advantage to leaving one off, so there is
 * nothing here to enforce and nothing to appeal. If several ratings are ever genuinely
 * wanted, these are the inputs a computed rating would read.
 */
export type ContentNote =
	| "violence"
	| "sexual-themes"
	| "substance-use"
	| "self-harm"
	| "horror"
	| "language";

export interface ContentNoteDef {
	value: ContentNote;
	label: string;
}

export const CONTENT_NOTES: readonly ContentNoteDef[] = [
	{ value: "violence", label: "Violence" },
	{ value: "sexual-themes", label: "Sexual Themes" },
	{ value: "substance-use", label: "Substance Use" },
	{ value: "self-harm", label: "Self-Harm" },
	{ value: "horror", label: "Intense Horror" },
	{ value: "language", label: "Strong Language" },
] as const;

export const CONTENT_NOTE_VALUES: readonly string[] = CONTENT_NOTES.map((n) => n.value);

export function isContentNote(value: string): value is ContentNote {
	return CONTENT_NOTE_VALUES.includes(value);
}

/** Human label for a stored note; falls back to the code for forward compatibility. */
export function contentNoteLabel(value: string): string {
	return CONTENT_NOTES.find((n) => n.value === value)?.label ?? value;
}

/**
 * Keep only notes this build knows, in the canonical order.
 *
 * Order matters because the notes are rendered as a list a reader scans, and a set that
 * reorders itself between saves reads as a change that was not made. Unknown values are
 * dropped rather than kept, since a note nothing can label is a note nobody can read.
 */
export function normalizeContentNotes(values: readonly string[]): ContentNote[] {
	const wanted = new Set(values);
	return CONTENT_NOTES.filter((n) => wanted.has(n.value)).map((n) => n.value);
}

/**
 * Who set the rating a Work currently carries.
 *
 * `null` means nobody has — the Work is `unrated` and untouched. The distinction between
 * `creator` and `operator` is what makes a correction hold: while a rating is `operator`-set,
 * its creator may raise it but not lower it, and lowering it takes an appeal.
 */
export type MaturitySource = "creator" | "operator";

/** A creator's appeal against an operator's correction. */
export type RatingAppealStatus = "open" | "granted" | "upheld";

export const RATING_APPEAL_STATUSES: readonly RatingAppealStatus[] = ["open", "granted", "upheld"];

/** Free-text bounds, enforced identically at the API boundary and in the UI. */
export const RATING_APPEAL_STATEMENT_MAX = 2000;
export const RATING_NOTE_MAX = 1000;

// SPDX-License-Identifier: Apache-2.0
/**
 * What a shared Work link is allowed to say about the Work.
 *
 * A link preview is fetched by whoever a URL is pasted to — a chat, a feed, a message to
 * somebody who has never opened Anthers — so it is the one surface that reaches an
 * audience with no account, no setting and no filter. The served page's own rules answer
 * a different question (may this person reach the Work), and the answer here has to be
 * stricter in one direction only: **a Work that carries a rating above General serves the
 * site card, never its own title, blurb or thumbnail.** The thumbnail itself is required
 * to be free of Mature and Adult content (`THUMBNAIL_RULE` in `content.ts`), so the
 * thumbnail is not the risk the rating is — the title and the blurb are the creator's own
 * words about the work, written for a reader who asked to meet it.
 *
 * `general` is the only rung that travels, and everything else — `mature`, `adult`,
 * `unrated`, a value this build has never heard of — fails closed. That is the same
 * direction `requiresAdultVerification` fails in, for the same reason: a rating this
 * build cannot read is not a rating it may publish.
 *
 * The neutral answer is `null`, not a generated card, because the shell already carries
 * the site-level tags. A caller that gets `null` leaves the served head exactly as it
 * shipped, so there is one description of the neutral card (the shell, and its own test)
 * rather than two that drift.
 */

/**
 * The sentence a Work with no blurb still says. Not a description of the Work — the
 * creator has not written one — but enough for a link card to have a body rather than an
 * empty second line, and true of every Work on the platform.
 */
export const WORK_PREVIEW_FALLBACK_DESCRIPTION =
	"A Work on Anthers, a nonprofit creative garden for everyone.";

/** The fields a preview needs, and no others. `Work` rows and the card endpoint both fit. */
export interface PreviewableWork {
	/** Nullable because the column is; a blank title serves the site card. */
	title: string | null;
	description: string | null;
	thumbnail: string | null;
	maturity: string | null;
}

export interface WorkPreview {
	title: string;
	description: string;
	/** An absolute URL, or null when the Work has no thumbnail — the site card fills in. */
	image: string | null;
}

/**
 * Whether a Work's rating lets its own facts travel in a link preview.
 *
 * Only `general` does. Read as a whitelist rather than "anything except adult" so a rating
 * added later cannot inherit an assumption nobody made about it.
 */
export function servesOwnPreview(maturity: string | null | undefined): boolean {
	return maturity === "general";
}

/**
 * The preview a shared Work link serves, or null for the site card.
 *
 * Returns null when the rating does not travel and when there is no title to show — a
 * card named after the site is better than a card with an empty heading. A missing blurb
 * does not null the whole preview; it falls back to a sentence about the platform.
 */
export function workPreviewFor(work: PreviewableWork): WorkPreview | null {
	if (!servesOwnPreview(work.maturity)) return null;
	const title = (work.title ?? "").trim();
	if (title === "") return null;
	const description = (work.description ?? "").trim();
	return {
		title,
		description: description === "" ? WORK_PREVIEW_FALLBACK_DESCRIPTION : description,
		image: work.thumbnail,
	};
}

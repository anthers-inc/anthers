// SPDX-License-Identifier: Apache-2.0
/**
 * What a shared post's link preview says about it.
 *
 * A post carries no rating and no gate of its own — its page reads signed out — so unlike a
 * Work there is no ladder to consult here. What is left is the shape of the card: the title
 * as the page shows it (mentions resolved), the body as plain text, and the thumbnail of the
 * first Work the post embeds. The one rule that does not come from the post is the image's:
 * an Adult Work's cover must not reach an unverified stranger through a post that links it,
 * so the caller resolves the image through the same visibility allow-list every listing
 * uses, and hands this function only what survived it.
 *
 * The fallbacks exist so a card always has a heading and a body. A post's title is optional
 * in the schema and its body may be a single image, so "nothing to say" is a real state
 * rather than a defect.
 */

/** What a title-less post is called, matching the word its own page shows. */
export const POST_PREVIEW_FALLBACK_TITLE = "Untitled";

/**
 * The sentence a post with no words still says. Not a description of the post — the
 * creator has not written one — but enough for a link card to have a body rather than an
 * empty second line, and true of every post on the platform.
 */
export const POST_PREVIEW_FALLBACK_DESCRIPTION =
	"A post on Anthers, a nonprofit creative garden for everyone.";

/**
 * How much of a post's body a link card carries.
 *
 * Shorter than the feed tile's excerpt on purpose: a tile's line clamp cuts a paragraph
 * that is already on the page, while a card is pasted into a chat where every unfurler
 * truncates it again — at roughly this length. Cutting here means the words that survive
 * are the ones the reader was meant to see rather than whatever the platform kept.
 */
export const POST_PREVIEW_EXCERPT_LIMIT = 200;

/** The fields a preview needs, and no others. */
export interface PreviewablePost {
	/** The title as the page shows it, with each mentioned Work's current name resolved. */
	displayTitle: string | null;
	/** The body as plain text. Bounded by the caller, so this module never parses markdown. */
	excerpt: string | null;
	/** An absolute URL, or null when the post embeds nothing with a thumbnail. */
	image: string | null;
}

export interface PostPreview {
	title: string;
	description: string;
	image: string | null;
}

/** The card a shared post serves. Always present: a published post is always sayable. */
export function postPreviewFor(post: PreviewablePost): PostPreview {
	const title = (post.displayTitle ?? "").trim();
	const description = (post.excerpt ?? "").trim();
	return {
		title: title === "" ? POST_PREVIEW_FALLBACK_TITLE : title,
		description: description === "" ? POST_PREVIEW_FALLBACK_DESCRIPTION : description,
		image: post.image,
	};
}

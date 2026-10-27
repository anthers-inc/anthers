// SPDX-License-Identifier: Apache-2.0
/**
 * What a shared profile's link preview says about its creator.
 *
 * A profile carries no gate and no ladder of its own — the page reads signed out — so the
 * only rule that reaches this shape from elsewhere is who a profile may name at all: a
 * suspended account's page answers not-found, and a card that described one would publish
 * what the page withholds. That gate belongs to the read, which resolves the handle and
 * checks the account, and this module only decides what the surviving facts say.
 *
 * A card names the person and stops. What the profile lists — the Library, the posts, the
 * counts — is the page's business, and a preview that tried to summarize somebody's body
 * of work would be describing it to a reader who has not met it.
 */

/** The sentence a profile with no bio still says. */
export const CREATOR_PREVIEW_FALLBACK_DESCRIPTION =
	"A profile on Anthers, a nonprofit creative garden for everyone.";

/** The fields a profile preview needs, and no others. */
export interface PreviewableCreator {
	/** The name the creator chose, or null when they have not set one. */
	displayName: string | null;
	/** Their current handle, without the `@` the address carries. */
	handle: string;
	/** Their own words about themselves. */
	bio: string | null;
	/**
	 * The absolute URL of the image the card serves, or null where the creator has set no
	 * picture at all and the site card stands. A profile's image is the composed card the web
	 * origin renders from the portrait and banner, not the portrait itself.
	 */
	image: string | null;
}

export interface CreatorPreview {
	title: string;
	description: string;
	image: string | null;
}

/** The card a shared profile serves. Always present: a handle that resolves is sayable. */
export function creatorPreviewFor(creator: PreviewableCreator): CreatorPreview {
	const displayName = (creator.displayName ?? "").trim();
	const bio = (creator.bio ?? "").trim();
	return {
		// A handle is the one name every account has, so a creator who never set a display
		// name still gets a card named after the address they were shared by.
		title: displayName === "" ? `@${creator.handle}` : displayName,
		description: bio === "" ? CREATOR_PREVIEW_FALLBACK_DESCRIPTION : bio,
		image: creator.image,
	};
}

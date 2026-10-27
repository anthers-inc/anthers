// SPDX-License-Identifier: Apache-2.0
/**
 * The served head for a route that knows what it is serving.
 *
 * The app shell ships one neutral card — the site's own — because a static document
 * cannot know which Work a URL names. The web server can, so it swaps that region for the
 * Work's facts without touching anything else in the document: the SPA still boots from
 * the same shell, the same bundle and the same route resolution, and the crawler that
 * never runs a line of JavaScript still gets a real title and a real image.
 *
 * **The region is delimited by the markers in `index.html`, not by matching tag strings.**
 * A regex over `og:` tags would silently keep working after somebody reorders or renames
 * one of them, and "silently keeps working" is the failure this whole area exists to
 * avoid. Missing markers are therefore a failure to inject, not a guess: the document is
 * returned exactly as it shipped, which is the site card.
 *
 * Every value is escaped for the attribute it lands in. A Work title is creator-authored
 * text, so a quote or an angle bracket in it must not be able to close the tag it sits in.
 */

import { pageTitle } from "@anthers/web-shared/page-title";

/**
 * The three facts a link card carries, and the only three it may carry.
 *
 * A Work's card and a post's card are the same shape on purpose: this renderer should not
 * know which document it is describing, and the two server reads that produce these facts
 * own their own rules. `WorkPreview` and `PostPreview` both satisfy this structurally.
 */
/**
 * The facts a link card carries.
 *
 * A Work's card and a post's card are the same shape on purpose: this renderer should not
 * know which document it is describing, and the two server reads that produce these facts
 * own their own rules. `WorkPreview` and `PostPreview` both satisfy this structurally.
 *
 * `imageAlt` is the image's own description, and only a read that knows the image is not a
 * thumbnail sets it — a profile's composed card being the case that made it necessary.
 */
export interface LinkCard {
	title: string;
	description: string;
	image: string | null;
	/** What the image shows, when the default would describe it wrongly. */
	imageAlt?: string | null;
}

/** The markers `index.html` carries around its site-level share tags. */
export const SHARE_BEGIN = "<!-- share:begin -->";
export const SHARE_END = "<!-- share:end -->";

/**
 * The site card's stable address, repeated from `index.html` because a served document
 * cannot read another tag's value. `share-head.test.ts` asserts the two agree, and
 * `public/brand/README.md` owns the file's own story.
 */
export const SITE_CARD_URL = "https://anthers.org/brand/og-card.png";
export const SITE_CARD_ALT =
	"The Anthers wordmark, an orchid spray, and a bee above pale meadow grass.";
export const SITE_CARD_WIDTH = "1200";
export const SITE_CARD_HEIGHT = "630";

/** Escape for a double-quoted attribute value. */
export function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Escape for element text (`<title>`). */
export function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The tags one Work's link card serves.
 *
 * `og:image:width` and `og:image:height` are emitted only for the site card. A Work's
 * thumbnail is whatever shape its creator uploaded, and a dimension that is not the
 * image's real one is worse than an absent one — some unfurlers crop to it.
 */
export function renderShareHead(preview: LinkCard, canonicalUrl: string): string {
	const title = escapeAttribute(preview.title);
	const description = escapeAttribute(preview.description);
	const url = escapeAttribute(canonicalUrl);
	const image = preview.image ? escapeAttribute(preview.image) : SITE_CARD_URL;
	const lines = [
		`<title>${escapeText(pageTitle(preview.title))}</title>`,
		`<meta name="description" content="${description}" />`,
		`<meta property="og:type" content="website" />`,
		`<meta property="og:site_name" content="Anthers" />`,
		`<meta property="og:title" content="${title}" />`,
		`<meta property="og:description" content="${description}" />`,
		`<meta property="og:url" content="${url}" />`,
		`<meta property="og:image" content="${image}" />`,
	];
	if (preview.image) {
		lines.push(
			`<meta property="og:image:alt" content="${escapeAttribute(preview.imageAlt ?? `The thumbnail for ${preview.title}.`)}" />`,
		);
	} else {
		lines.push(
			`<meta property="og:image:width" content="${SITE_CARD_WIDTH}" />`,
			`<meta property="og:image:height" content="${SITE_CARD_HEIGHT}" />`,
			`<meta property="og:image:alt" content="${escapeAttribute(SITE_CARD_ALT)}" />`,
		);
	}
	lines.push(
		`<meta name="twitter:card" content="summary_large_image" />`,
		`<meta name="twitter:title" content="${title}" />`,
		`<meta name="twitter:description" content="${description}" />`,
		`<meta name="twitter:image" content="${image}" />`,
		`<link rel="canonical" href="${url}" />`,
	);
	return lines.map((line) => `    ${line}`).join("\n");
}

/**
 * Replace the shell's neutral share region with one Work's, or leave the document alone.
 *
 * A null preview is the neutral answer (a rating above General, no title, or no card
 * found) and returning the document unchanged is what makes the site card the single
 * description of neutral. Missing markers are treated the same way rather than guessed
 * at: an injection that cannot find its region must not half-write one.
 */
export function injectShareHead(
	html: string,
	preview: LinkCard | null,
	canonicalUrl: string,
): string {
	if (!preview) return html;
	const begin = html.indexOf(SHARE_BEGIN);
	const end = html.indexOf(SHARE_END);
	if (begin === -1 || end === -1 || end < begin) return html;
	return (
		html.slice(0, begin) +
		SHARE_BEGIN +
		"\n" +
		renderShareHead(preview, canonicalUrl) +
		"\n" +
		html.slice(end)
	);
}

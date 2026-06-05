// SPDX-License-Identifier: AGPL-3.0-or-later
import sanitizeHtml from "sanitize-html";

/**
 * Sanitizes creator-authored post HTML before it is stored.
 *
 * bodyHtml arrives from the client as an opaque string and is later rendered
 * to other users via dangerouslySetInnerHTML, so this is the trust boundary.
 * The allowlist mirrors exactly what the web RichTextEditor (TipTap) can
 * produce: StarterKit (paragraphs, headings, marks, lists, blockquote, code
 * blocks, hr), the Image extension, and the Link extension. Everything else —
 * script/style/iframe tags, event-handler attributes, javascript:/data: URLs —
 * is stripped.
 */
const POST_HTML_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		"p",
		"br",
		"hr",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"strong",
		"b",
		"em",
		"i",
		"s",
		"u",
		"code",
		"pre",
		"blockquote",
		"ul",
		"ol",
		"li",
		"a",
		"img",
	],
	allowedAttributes: {
		a: ["href", "target", "rel"],
		img: ["src", "alt", "title", "width", "height"],
		ol: ["start"],
	},
	// class is governed here rather than via allowedAttributes (which would
	// allow arbitrary classes): the Link extension emits DaisyUI link classes,
	// TipTap code blocks emit language-* hints.
	allowedClasses: {
		a: ["link", "link-primary"],
		code: [/^language-[\w-]+$/],
	},
	allowedSchemes: ["http", "https", "mailto"],
	allowedSchemesAppliedToAttributes: ["href", "src"],
	allowProtocolRelative: false,
	// Links that open a new tab always get a hardened rel, whatever the
	// client claimed.
	transformTags: {
		a: (tagName, attribs) =>
			attribs.target === "_blank"
				? { tagName, attribs: { ...attribs, rel: "noopener noreferrer nofollow" } }
				: { tagName, attribs },
	},
	disallowedTagsMode: "discard",
};

export function sanitizePostHtml(html: string): string {
	if (!html) return html;
	return sanitizeHtml(html, POST_HTML_OPTIONS);
}

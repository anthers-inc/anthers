// SPDX-License-Identifier: Apache-2.0
import sanitizeHtml from "sanitize-html";

/**
 * Sanitizes creator-authored post HTML before it is stored.
 *
 * bodyHtml arrives from the client as an opaque string and is later rendered
 * to other users via dangerouslySetInnerHTML, so this is the trust boundary.
 * The allowlist mirrors exactly what the web RichTextEditor (TipTap) can
 * produce: StarterKit (paragraphs, headings, marks, lists, blockquote, code
 * blocks, hr), the Image extension, the Link extension, and the Spoiler mark
 * (`span.spoiler`, the one wrapper a stored body carries for hidden text).
 * Everything else — script/style/iframe tags, event-handler attributes,
 * javascript:/data: URLs — is stripped.
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
		// The same emphasis as `<s>`: CommonMark has one strikethrough delimiter (`~~`),
		// and every producer here emits `<del>` for it — marked does when markdown carrying
		// it is round-tripped in `normalizeStoredMarkdown`, and react-markdown's HTML
		// renderer does for a user's own prose copy. The sanitizer sits between them.
		"del",
		"u",
		"code",
		"pre",
		"blockquote",
		"ul",
		"ol",
		"li",
		"a",
		"img",
		"span",
	],
	allowedAttributes: {
		a: ["href", "target", "rel"],
		img: ["src", "alt", "title", "width", "height"],
		ol: ["start"],
	},
	// class is governed here rather than via allowedAttributes (which would
	// allow arbitrary classes): the Link extension emits DaisyUI link classes,
	// TipTap code blocks emit language-* hints, and the Spoiler mark emits
	// exactly `spoiler` — the name the renderer and turndown's rule look for.
	allowedClasses: {
		a: ["link", "link-primary"],
		code: [/^language-[\w-]+$/],
		span: ["spoiler"],
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

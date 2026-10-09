// SPDX-License-Identifier: Apache-2.0
/**
 * The post body's canonical form is markdown — `posts.body` stores it, and `org.anthers.post`
 * publishes it as `{ format: "markdown", value }` without further conversion.
 *
 * Creators author in TipTap, which produces HTML, so this module is the boundary where HTML
 * becomes markdown — and, in the reverse direction, where markdown a client sent directly is
 * normalized. Both directions run through the same sanitize-html allowlist (`sanitize.ts`),
 * which is the point: stored markdown is *defined* as what that allowlist permits, expressed
 * as markdown syntax, so a hostile `body` cannot carry anything `bodyHtml` could not have.
 *
 * The round trip in `normalizePostMarkdown` (markdown → HTML → sanitize → markdown) also
 * guarantees idempotence: normalizing already-normalized markdown is a no-op, so a client
 * that echoes a stored body back on an unrelated edit cannot corrupt it, and two saves of
 * the same content store two identical strings (which `changedPostFields` relies on to keep
 * no-op edits out of the edit history).
 */
import { marked } from "marked";
import TurndownService from "turndown";
import { gfm as turndownPluginGfm } from "turndown-plugin-gfm";
import { sanitizePostHtml } from "./sanitize.js";

// GFM tables and task lists are not in the editor's vocabulary, but they cost nothing to
// accept and the renderer (react-markdown + remark-gfm) already knows them. `breaks` must
// stay false: a single newline is a soft break in CommonMark, and treating it as `<br>`
// would make every wrapped source line a hard break.

const HTML_TO_MARKDOWN = new TurndownService({
	// The renderer's own conventions, so stored markdown reads the way it renders.
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
	hr: "---",
	/**
	 * A blank paragraph is a creator pressing return twice for space between paragraphs,
	 * so it must survive: markdown's own blank lines collapse to one paragraph break, and
	 * turndown's default drops the paragraph entirely, meaning the space a creator drew
	 * would be lost on storage and then again on every later normalization. The portable
	 * spelling of "an empty line" is a paragraph holding one non-breaking space — it
	 * renders as a full-height empty paragraph in remark's renderer and any other markdown
	 * reader, and the round trip is stable by itself: `isBlank` reads `^\s*$`, which the
	 * space satisfies, and CommonMark treats the character as text, so `marked` re-parses
	 * the stored line into the same empty `<p>` and this rule runs again. Leading and
	 * trailing blank paragraphs still fall to the final `trim()` in
	 * `normalizeStoredMarkdown`, which is the right place for them to go.
	 */
	blankReplacement: (_content, node) => {
		// turndown augments every node with its own `isBlock` at runtime. The two
		// newlines are the block separator itself and matter: turndown's `join`
		// trims newlines between consecutive blocks, so a bare `\u00A0` would let
		// two blank paragraphs merge into one line of two spaces — each return
		// has to carry its own line.
		const isBlock = (node as HTMLElement & { isBlock: boolean }).isBlock;
		return isBlock && node.nodeName === "P" ? "\u00A0\n\n" : "";
	},
});

// Turndown's default rule set is CommonMark only — GFM strikethrough (`<s>`, which the
// sanitizer's allowlist permits because TipTap's StarterKit emits it) is unknown to it and
// its text would come through de-formatted. `gfm` brings tables too, which the toolbar
// cannot produce: a GFM table pasted into a post survives as a table rather than
// flattening into a paragraph of pipes. The two rule groups that assume GitHub-render
// surroundings — task-list checkboxes and the code-highlight marker that would rewrite a
// fenced block's language hint into a `highlight-*` class — are removed before use. The
// cast is because `remove` types its argument over HTML tag names; these are rule names.
HTML_TO_MARKDOWN.use(turndownPluginGfm);
(HTML_TO_MARKDOWN.remove as unknown as (rules: string[]) => void)([
	"taskListItems",
	"highlightedCodeBlock",
]);

/** Over a `posts.body`'s length. Far under the Lexicon's own ceiling (1M), deliberately. */
export const POST_BODY_LIMIT = 100_000;

/**
 * HTML from the editor → the markdown that gets stored.
 *
 * The editor's `getHTML()` output is already sanitized vocabulary (the client cannot be
 * trusted, and `sanitizePostHtml` is the boundary that does not trust it), so this is
 * sanitize → convert, in that order.
 */
export function postHtmlToMarkdown(html: string): string {
	const md = HTML_TO_MARKDOWN.turndown(sanitizePostHtml(html));
	return normalizeStoredMarkdown(md);
}

/**
 * Markdown → what gets stored. This is the boundary for a client that sends `body` directly
 * as markdown, and the final step of `postHtmlToMarkdown`.
 *
 * The round trip through HTML and back is the mechanism: whatever the string contains must
 * survive `sanitizePostHtml` to survive here, and the sanitizer's discarded tags (script,
 * style, event handlers, javascript: URLs) never make it into the stored form — where a
 * regex over markdown text would have to guess at structure, the HTML parser settles it.
 * The escape sequence `\<` in prose goes in as a literal `<` and comes back out, so no
 * round trip needs it to mean anything else.
 */
export function normalizeStoredMarkdown(md: string): string {
	if (!md?.trim()) return "";
	const html = sanitizePostHtml(marked.parse(md, { async: false }));
	const back = HTML_TO_MARKDOWN.turndown(html);
	return back.trim();
}

/** Whether a stored markdown body has any content — the markdown shape of `isEmptyWriting`. */
export function isEmptyPostMarkdown(md: string | null | undefined): boolean {
	return !md?.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
}

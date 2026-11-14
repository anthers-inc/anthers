// SPDX-License-Identifier: Apache-2.0
/**
 * The readable body a document carries for a reader that runs no JavaScript.
 *
 * Every route answers with the application shell, whose body is an empty `#root` and a
 * bundle — so a reader that parses the response without executing the bundle (Defuddle,
 * Readability, a reader service, an archiver, an agent) is handed a page with no words in
 * it. The standing pages have their words already, in their components; this module turns
 * a rendered page into the block that carries them, and `build.ts` renders one per route.
 *
 * 🚨 **The block is a `<noscript>`, and that is what keeps the JavaScript path untouched.**
 * Content placed in `#root` would be replaced by the app on boot, and hydrating over it
 * would need the auth answer and the route's chunk before the first client render — the
 * app renders a spinner until `/api/auth/me` lands, and every route page is `React.lazy`.
 * A `<noscript>` is inert for every browser that runs the bundle, so there is no flash,
 * no hydration and no change to the boot path, and the cost is bytes on the wire alone.
 *
 * The markup is stripped rather than shipped whole. Classes, inline styles and inline SVG
 * are most of a rendered page's bytes and none of its meaning, and the interactive
 * controls on the calculator pages are dead without the bundle — a no-JavaScript reader
 * gets the prose, and the document's own base styling, rather than a page of dead widgets.
 */

/**
 * Elements removed with everything inside them.
 *
 * `button`, `select` and `textarea` are controls whose labels mean nothing without the
 * handler behind them; `script`, `style`, `template` and `noscript` cannot hold prose a
 * reader came for; `svg` is decoration, and a React icon carries its meaning in the
 * surrounding text.
 */
const DROPPED_WITH_CONTENT = [
	"script",
	"style",
	"template",
	"noscript",
	"button",
	"select",
	"textarea",
	"svg",
] as const;

/** Elements removed on sight: controls, resources and machine references, never prose. */
const DROPPED_VOID = ["input", "link", "meta", "source", "track", "wbr"] as const;

/**
 * Attributes that belong to the styled app and carry nothing a reader needs.
 *
 * `id` and `href` stay, so an in-page anchor in the FAQ or a legal document still works.
 * `aria-*` stays for the same reason: it is the one part of the app's markup that says
 * something about the reading order rather than the painting.
 */
const DROPPED_ATTRIBUTES =
	/\s(?:class|style|srcset|sizes|loading|decoding|fetchpriority|tabindex|draggable|contenteditable|data-[\w-]+)="[^"]*"/g;

/** The site's own links, so a person without JavaScript is not stranded on a bare page. */
const READER_NAV =
	'<nav><a href="/">Anthers</a> · <a href="/about">About</a> · <a href="/faq">FAQ</a> · <a href="/for-creators">For Creators</a> · <a href="/resources">Resources</a></nav>';

/** Remove every `<tag>…</tag>` pair, content included. */
function dropWithContent(html: string, tag: string): string {
	return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
}

/**
 * A rendered page reduced to what a reader needs.
 *
 * The order matters only in that controls go before the decoration inside them; the
 * replacements do not depend on each other otherwise.
 */
export function stripForReaders(html: string): string {
	let out = html.replace(/<!--[\s\S]*?-->/g, "");
	// An extractor treats `header` as site chrome and drops the page's own opening with it;
	// the hero heading and its lede are the first prose a reader came for, so they become an
	// ordinary block. The `<h1>` then leads the extracted document instead of being lost.
	out = out.replace(/<header\b/gi, "<div").replace(/<\/header>/gi, "</div>");
	for (const tag of DROPPED_WITH_CONTENT) out = dropWithContent(out, tag);
	for (const tag of DROPPED_VOID) out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
	return out.replace(DROPPED_ATTRIBUTES, "").trim();
}

/** The block a served document carries: site links outside the content root. */
export function noscriptBody(page: string): string {
	return `<noscript>${READER_NAV}<main>${page}</main></noscript>`;
}

/**
 * Put the body immediately before `</body>`.
 *
 * Missing the marker is a failure to inject, not a guess — the document is returned
 * exactly as it shipped, which is the shell a reader got before this existed. That is the
 * same fail-open rule `injectShareHead` follows, and for the same reason: a preview or a
 * reader body must never be able to take a page down.
 */
export function injectReaderBody(document: string, body: string): string {
	const at = document.lastIndexOf("</body>");
	if (at === -1) return document;
	return document.slice(0, at) + body + document.slice(at);
}

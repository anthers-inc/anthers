// SPDX-License-Identifier: Apache-2.0
/**
 * The markdown conversion boundary — the tests that keep stored post bodies what the
 * sanitizer's allowlist permits, expressed as markdown.
 *
 * The hostile cases here are the same ones `sanitize.test.ts` covers in HTML, replayed
 * through `normalizeStoredMarkdown`, because a client may send `body` directly as markdown
 * and bypass the editor's HTML entirely. A stored markdown body is *defined* as the HTML
 * round trip's output, so every case asserts the round trip refused it.
 */
import { describe, expect, it } from "bun:test";
import {
	isEmptyPostMarkdown,
	normalizeStoredMarkdown,
	postHtmlToMarkdown,
} from "../services/post-markdown";

describe("postHtmlToMarkdown", () => {
	it("converts the editor's whole vocabulary", () => {
		const md = postHtmlToMarkdown(
			"<h2>Title</h2><p>Hello <strong>world</strong> <em>em</em> <s>gone</s> <code>x</code></p>" +
				"<ul><li>a</li><li>b</li></ul><ol><li>one</li></ol>" +
				"<blockquote><p>quote</p></blockquote><hr>" +
				'<pre><code class="language-ts">let x = 1;</code></pre>' +
				'<p><a href="https://e.example" class="link link-primary" target="_blank">a link</a></p>' +
				'<p><img src="https://i.example/pic.png" alt="pic" width="10" height="10"></p>',
		);
		expect(md).toBe(
			"## Title\n\nHello **world** _em_ ~gone~ `x`\n\n" +
				"-   a\n-   b\n\n" +
				"1.  one\n\n" +
				"> quote\n\n" +
				"---\n\n" +
				"```ts\nlet x = 1;\n```\n\n" +
				"[a link](https://e.example)\n\n" +
				"![pic](https://i.example/pic.png)",
		);
	});

	it("keeps the escape sequence a literal angle bracket in prose", () => {
		expect(postHtmlToMarkdown("<p>1 &lt; 2 &amp; more</p>")).toBe("1 < 2 & more");
	});

	it("drops a tag the allowlist keeps but markdown cannot express", () => {
		expect(postHtmlToMarkdown("<p><u>under</u>lined</p>")).toBe("underlined");
	});
});

describe("blank paragraphs", () => {
	it("preserves a blank paragraph — the double return the editor produces", () => {
		expect(postHtmlToMarkdown("<p>First</p><p></p><p>Second</p>")).toBe(
			"First\n\n\u00A0\n\nSecond",
		);
	});

	it("is stable over every later normalization of the stored spelling", () => {
		const md = postHtmlToMarkdown("<p>First</p><p></p><p></p><p>Second</p>");
		expect(normalizeStoredMarkdown(md)).toBe(md);
	});

	it("consecutive blank paragraphs each keep their own line", () => {
		const md = postHtmlToMarkdown("<p>First</p><p></p><p></p><p>Second</p>");
		expect(md).toBe("First\n\n\u00A0\n\n\u00A0\n\nSecond");
	});

	it("drops blank paragraphs at the edges of the body", () => {
		expect(postHtmlToMarkdown("<p></p><p>Hello</p><p></p>")).toBe("Hello");
		expect(normalizeStoredMarkdown("\u00A0\n\nHello")).toBe("Hello");
	});
});

describe("normalizeStoredMarkdown", () => {
	it("normalizes a hostile markdown body through the same allowlist", () => {
		const hostile =
			"para\n\n<script>alert(1)</script>\n\n![x](javascript:alert(1))\n\n[bad](javascript:alert(1))" +
			' <u>u</u> <iframe src="https://evil.example"></iframe> text';
		const out = normalizeStoredMarkdown(hostile);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("javascript:");
		expect(out).not.toContain("<u>");
		expect(out).not.toContain("iframe");
		expect(out).toContain("para");
		expect(out).toContain("bad");
		expect(out).toContain("text");
	});

	it("is idempotent — an echoed stored body comes back unchanged", () => {
		const first = postHtmlToMarkdown(
			'<h2>Devlog</h2><p>Shipped <strong>the thing</strong>.</p><ul><li>one</li></ul><p><a href="https://e.example">link</a></p>',
		);
		expect(normalizeStoredMarkdown(first)).toBe(first);
	});

	it("strips raw HTML a client embedded in a stored body", () => {
		const out = normalizeStoredMarkdown("Hello world!\n\n<img src onerror=y>");
		expect(out).not.toContain("<b");
		expect(out).not.toContain("<img");
		expect(out).toContain("Hello world!");
	});

	it("returns empty for empty input", () => {
		expect(normalizeStoredMarkdown("")).toBe("");
		expect(normalizeStoredMarkdown("   \n  ")).toBe("");
	});
});

describe("isEmptyPostMarkdown", () => {
	it("says false once there is prose", () => {
		expect(isEmptyPostMarkdown(null)).toBe(true);
		expect(isEmptyPostMarkdown("")).toBe(true);
		expect(isEmptyPostMarkdown("   ")).toBe(true);
		expect(isEmptyPostMarkdown("words")).toBe(false);
	});

	it("says true for a body that is only an image", () => {
		expect(isEmptyPostMarkdown("![the screen](https://i.example/pic.png)")).toBe(true);
		expect(isEmptyPostMarkdown("![the screen](https://i.example/pic.png)\n\nand words")).toBe(
			false,
		);
	});
});

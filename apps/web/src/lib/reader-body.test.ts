// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { injectReaderBody, noscriptBody, stripForReaders } from "./reader-body";

describe("stripForReaders", () => {
	it("keeps the prose, the links and the attributes that make a page navigable", () => {
		const out = stripForReaders(
			'<div class="a" id="start"><p>Hello <a href="/about">About</a></p><img src="/x.png" alt="A bee" class="b" /></div>',
		);
		expect(out).toContain("Hello");
		expect(out).toContain('href="/about"');
		expect(out).toContain('id="start"');
		expect(out).toContain('alt="A bee"');
	});

	it("drops what only the styled app needs", () => {
		const out = stripForReaders(
			'<div class="a" style="color:red" data-x="1"><p class="b">Words</p></div>',
		);
		expect(out).toBe("<div><p>Words</p></div>");
	});

	it("drops a control whole rather than leaving its label behind", () => {
		const out = stripForReaders(
			'<p>Before</p><button type="button">Subscribe</button><p>After</p>',
		);
		expect(out).toBe("<p>Before</p><p>After</p>");
	});

	it("drops decoration and machinery, content included", () => {
		const out = stripForReaders(
			'<svg viewBox="0 0 1 1"><path d="M0 0" /></svg><script>alert(1)</script><style>.a{}</style><p>Kept</p>',
		);
		expect(out).toBe("<p>Kept</p>");
	});

	it("keeps the page's own header, which an extractor treats as chrome", () => {
		expect(stripForReaders('<header class="hero"><h1>A page</h1><p>A lede</p></header>')).toBe(
			"<div><h1>A page</h1><p>A lede</p></div>",
		);
	});

	it("leaves no comment or machine-only element in the body", () => {
		const out = stripForReaders('<p>A</p><!-- note --><input type="number" value="1" /><p>B</p>');
		expect(out).toBe("<p>A</p><p>B</p>");
	});
});

describe("noscriptBody", () => {
	it("keeps the site links outside the content root", () => {
		const body = noscriptBody("<h1>About</h1>");
		expect(body.startsWith("<noscript><nav>")).toBe(true);
		expect(body).toContain('href="/about"');
		expect(body).toContain("</nav><main><h1>About</h1></main></noscript>");
	});
});

describe("injectReaderBody", () => {
	it("puts the body immediately before the document's close", () => {
		expect(
			injectReaderBody('<html><body><div id="root"></div></body></html>', "<noscript>x</noscript>"),
		).toBe('<html><body><div id="root"></div><noscript>x</noscript></body></html>');
	});

	it("returns the document unchanged when it cannot find the close", () => {
		const shell = '<html><body><div id="root"></div>';
		expect(injectReaderBody(shell, "<noscript>x</noscript>")).toBe(shell);
	});
});

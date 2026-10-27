// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	injectShareHead,
	renderShareHead,
	SHARE_BEGIN,
	SHARE_END,
	SITE_CARD_URL,
} from "./share-head.js";

const SHELL = readFileSync(resolve(import.meta.dir, "../../index.html"), "utf8");

const preview = {
	title: "A Quiet Year",
	description: "A short game about a garden that keeps growing.",
	image: "https://cdn.anthers.org/creators/7/thumb.png",
};

describe("the shell's injectable region", () => {
	it("carries both markers, one each", () => {
		expect(SHELL.split(SHARE_BEGIN)).toHaveLength(2);
		expect(SHELL.split(SHARE_END)).toHaveLength(2);
		expect(SHELL.indexOf(SHARE_BEGIN)).toBeLessThan(SHELL.indexOf(SHARE_END));
	});

	it("keeps the site card address the renderer repeats", () => {
		expect(SHELL).toContain(`content="${SITE_CARD_URL}"`);
	});
});

describe("renderShareHead", () => {
	it("names the Work in the tab, the card and the canonical address", () => {
		const html = renderShareHead(preview, "https://anthers.org/works/a-quiet-year-12");
		expect(html).toContain("<title>A Quiet Year — Anthers</title>");
		expect(html).toContain('<meta property="og:title" content="A Quiet Year" />');
		expect(html).toContain(
			'<meta property="og:url" content="https://anthers.org/works/a-quiet-year-12" />',
		);
		expect(html).toContain(
			'<link rel="canonical" href="https://anthers.org/works/a-quiet-year-12" />',
		);
		expect(html).toContain(
			'<meta property="og:image" content="https://cdn.anthers.org/creators/7/thumb.png" />',
		);
		expect(html).toContain('<meta name="twitter:title" content="A Quiet Year" />');
	});

	it("drops the card's dimensions for a creator's thumbnail", () => {
		const html = renderShareHead(preview, "https://anthers.org/works/a-quiet-year-12");
		expect(html).not.toContain("og:image:width");
		expect(html).not.toContain("og:image:height");
		expect(html).toContain('content="The thumbnail for A Quiet Year."');
	});

	it("takes the image's own description where the read supplies one", () => {
		const html = renderShareHead(
			{ ...preview, imageAlt: "The profile card for A Quiet Year on Anthers." },
			"https://anthers.org/@a-quiet-year",
		);
		expect(html).toContain('content="The profile card for A Quiet Year on Anthers."');
		expect(html).not.toContain("The thumbnail for");
	});

	it("serves the site card, with its dimensions, when the Work has no thumbnail", () => {
		const html = renderShareHead({ ...preview, image: null }, "https://anthers.org/works/x-1");
		expect(html).toContain(`<meta property="og:image" content="${SITE_CARD_URL}" />`);
		expect(html).toContain('<meta property="og:image:width" content="1200" />');
		expect(html).toContain('<meta property="og:image:height" content="630" />');
	});

	it("cannot be made to close its own attribute from creator-authored text", () => {
		const html = renderShareHead(
			{
				title: 'He said "hello" & <goodbye>',
				description: 'A "blurb" & more',
				image: "https://cdn.anthers.org/a.png?x=1&y=2",
			},
			"https://anthers.org/works/x-1",
		);
		expect(html).toContain('content="He said &quot;hello&quot; &amp; &lt;goodbye&gt;"');
		expect(html).toContain('<title>He said "hello" &amp; &lt;goodbye&gt; — Anthers</title>');
		expect(html).toContain('content="https://cdn.anthers.org/a.png?x=1&amp;y=2"');
	});
});

describe("injectShareHead", () => {
	it("replaces the neutral region and keeps the markers for the next request", () => {
		const html = injectShareHead(SHELL, preview, "https://anthers.org/works/a-quiet-year-12");
		expect(html).toContain(SHARE_BEGIN);
		expect(html).toContain(SHARE_END);
		expect(html).toContain("A Quiet Year — Anthers");
		expect(html).not.toContain('<meta property="og:title" content="Anthers" />');
	});

	it("leaves the document alone when there is no preview", () => {
		expect(injectShareHead(SHELL, null, "https://anthers.org/works/x-1")).toBe(SHELL);
	});

	it("refuses to guess when the markers are missing", () => {
		const withoutMarkers = SHELL.replace(SHARE_BEGIN, "").replace(SHARE_END, "");
		expect(injectShareHead(withoutMarkers, preview, "https://anthers.org/works/x-1")).toBe(
			withoutMarkers,
		);
	});
});

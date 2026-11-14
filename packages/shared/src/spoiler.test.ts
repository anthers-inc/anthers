// SPDX-License-Identifier: Apache-2.0
/**
 * The spoiler convention in both of its forms: the plain-text scanner comments use, and the
 * marked extension posts pass through at the write boundary and when the editor loads.
 */
import { describe, expect, it } from "bun:test";
import { Marked } from "marked";
import { splitSpoilers, spoilerMarkedExtension } from "./spoiler";

const markdown = new Marked();
markdown.use(spoilerMarkedExtension);

describe("splitSpoilers", () => {
	it("splits a body around its spoilers", () => {
		expect(splitSpoilers("before ||hidden|| after")).toEqual([
			{ kind: "text", value: "before " },
			{ kind: "spoiler", value: "hidden" },
			{ kind: "text", value: " after" },
		]);
	});

	it("pairs several spoilers left to right", () => {
		expect(splitSpoilers("a ||one|| b ||two|| c")).toEqual([
			{ kind: "text", value: "a " },
			{ kind: "spoiler", value: "one" },
			{ kind: "text", value: " b " },
			{ kind: "spoiler", value: "two" },
			{ kind: "text", value: " c" },
		]);
	});

	it("finds a spoiler that starts mid-word", () => {
		expect(splitSpoilers("hello||secret||world")).toEqual([
			{ kind: "text", value: "hello" },
			{ kind: "spoiler", value: "secret" },
			{ kind: "text", value: "world" },
		]);
	});

	it("leaves an unpaired delimiter as the text somebody typed", () => {
		expect(splitSpoilers("a || b")).toEqual([{ kind: "text", value: "a || b" }]);
		expect(splitSpoilers("||a")).toEqual([{ kind: "text", value: "||a" }]);
	});

	it("leaves empty delimiters as typed", () => {
		expect(splitSpoilers("||||")).toEqual([{ kind: "text", value: "||||" }]);
	});

	it("keeps a spoiler's returns inside it", () => {
		expect(splitSpoilers("a ||one\ntwo|| b")).toEqual([
			{ kind: "text", value: "a " },
			{ kind: "spoiler", value: "one\ntwo" },
			{ kind: "text", value: " b" },
		]);
	});
});

describe("spoilerMarkedExtension", () => {
	it("renders the delimiter pair as the spoiler span", () => {
		expect(String(markdown.parse("hello ||secret|| world"))).toBe(
			'<p>hello <span class="spoiler">secret</span> world</p>\n',
		);
	});

	it("finds a spoiler that starts mid-word", () => {
		expect(String(markdown.parse("hello||secret||world"))).toBe(
			'<p>hello<span class="spoiler">secret</span>world</p>\n',
		);
	});

	it("keeps inline markdown inside the spoiler", () => {
		expect(String(markdown.parse("||a **b** and [c](https://e.example)||"))).toBe(
			'<p><span class="spoiler">a <strong>b</strong> and <a href="https://e.example">c</a></span></p>\n',
		);
	});

	it("leaves the pipes of a code span alone", () => {
		expect(String(markdown.parse("`||secret||`"))).toBe("<p><code>||secret||</code></p>\n");
	});

	it("leaves an unpaired delimiter literal", () => {
		expect(String(markdown.parse("a || b"))).toBe("<p>a || b</p>\n");
	});

	it("takes a markdown escape as the literal pipes it spells", () => {
		expect(String(markdown.parse("\\|\\|secret\\|\\|"))).toBe("<p>||secret||</p>\n");
	});
});

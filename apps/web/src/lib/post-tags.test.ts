// SPDX-License-Identifier: Apache-2.0
/**
 * Tags derive from the body's own text, and a spoiler's text is withheld from readers — so a
 * `#hashtag` typed inside one must not become a public tag.
 */
import { describe, expect, it } from "bun:test";
import { tagsFromBodyHtml } from "@anthers/web-shared/post-tags";
import { Window } from "happy-dom";

// A detached window rather than a registered global one: the parse needs a document, and a
// global DOM in this process would put libraries that sniff for a browser into browser mode.
const document = new Window().document as unknown as Document;

describe("tagsFromBodyHtml", () => {
	it("reads hashtags from the body's text", () => {
		expect(tagsFromBodyHtml("<p>#one and #two</p>", document)).toEqual(["one", "two"]);
	});

	it("does not mint a tag from inside a spoiler", () => {
		expect(
			tagsFromBodyHtml('<p>visible #one <span class="spoiler">#secret</span></p>', document),
		).toEqual(["one"]);
	});
});

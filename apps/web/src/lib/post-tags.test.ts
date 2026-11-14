// SPDX-License-Identifier: Apache-2.0
/**
 * Tags derive from the body's own text, and a spoiler's text is withheld from readers — so a
 * `#hashtag` typed inside one must not become a public tag.
 */
import { describe, expect, it } from "bun:test";
import { tagsFromBodyHtml } from "@anthers/web-shared/post-tags";
import { render } from "../components/payments/render-hooks";

// The parse reads through a DOM; the shared test helper registers it and restores Bun's own
// globals around it.
render(null).unmount();

describe("tagsFromBodyHtml", () => {
	it("reads hashtags from the body's text", () => {
		expect(tagsFromBodyHtml("<p>#one and #two</p>")).toEqual(["one", "two"]);
	});

	it("does not mint a tag from inside a spoiler", () => {
		expect(tagsFromBodyHtml('<p>visible #one <span class="spoiler">#secret</span></p>')).toEqual([
			"one",
		]);
	});
});

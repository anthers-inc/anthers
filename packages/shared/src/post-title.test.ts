// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import {
	hasWorkMention,
	mentionedWorkPublicIds,
	postTitleSegments,
	resolvedPostTitle,
	visiblePostTitle,
	workMentionMarkdown,
} from "./post-title";

const CURTAINS = { title: "Curtains", slug: "curtains", publicId: 534_000_269 };

describe("postTitleSegments", () => {
	it("reads a mention out of a title and keeps the text around it", () => {
		expect(postTitleSegments(`[@Curtains](/works/curtains-534000269) Discussion`)).toEqual([
			{ kind: "mention", text: "@Curtains", publicId: 534_000_269 },
			{ kind: "text", text: " Discussion" },
		]);
	});

	it("keeps a plain title as one text segment", () => {
		expect(postTitleSegments("A plain title")).toEqual([{ kind: "text", text: "A plain title" }]);
	});

	it("accepts an absolute Anthers link and leaves another host's path alone", () => {
		expect(postTitleSegments("[@Curtains](https://anthers.org/works/curtains-534000269)")).toEqual([
			{ kind: "mention", text: "@Curtains", publicId: 534_000_269 },
		]);
		expect(postTitleSegments("[@Curtains](https://example.com/works/curtains-534000269)")).toEqual([
			{ kind: "text", text: "[@Curtains](https://example.com/works/curtains-534000269)" },
		]);
	});

	it("does not treat a plain Work link, or a below-range id, as a mention", () => {
		expect(postTitleSegments("[Curtains](/works/curtains-534000269)")).toHaveLength(1);
		expect(postTitleSegments("[@Curtains](/works/curtains-1234)")).toEqual([
			{ kind: "text", text: "[@Curtains](/works/curtains-1234)" },
		]);
	});
});

describe("visiblePostTitle", () => {
	it("drops the destination and keeps the @ name, so a slug never carries the id", () => {
		const title = "[@Curtains](/works/curtains-534000269) Discussion (Spoilers)";
		expect(visiblePostTitle(title)).toBe("@Curtains Discussion (Spoilers)");
	});
});

describe("mentionedWorkPublicIds", () => {
	it("lists each mentioned Work once, in first-appearance order", () => {
		const a = workMentionMarkdown(CURTAINS);
		const b = workMentionMarkdown({ title: "Hollow", slug: "hollow", publicId: 534_000_270 });
		expect(mentionedWorkPublicIds(`${a} and ${b}, again ${a}`)).toEqual([534_000_269, 534_000_270]);
		expect(mentionedWorkPublicIds("nothing here")).toEqual([]);
	});
});

describe("workMentionMarkdown", () => {
	it("writes the canonical mention the parser reads back", () => {
		const token = workMentionMarkdown(CURTAINS);
		expect(token).toBe("[@Curtains](/works/curtains-534000269)");
		expect(postTitleSegments(token)).toEqual([
			{ kind: "mention", text: "@Curtains", publicId: 534_000_269 },
		]);
	});

	it("keeps a bracketed title from breaking the link and falls back for an empty one", () => {
		expect(workMentionMarkdown({ title: "Act [I]", slug: "act-i", publicId: 534_000_269 })).toBe(
			"[@Act (I)](/works/act-i-534000269)",
		);
		expect(workMentionMarkdown({ title: " ", slug: "untitled", publicId: 534_000_269 })).toBe(
			"[@Untitled](/works/untitled-534000269)",
		);
	});
});

describe("resolvedPostTitle", () => {
	it("shows the Work's current name, not the name stored at write time", () => {
		const title = "[@Curtains](/works/curtains-534000269) Discussion";
		expect(
			resolvedPostTitle(title, (id) => (id === 534_000_269 ? "Curtains (Director's Cut)" : null)),
		).toBe("@Curtains (Director's Cut) Discussion");
	});

	it("falls back to the stored text when the Work no longer resolves", () => {
		const title = "[@Curtains](/works/curtains-534000269) Discussion";
		expect(resolvedPostTitle(title, () => null)).toBe("@Curtains Discussion");
	});
});

describe("hasWorkMention", () => {
	it("answers false for a plain title and for a plain Work link", () => {
		expect(hasWorkMention("Discussion")).toBe(false);
		expect(hasWorkMention("[Curtains](/works/curtains-534000269)")).toBe(false);
		expect(hasWorkMention(workMentionMarkdown(CURTAINS))).toBe(true);
	});
});

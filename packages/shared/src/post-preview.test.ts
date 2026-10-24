// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import {
	POST_PREVIEW_FALLBACK_DESCRIPTION,
	POST_PREVIEW_FALLBACK_TITLE,
	postPreviewFor,
} from "./post-preview.js";

const post = (overrides: Partial<Parameters<typeof postPreviewFor>[0]> = {}) => ({
	displayTitle: "Hello, there",
	excerpt: "A short note about the garden, and what it grew into.",
	image: "https://cdn.anthers.org/creators/7/post.png",
	...overrides,
});

describe("postPreviewFor", () => {
	it("serves the post's own title, words and image", () => {
		expect(postPreviewFor(post())).toEqual({
			title: "Hello, there",
			description: "A short note about the garden, and what it grew into.",
			image: "https://cdn.anthers.org/creators/7/post.png",
		});
	});

	it("names a title-less post the way its own page does", () => {
		expect(postPreviewFor(post({ displayTitle: null })).title).toBe(POST_PREVIEW_FALLBACK_TITLE);
		expect(postPreviewFor(post({ displayTitle: "   " })).title).toBe(POST_PREVIEW_FALLBACK_TITLE);
	});

	it("falls back to the platform sentence when the post has no words", () => {
		expect(postPreviewFor(post({ excerpt: null })).description).toBe(
			POST_PREVIEW_FALLBACK_DESCRIPTION,
		);
		expect(postPreviewFor(post({ excerpt: "  " })).description).toBe(
			POST_PREVIEW_FALLBACK_DESCRIPTION,
		);
	});

	it("leaves a missing image to the caller, so the site card fills in", () => {
		expect(postPreviewFor(post({ image: null })).image).toBeNull();
	});
});

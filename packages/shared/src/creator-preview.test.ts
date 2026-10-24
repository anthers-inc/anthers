// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { CREATOR_PREVIEW_FALLBACK_DESCRIPTION, creatorPreviewFor } from "./creator-preview.js";

const creator = (overrides: Partial<Parameters<typeof creatorPreviewFor>[0]> = {}) => ({
	displayName: "Parker Davis",
	handle: "parkerhdavis.com",
	bio: "Composing, drawing and building a garden.",
	image: "https://cdn.anthers.org/creators/38/avatars/portrait.webp",
	...overrides,
});

describe("creatorPreviewFor", () => {
	it("names the creator, in their own words, with their portrait", () => {
		expect(creatorPreviewFor(creator())).toEqual({
			title: "Parker Davis",
			description: "Composing, drawing and building a garden.",
			image: "https://cdn.anthers.org/creators/38/avatars/portrait.webp",
		});
	});

	it("falls back to the handle, which every account has", () => {
		expect(creatorPreviewFor(creator({ displayName: null })).title).toBe("@parkerhdavis.com");
		expect(creatorPreviewFor(creator({ displayName: "   " })).title).toBe("@parkerhdavis.com");
	});

	it("falls back to the platform sentence when the creator wrote no bio", () => {
		expect(creatorPreviewFor(creator({ bio: null })).description).toBe(
			CREATOR_PREVIEW_FALLBACK_DESCRIPTION,
		);
		expect(creatorPreviewFor(creator({ bio: "  " })).description).toBe(
			CREATOR_PREVIEW_FALLBACK_DESCRIPTION,
		);
	});

	it("leaves a missing portrait to the caller, so the site card fills in", () => {
		expect(creatorPreviewFor(creator({ image: null })).image).toBeNull();
	});
});

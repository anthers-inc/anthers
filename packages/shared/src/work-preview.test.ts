// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import {
	servesOwnPreview,
	WORK_PREVIEW_FALLBACK_DESCRIPTION,
	workPreviewFor,
} from "./work-preview.js";

const work = (overrides: Partial<Parameters<typeof workPreviewFor>[0]> = {}) => ({
	title: "A Quiet Year",
	description: "A short game about a garden that keeps growing.",
	thumbnail: "https://cdn.anthers.org/creators/7/thumb.png",
	maturity: "general",
	...overrides,
});

describe("workPreviewFor", () => {
	it("serves a General Work's own title, blurb and thumbnail", () => {
		expect(workPreviewFor(work())).toEqual({
			title: "A Quiet Year",
			description: "A short game about a garden that keeps growing.",
			image: "https://cdn.anthers.org/creators/7/thumb.png",
		});
	});

	it("serves the site card for every rating above General", () => {
		expect(workPreviewFor(work({ maturity: "mature" }))).toBeNull();
		expect(workPreviewFor(work({ maturity: "adult" }))).toBeNull();
	});

	it("fails closed on unrated and on a rating this build has never heard of", () => {
		expect(workPreviewFor(work({ maturity: "unrated" }))).toBeNull();
		expect(workPreviewFor(work({ maturity: null }))).toBeNull();
		expect(workPreviewFor(work({ maturity: "restricted" }))).toBeNull();
	});

	it("falls back to the platform sentence when the creator wrote no blurb", () => {
		expect(workPreviewFor(work({ description: null }))?.description).toBe(
			WORK_PREVIEW_FALLBACK_DESCRIPTION,
		);
		expect(workPreviewFor(work({ description: "   " }))?.description).toBe(
			WORK_PREVIEW_FALLBACK_DESCRIPTION,
		);
	});

	it("serves no preview rather than a card with an empty heading", () => {
		expect(workPreviewFor(work({ title: "   " }))).toBeNull();
	});

	it("leaves a missing thumbnail to the caller, so the site card fills in", () => {
		expect(workPreviewFor(work({ thumbnail: null }))?.image).toBeNull();
	});
});

describe("servesOwnPreview", () => {
	it("is the one gate both the card endpoint and the renderer read", () => {
		expect(servesOwnPreview("general")).toBe(true);
		for (const value of ["mature", "adult", "unrated", "", null, undefined]) {
			expect(servesOwnPreview(value)).toBe(false);
		}
	});
});

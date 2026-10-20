// SPDX-License-Identifier: Apache-2.0
/**
 * The preview-media scope — which kinds a locked page may carry a storefront carousel
 * for, and the cap on the set.
 *
 * The predicate is the only place the list lives, so the test names both the membership
 * and the deliberate absences: a kind joining later is a one-line change here, and a kind
 * that quietly joins by accident is the drift this pins.
 */

import { describe, expect, it } from "bun:test";
import { MAX_PREVIEW_MEDIA, PREVIEW_MEDIA_WORK_TYPES, supportsPreviewMedia } from "./content";

describe("supportsPreviewMedia", () => {
	it("covers the two storefront kinds", () => {
		expect(PREVIEW_MEDIA_WORK_TYPES).toEqual(["video", "game"]);
		expect(supportsPreviewMedia("video")).toBe(true);
		expect(supportsPreviewMedia("game")).toBe(true);
	});

	it("leaves every other kind out — the absence is the correct rendering", () => {
		for (const type of [
			"text",
			"music",
			"audio",
			"image",
			"comic",
			"ebook",
			"software",
			"physical",
			"service",
		]) {
			expect(supportsPreviewMedia(type), type).toBe(false);
		}
	});

	it("is a sensible first cap, images and trailers together", () => {
		expect(MAX_PREVIEW_MEDIA).toBe(12);
	});
});

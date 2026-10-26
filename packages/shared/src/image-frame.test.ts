// SPDX-License-Identifier: Apache-2.0
/**
 * The framing geometry both ends of the app share: the cover window, the clamped view and the
 * pixels the server cuts.
 *
 * ⭐ **The assertions are about staying inside the image, because that is the failure this math
 * can have.** A crop that runs a pixel past the source fails sharp's extract; one that leaves a
 * gap at a zoomed edge draws the stage background through the picture; one that loses the
 * surface's aspect puts the stored image back where the feature started.
 */

import { describe, expect, it } from "bun:test";
import {
	baseWindow,
	cropToPixels,
	frameAspect,
	frameCrop,
	IMAGE_FRAME_SPECS,
	isImageFrameType,
	normalizeCrop,
} from "./image-frame";

describe("the frame specs", () => {
	it("names every framed surface with a positive size, and nothing else", () => {
		for (const spec of Object.values(IMAGE_FRAME_SPECS)) {
			expect(spec.width).toBeGreaterThan(0);
			expect(spec.height).toBeGreaterThan(0);
		}
		expect(isImageFrameType("thumbnail")).toBe(true);
		expect(isImageFrameType("avatar")).toBe(true);
		expect(isImageFrameType("gallery")).toBe(false);
		expect(isImageFrameType("")).toBe(false);
		expect(isImageFrameType(null)).toBe(false);
	});

	it("derives each aspect from the pixel size it describes", () => {
		expect(frameAspect("thumbnail")).toBeCloseTo(16 / 9);
		expect(frameAspect("banner")).toBe(3);
		expect(frameAspect("avatar")).toBe(1);
	});
});

describe("baseWindow", () => {
	it("keeps the full height of a wide source, trimming its sides", () => {
		expect(baseWindow(1600, 900, 1)).toEqual({ width: 900 / 1600, height: 1 });
	});

	it("keeps the full width of a tall source, trimming its ends", () => {
		expect(baseWindow(900, 1600, 1)).toEqual({ width: 1, height: 900 / 1600 });
	});

	it("is the whole image when the aspects already match", () => {
		const window = baseWindow(1200, 675, 16 / 9);
		expect(window.width).toBeCloseTo(1);
		expect(window.height).toBeCloseTo(1);
	});
});

describe("frameCrop", () => {
	const source = { imageWidth: 2000, imageHeight: 1000 };

	it("honors the surface's aspect in source pixels", () => {
		const crop = frameCrop({ ...source, aspect: 1, center: { x: 0.5, y: 0.5 }, zoom: 1 });
		expect((crop.width * source.imageWidth) / (crop.height * source.imageHeight)).toBeCloseTo(1);
	});

	it("halves the window at 2× zoom", () => {
		const one = frameCrop({ ...source, aspect: 16 / 9, center: { x: 0.5, y: 0.5 }, zoom: 1 });
		const two = frameCrop({ ...source, aspect: 16 / 9, center: { x: 0.5, y: 0.5 }, zoom: 2 });
		expect(two.width).toBeCloseTo(one.width / 2);
		expect(two.height).toBeCloseTo(one.height / 2);
	});

	it("clamps a center that would leave the image, rather than showing a gap", () => {
		const crop = frameCrop({
			...source,
			aspect: 16 / 9,
			center: { x: 5, y: -3 },
			zoom: 2,
		});
		expect(crop.x).toBeGreaterThanOrEqual(0);
		expect(crop.y).toBeGreaterThanOrEqual(0);
		expect(crop.x + crop.width).toBeLessThanOrEqual(1);
		expect(crop.y + crop.height).toBeLessThanOrEqual(1);
	});

	it("never allows a zoom below the cover crop", () => {
		const cover = frameCrop({ ...source, aspect: 1, center: { x: 0.5, y: 0.5 }, zoom: 1 });
		const out = frameCrop({ ...source, aspect: 1, center: { x: 0.5, y: 0.5 }, zoom: 0 });
		expect(out.width).toBeCloseTo(cover.width);
	});
});

describe("cropToPixels", () => {
	it("rounds outward and reaches the whole image", () => {
		expect(cropToPixels(1000, 500, { x: 0, y: 0, width: 1, height: 1 })).toEqual({
			left: 0,
			top: 0,
			width: 1000,
			height: 500,
		});
	});

	it("keeps a fractional window inside the source", () => {
		const region = cropToPixels(1001, 499, { x: 0.333, y: 0.111, width: 0.667, height: 0.889 });
		expect(region.left).toBeGreaterThanOrEqual(0);
		expect(region.top).toBeGreaterThanOrEqual(0);
		expect(region.left + region.width).toBeLessThanOrEqual(1001);
		expect(region.top + region.height).toBeLessThanOrEqual(499);
		expect(region.width).toBeGreaterThan(0);
		expect(region.height).toBeGreaterThan(0);
	});
});

describe("normalizeCrop", () => {
	const valid = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };

	it("accepts a window inside the image", () => {
		expect(normalizeCrop(valid)).toEqual(valid);
	});

	it("refuses a window that leaves the image or has no size", () => {
		expect(normalizeCrop({ ...valid, x: 0.6 })).toBeNull();
		expect(normalizeCrop({ ...valid, width: 0 })).toBeNull();
		expect(normalizeCrop({ ...valid, height: -0.1 })).toBeNull();
		expect(normalizeCrop({ ...valid, y: -0.01 })).toBeNull();
	});

	it("refuses anything that is not four finite numbers", () => {
		expect(normalizeCrop(null)).toBeNull();
		expect(normalizeCrop("1,2,3,4")).toBeNull();
		expect(normalizeCrop({ ...valid, width: Number.NaN })).toBeNull();
		expect(normalizeCrop({ ...valid, width: "0.5" })).toBeNull();
	});
});

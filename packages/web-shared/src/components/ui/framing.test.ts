// SPDX-License-Identifier: Apache-2.0
/**
 * The dialog's view state: the window a view shows, the drag that moves it, the zoom that
 * anchors under the pointer, and the box the stage draws.
 *
 * These are the behaviors a creator feels directly — a drag that runs ahead of the pointer, a
 * zoom that drifts toward a corner, or a gap at an edge — so they are tested at the arithmetic
 * rather than left to the browser.
 */

import { describe, expect, it } from "bun:test";
import {
	imageBox,
	initialView,
	MAX_FRAME_ZOOM,
	panView,
	viewCrop,
	viewFromCrop,
	viewWindow,
	zoomView,
} from "./framing";

const source = { imageWidth: 1600, imageHeight: 900 };
const aspect = 16 / 9;

describe("initialView", () => {
	it("starts centered at no extra zoom", () => {
		expect(initialView()).toEqual({ center: { x: 0.5, y: 0.5 }, zoom: 1 });
	});
});

describe("viewWindow", () => {
	it("is the whole image when the aspects match", () => {
		const window = viewWindow(1600, 900, aspect, initialView());
		expect(window.width).toBeCloseTo(1);
		expect(window.height).toBeCloseTo(1);
	});

	it("trims a square source to the middle band for a 16:9 surface", () => {
		const window = viewWindow(1000, 1000, aspect, initialView());
		expect(window.width).toBeCloseTo(1);
		expect(window.height).toBeCloseTo(9 / 16);
	});
});

describe("panView", () => {
	it("moves the window opposite the pointer, so the picture follows the drag", () => {
		const before = viewWindow(1000, 1000, aspect, initialView());
		// A square source has vertical slack at 16:9; drag upward and the window should move down.
		const after = panView({
			...source,
			imageWidth: 1000,
			imageHeight: 1000,
			aspect,
			view: initialView(),
			deltaX: 0,
			deltaY: -200,
			stageWidth: 800,
			stageHeight: 450,
		});
		const afterWindow = viewWindow(1000, 1000, aspect, after);
		expect(afterWindow.y).toBeGreaterThan(before.y);
	});

	it("stops at the image's edge instead of drawing a gap", () => {
		const dragged = panView({
			...source,
			imageWidth: 1000,
			imageHeight: 1000,
			aspect,
			view: initialView(),
			deltaX: 0,
			deltaY: -10_000,
			stageWidth: 800,
			stageHeight: 450,
		});
		const window = viewWindow(1000, 1000, aspect, dragged);
		expect(window.y + window.height).toBeLessThanOrEqual(1.000001);
		expect(window.y).toBeGreaterThanOrEqual(-0.000001);
	});
});

describe("zoomView", () => {
	it("clamps between the cover crop and the maximum", () => {
		expect(zoomView({ ...source, aspect, view: initialView(), zoom: 0 }).zoom).toBe(1);
		expect(
			zoomView({ ...source, aspect, view: initialView(), zoom: MAX_FRAME_ZOOM + 5 }).zoom,
		).toBe(MAX_FRAME_ZOOM);
	});

	it("holds the source point under the anchor still", () => {
		const anchor = { x: 0.2, y: 0.7 };
		const before = viewWindow(1000, 1000, aspect, initialView());
		const sourceX = before.x + anchor.x * before.width;
		const sourceY = before.y + anchor.y * before.height;
		const zoomed = zoomView({
			...source,
			imageWidth: 1000,
			imageHeight: 1000,
			aspect,
			view: initialView(),
			zoom: 2.5,
			anchor,
		});
		const after = viewWindow(1000, 1000, aspect, zoomed);
		expect(after.x + anchor.x * after.width).toBeCloseTo(sourceX, 5);
		expect(after.y + anchor.y * after.height).toBeCloseTo(sourceY, 5);
	});
});

describe("imageBox", () => {
	it("draws the image larger than the stage, offset so the window fills it", () => {
		const box = imageBox(1000, 1000, aspect, initialView());
		// A square source keeps its full width in a 16:9 stage, so its rendered height is the
		// stage's 16/9 — a square picture — and the middle band is what the stage shows.
		expect(box.width).toBeCloseTo(100);
		expect(box.height).toBeCloseTo(100 * (16 / 9));
		expect(box.left).toBeCloseTo(0);
		expect(box.top).toBeLessThan(0);
	});

	it("moves the image opposite the window's own left edge", () => {
		const view = { center: { x: 0.6, y: 0.5 }, zoom: 2 };
		const window = viewWindow(1600, 900, aspect, view);
		const box = imageBox(1600, 900, aspect, view);
		expect(box.left).toBeCloseTo(-window.x * box.width);
	});
});

describe("viewFromCrop", () => {
	it("reopens at the saved window rather than the middle of the picture", () => {
		const crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.25 };
		const view = viewFromCrop(1000, 1000, 2, crop);
		const window = viewWindow(1000, 1000, 2, view);
		expect(window.x).toBeCloseTo(crop.x, 5);
		expect(window.y).toBeCloseTo(crop.y, 5);
		expect(window.width).toBeCloseTo(crop.width, 5);
		expect(window.height).toBeCloseTo(crop.height, 5);
	});
});

describe("viewCrop", () => {
	it("produces a window inside the image with the surface's aspect", () => {
		const crop = viewCrop(1600, 900, aspect, { center: { x: 0.4, y: 0.6 }, zoom: 1.5 });
		expect(crop.x).toBeGreaterThanOrEqual(0);
		expect(crop.y).toBeGreaterThanOrEqual(0);
		expect(crop.x + crop.width).toBeLessThanOrEqual(1.000001);
		expect((crop.width * 1600) / (crop.height * 900)).toBeCloseTo(aspect);
	});
});

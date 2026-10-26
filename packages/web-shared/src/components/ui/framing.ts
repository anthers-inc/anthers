// SPDX-License-Identifier: Apache-2.0
/**
 * The pan-and-zoom view behind the framing dialog — the small state machine, separated from
 * the markup so the clamping and the crop it produces can be tested without a DOM.
 *
 * A view is a **center** (fractions of the source image) and a **zoom** multiplier over the
 * cover crop at 1×. The stage renders the image at `1 / window` of its own size and shifts it
 * so the window lands in place, which is why nothing here needs the stage's pixel size until
 * a pointer moves: percentages carry the resting layout, and only a drag or a wheel needs a
 * measured width to turn pixels into fractions.
 *
 * The arithmetic that turns a view into the four numbers the server crops with lives in
 * `@anthers/shared/image-frame`, beside the server's own reading of them — one description of
 * the window, not a client and a server copy that can drift.
 */

import { baseWindow, frameCrop, type ImageCrop } from "@anthers/shared/image-frame";

/** How far in a frame may go. Beyond this a 1280-wide source is visibly soft at its output size. */
export const MAX_FRAME_ZOOM = 4;

export interface FrameView {
	/** The middle of the visible window, in fractions of the source image. */
	center: { x: number; y: number };
	/** 1 is the cover crop; larger is tighter. */
	zoom: number;
}

/** The view a fresh dialog opens on: the middle of the image, no extra zoom. */
export function initialView(): FrameView {
	return { center: { x: 0.5, y: 0.5 }, zoom: 1 };
}

/**
 * The view that shows a saved crop — what a reposition opens at, so the creator adjusts the
 * composition they left rather than starting from the middle of the whole picture.
 */
export function viewFromCrop(
	imageWidth: number,
	imageHeight: number,
	aspect: number,
	crop: ImageCrop,
): FrameView {
	const base = baseWindow(imageWidth, imageHeight, aspect);
	return clampView(imageWidth, imageHeight, aspect, {
		zoom: base.width / crop.width,
		center: { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 },
	});
}

/** The window a view shows, as fractions of the source. */
export function viewWindow(
	imageWidth: number,
	imageHeight: number,
	aspect: number,
	view: FrameView,
): { width: number; height: number; x: number; y: number } {
	return frameCrop({
		imageWidth,
		imageHeight,
		aspect,
		center: view.center,
		zoom: view.zoom,
	});
}

/** The crop to send to the server for this view. */
export function viewCrop(
	imageWidth: number,
	imageHeight: number,
	aspect: number,
	view: FrameView,
): ImageCrop {
	return frameCrop({ imageWidth, imageHeight, aspect, center: view.center, zoom: view.zoom });
}

/**
 * Move the view by a pointer delta in stage pixels. Pixels become fractions of the source
 * through the stage's measured width and the window's own width, so the image follows the
 * pointer at every zoom level rather than racing it at one and dragging at another.
 */
export function panView({
	imageWidth,
	imageHeight,
	aspect,
	view,
	deltaX,
	deltaY,
	stageWidth,
	stageHeight,
}: {
	imageWidth: number;
	imageHeight: number;
	aspect: number;
	view: FrameView;
	deltaX: number;
	deltaY: number;
	stageWidth: number;
	stageHeight: number;
}): FrameView {
	const window = viewWindow(imageWidth, imageHeight, aspect, view);
	const dx = stageWidth > 0 ? (deltaX / stageWidth) * window.width : 0;
	const dy = stageHeight > 0 ? (deltaY / stageHeight) * window.height : 0;
	return clampView(imageWidth, imageHeight, aspect, {
		zoom: view.zoom,
		// Dragging right moves the image right, which reveals what is to its left.
		center: { x: view.center.x - dx, y: view.center.y - dy },
	});
}

/**
 * Change zoom while holding the source point under the pointer still — the behavior a wheel
 * or a two-finger pinch has everywhere else. `anchor` is in stage fractions (0–1).
 */
export function zoomView({
	imageWidth,
	imageHeight,
	aspect,
	view,
	zoom,
	anchor = { x: 0.5, y: 0.5 },
}: {
	imageWidth: number;
	imageHeight: number;
	aspect: number;
	view: FrameView;
	zoom: number;
	anchor?: { x: number; y: number };
}): FrameView {
	const nextZoom = Math.min(MAX_FRAME_ZOOM, Math.max(1, zoom));
	const before = viewWindow(imageWidth, imageHeight, aspect, view);
	// The source point the anchor sits over, before the window changes.
	const sourceX = before.x + anchor.x * before.width;
	const sourceY = before.y + anchor.y * before.height;
	const base = baseWindow(imageWidth, imageHeight, aspect);
	const width = base.width / nextZoom;
	const height = base.height / nextZoom;
	return clampView(imageWidth, imageHeight, aspect, {
		zoom: nextZoom,
		center: {
			x: sourceX - anchor.x * width + width / 2,
			y: sourceY - anchor.y * height + height / 2,
		},
	});
}

/** Hold the window inside the image, which is what keeps an edge from showing a gap. */
export function clampView(
	imageWidth: number,
	imageHeight: number,
	aspect: number,
	view: FrameView,
): FrameView {
	const window = frameCrop({
		imageWidth,
		imageHeight,
		aspect,
		center: view.center,
		zoom: Math.min(MAX_FRAME_ZOOM, Math.max(1, view.zoom)),
	});
	const width = window.width;
	const height = window.height;
	return {
		zoom: Math.min(MAX_FRAME_ZOOM, Math.max(1, view.zoom)),
		center: {
			x: width >= 1 ? 0.5 : clamp(view.center.x, width / 2, 1 - width / 2),
			y: height >= 1 ? 0.5 : clamp(view.center.y, height / 2, 1 - height / 2),
		},
	};
}

/** The image's box, in percentages of the stage, for the resting render. */
export function imageBox(
	imageWidth: number,
	imageHeight: number,
	aspect: number,
	view: FrameView,
): { width: number; height: number; left: number; top: number } {
	const window = viewWindow(imageWidth, imageHeight, aspect, view);
	// The stage shows exactly this window, so the image is its reciprocal.
	const width = 100 / window.width;
	const height = 100 / window.height;
	return {
		width,
		height,
		left: -window.x * width,
		top: -window.y * height,
	};
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return (min + max) / 2;
	return Math.min(max, Math.max(min, value));
}

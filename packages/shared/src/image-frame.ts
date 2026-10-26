// SPDX-License-Identifier: Apache-2.0
/**
 * How a stored display image is framed — the one description of each surface's intended
 * aspect and the crop arithmetic both ends of the app share.
 *
 * ⭐ **The crop is a window on the full source, never a rewrite of it.** A surface stores the
 * image its creator uploaded (`*_source`) beside the framed result it displays, and every
 * framing edit starts again from the source. That is what makes repositioning nondestructive:
 * zooming back out after a save recovers pixels the last frame cut away.
 *
 * The same four numbers travel from the browser to the server: `x` and `y` are the window's
 * top-left, `width` and `height` its size, all as fractions of the source image. The client
 * computes them from its pan-and-zoom view; the server turns them into pixels
 * ({@link cropToPixels}) and hands the rectangle to sharp.
 */

import { z } from "zod";

/** A window on the source image, in fractions of the image's own width and height. */
export interface ImageCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The request shape both ends accept for a crop — {@link normalizeCrop} is the test. */
export const imageCropSchema = z.custom<ImageCrop>((value) => normalizeCrop(value) !== null, {
	message: "A crop needs a finite x, y, width and height inside the image.",
});

/**
 * The display surfaces that are framed, and the shape each one is shown at.
 *
 * ⭐ **These are the intended display aspects, so they are the frame the creator composes in.**
 * The sizes are the longest edge a surface needs on a 2× screen; the server renders exactly
 * them, and every `<img>` keeps its own `object-cover`.
 */
export const IMAGE_FRAME_SPECS = {
	/** A Work's or a Project's poster — 16:9 everywhere, from the feed to a Project's page. */
	thumbnail: { width: 1280, height: 720, noun: "thumbnail" },
	/** A profile banner — the 3:1 band above a profile, Bluesky's own convention. */
	banner: { width: 1500, height: 500, noun: "banner" },
	/** A profile avatar, shown as a circle. */
	avatar: { width: 512, height: 512, noun: "avatar" },
} as const satisfies Record<string, { width: number; height: number; noun: string }>;

/** The surfaces {@link IMAGE_FRAME_SPECS} describes. */
export type ImageFrameType = keyof typeof IMAGE_FRAME_SPECS;

export function isImageFrameType(value: unknown): value is ImageFrameType {
	return typeof value === "string" && Object.hasOwn(IMAGE_FRAME_SPECS, value);
}

/** The aspect ratio a surface is framed at, as width ÷ height. */
export function frameAspect(type: ImageFrameType): number {
	const spec = IMAGE_FRAME_SPECS[type];
	return spec.width / spec.height;
}

/**
 * The crop a pan-and-zoom view works out to, in fractions of the source.
 *
 * `center` is the middle of the visible window in the same normalized space, and `zoom` is
 * the multiplier over the smallest window that covers the surface's aspect at 1×. The
 * result is clamped so the window never leaves the image, which is also what keeps the
 * stage from showing a gap at an edge.
 */
export function frameCrop({
	imageWidth,
	imageHeight,
	aspect,
	center,
	zoom,
}: {
	imageWidth: number;
	imageHeight: number;
	aspect: number;
	center: { x: number; y: number };
	zoom: number;
}): ImageCrop {
	const base = baseWindow(imageWidth, imageHeight, aspect);
	const width = base.width / Math.max(1, zoom);
	const height = base.height / Math.max(1, zoom);
	const cx = clamp(center.x, width / 2, 1 - width / 2);
	const cy = clamp(center.y, height / 2, 1 - height / 2);
	return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * The 1× window — the largest rectangle of the surface's aspect that fits inside the source,
 * as fractions of the source. This is the cover crop, and zoom multiplies into it.
 */
export function baseWindow(
	imageWidth: number,
	imageHeight: number,
	aspect: number,
): { width: number; height: number } {
	const imageAspect = imageWidth / imageHeight;
	// A source wider than the surface keeps its full height; a taller one keeps its full width.
	if (imageAspect >= aspect) return { width: aspect / imageAspect, height: 1 };
	return { width: 1, height: imageAspect / aspect };
}

/**
 * A crop in pixels, rounded outward and clamped to the image, with at least one pixel in
 * each direction. The server's sharp extract reads this; `extract` refuses a region past
 * the source, so the clamp is what keeps a rounding error from failing a save.
 */
export function cropToPixels(
	imageWidth: number,
	imageHeight: number,
	crop: ImageCrop,
): { left: number; top: number; width: number; height: number } {
	const left = clamp(Math.floor(crop.x * imageWidth), 0, imageWidth - 1);
	const top = clamp(Math.floor(crop.y * imageHeight), 0, imageHeight - 1);
	const width = clamp(Math.ceil(crop.width * imageWidth), 1, imageWidth - left);
	const height = clamp(Math.ceil(crop.height * imageHeight), 1, imageHeight - top);
	return { left, top, width, height };
}

/**
 * Normalize a crop a client sent: finite numbers only, positive size, inside the image, and
 * never wider or taller than it. A refusal rather than a clamp, because a crop that names
 * the image's outside is a malformed request rather than a rounding difference.
 */
export function normalizeCrop(value: unknown): ImageCrop | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const x = record.x;
	const y = record.y;
	const width = record.width;
	const height = record.height;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		![x, y, width, height].every(Number.isFinite)
	) {
		return null;
	}
	if (width <= 0 || height <= 0) return null;
	if (x < 0 || y < 0 || x + width > 1.000001 || y + height > 1.000001) return null;
	return { x, y, width, height };
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return (min + max) / 2;
	return Math.min(max, Math.max(min, value));
}

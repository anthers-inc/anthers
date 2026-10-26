// SPDX-License-Identifier: Apache-2.0
/**
 * Frame a display image from its full source, and name where the result lives.
 *
 * ⭐ **The source is the file the creator uploaded; the derivative is what the site shows.**
 * A surface stores both (`works.thumbnail` beside `works.thumbnail_source`, and the same pair
 * on Projects and accounts), so every reposition starts from the whole picture rather than
 * from the previous crop. That is the nondestructive half of the framing feature: zooming
 * back out after a save recovers pixels the last frame cut away.
 *
 * ⚠️ **Orientation is applied before the crop, and the geometry is read from the oriented
 * image.** A phone photo carries an EXIF rotation; the browser lays it out rotated, so a crop
 * computed against those visible dimensions only lands on the right pixels if sharp rotates
 * first too. `rotate()` in the pipeline is that step, and the two dimensions are swapped here
 * for the metadata read because `metadata()` reports the stored, unrotated size.
 */

import {
	cropToPixels,
	IMAGE_FRAME_SPECS,
	type ImageCrop,
	type ImageFrameType,
} from "@anthers/shared/image-frame";
import sharp from "sharp";

/** A refusal the route can say in the creator's own words, rather than a 500. */
export class ImageFrameRefusal extends Error {}

/** Where a framed derivative is stored: the surface's own prefix, under a named subfolder. */
const FRAMED_PREFIX: Record<ImageFrameType, string> = {
	thumbnail: "thumbnails",
	cover: "covers",
	header: "headers",
	avatar: "avatars",
};

/**
 * The key a framed derivative is written to. It sits under the creator's own prefix so
 * `isOwnStorageRef` covers it like every other upload, and under the surface's existing
 * public-chrome prefix so the bucket policy needs no new case.
 */
export function framedImageKey(userId: number, mediaType: ImageFrameType): string {
	const uuid = crypto.randomUUID().replace(/-/g, "");
	return `creators/${userId}/${FRAMED_PREFIX[mediaType]}/framed/${uuid}.webp`;
}

/**
 * Crop a source image to the surface's aspect and encode it as WebP.
 *
 * The output is exactly the spec's pixel size, which is what every render site's
 * `object-cover` expects. `fit: "cover"` is a backstop rather than the crop itself: the
 * extract has already taken the creator's window, and this only absorbs the sub-pixel
 * rounding of a normalized rectangle.
 */
export async function frameImage(
	source: Buffer,
	mediaType: ImageFrameType,
	crop: ImageCrop,
): Promise<Buffer> {
	const spec = IMAGE_FRAME_SPECS[mediaType];
	let probe: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
	try {
		probe = await sharp(source, { failOn: "none" }).metadata();
	} catch {
		throw new ImageFrameRefusal("That file isn't an image we can read. Try another one.");
	}
	if (!probe.width || !probe.height) {
		throw new ImageFrameRefusal("That file isn't an image we can read. Try another one.");
	}
	// EXIF orientations 5–8 rotate by a quarter turn, so the visible width is the stored height.
	const quarterTurned = (probe.orientation ?? 1) >= 5;
	const visibleWidth = quarterTurned ? probe.height : probe.width;
	const visibleHeight = quarterTurned ? probe.width : probe.height;
	const region = cropToPixels(visibleWidth, visibleHeight, crop);

	try {
		return await sharp(source, { failOn: "none" })
			.rotate()
			.extract(region)
			.resize(spec.width, spec.height, { fit: "cover", position: "centre" })
			.webp({ quality: 90 })
			.toBuffer();
	} catch {
		throw new ImageFrameRefusal(
			"That image couldn't be framed. Try another file, or upload it again.",
		);
	}
}

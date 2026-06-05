/**
 * Image processing service — replaces Pillow for avatar/cover/thumbnail processing.
 *
 * Uses sharp for resize, crop, and format conversion.
 * All functions accept and return Buffers for compatibility with the StorageService.
 */

import sharp from "sharp";

export interface ImageProcessOptions {
	/** Max width in pixels. Height scales proportionally unless height is also set. */
	width?: number;
	/** Max height in pixels. Width scales proportionally unless width is also set. */
	height?: number;
	/** If true, crop to exact dimensions (cover fit). Otherwise, fit within bounds (inside fit). */
	crop?: boolean;
	/** Output format. Defaults to "webp". */
	format?: "webp" | "jpeg" | "png";
	/** Quality (1-100). Defaults to 80. */
	quality?: number;
}

/**
 * Process an image: resize, optionally crop, and convert format.
 * Returns a buffer of the processed image.
 */
export async function processImage(
	input: Buffer | Uint8Array,
	opts: ImageProcessOptions = {},
): Promise<Buffer> {
	const { width, height, crop = false, format = "webp", quality = 80 } = opts;

	let pipeline = sharp(input);

	if (width || height) {
		pipeline = pipeline.resize(width, height, {
			fit: crop ? "cover" : "inside",
			withoutEnlargement: true,
		});
	}

	switch (format) {
		case "webp":
			pipeline = pipeline.webp({ quality });
			break;
		case "jpeg":
			pipeline = pipeline.jpeg({ quality, mozjpeg: true });
			break;
		case "png":
			pipeline = pipeline.png({ quality });
			break;
	}

	return pipeline.toBuffer();
}

/** Process an avatar: square crop to 256x256, output as WebP. */
export async function processAvatar(input: Buffer | Uint8Array): Promise<Buffer> {
	return processImage(input, {
		width: 256,
		height: 256,
		crop: true,
		format: "webp",
		quality: 85,
	});
}

/** Process a cover/header image: fit within 1920px wide, output as WebP. */
export async function processCover(input: Buffer | Uint8Array): Promise<Buffer> {
	return processImage(input, {
		width: 1920,
		format: "webp",
		quality: 85,
	});
}

/** Process a screenshot: fit within 1920px wide, output as WebP. */
export async function processScreenshot(input: Buffer | Uint8Array): Promise<Buffer> {
	return processImage(input, {
		width: 1920,
		format: "webp",
		quality: 85,
	});
}

/** Generate a thumbnail from an image: fit within 400px wide, output as WebP. */
export async function processImageThumbnail(input: Buffer | Uint8Array): Promise<Buffer> {
	return processImage(input, {
		width: 400,
		format: "webp",
		quality: 75,
	});
}

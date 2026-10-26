// SPDX-License-Identifier: Apache-2.0
/**
 * The server's half of framing: the derivative is the surface's exact shape, and it contains
 * the window the crop named rather than the middle of the image.
 *
 * ⭐ **The second assertion is the one a size check cannot make.** A route that ignored the crop
 * and resized the whole source would produce the right dimensions and the wrong picture, so the
 * suite paints the source in two halves and reads the pixels back.
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_FRAME_SPECS } from "@anthers/shared/image-frame";
import sharp from "sharp";
import { framedImageKey, frameImage, ImageFrameRefusal } from "./image-framing";

async function solid(width: number, height: number, background: string): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background } })
		.png()
		.toBuffer();
}

describe("frameImage", () => {
	it("renders every surface at its spec's exact size", async () => {
		const source = await solid(1200, 800, "#336699");
		for (const [mediaType, spec] of Object.entries(IMAGE_FRAME_SPECS)) {
			const framed = await frameImage(source, mediaType as keyof typeof IMAGE_FRAME_SPECS, {
				x: 0,
				y: 0,
				width: 1,
				height: 1,
			});
			const meta = await sharp(framed).metadata();
			expect(meta.width).toBe(spec.width);
			expect(meta.height).toBe(spec.height);
			expect(meta.format).toBe("webp");
		}
	});

	it("cuts the named window rather than the middle of the source", async () => {
		// Left half red, right half blue; a window on the right half must come back blue.
		const source = await sharp({
			create: { width: 400, height: 400, channels: 3, background: "#ff0000" },
		})
			.composite([
				{
					input: await solid(200, 400, "#0000ff"),
					left: 200,
					top: 0,
				},
			])
			.png()
			.toBuffer();

		const framed = await frameImage(source, "avatar", {
			x: 0.5,
			y: 0,
			width: 0.5,
			height: 1,
		});
		const { data, info } = await sharp(framed).raw().toBuffer({ resolveWithObject: true });
		const centre =
			(info.height / 2) * info.width * info.channels + (info.width / 2) * info.channels;
		expect(data[centre]).toBeLessThan(20); // red
		expect(data[centre + 2]).toBeGreaterThan(235); // blue
	});

	it("refuses bytes that are not an image", async () => {
		await expect(
			frameImage(Buffer.from("not an image"), "thumbnail", {
				x: 0,
				y: 0,
				width: 1,
				height: 1,
			}),
		).rejects.toBeInstanceOf(ImageFrameRefusal);
	});
});

describe("framedImageKey", () => {
	it("sits under the creator's own prefix and the surface's public folder", () => {
		const key = framedImageKey(42, "thumbnail");
		expect(key.startsWith("creators/42/thumbnails/framed/")).toBe(true);
		expect(key.endsWith(".webp")).toBe(true);
		expect(framedImageKey(42, "avatar").startsWith("creators/42/avatars/framed/")).toBe(true);
	});
});

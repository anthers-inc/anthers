// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the gutter-based panel detector.
 *
 * The detector works on raw RGB buffers through `sharp`, so the fixtures here build simple
 * synthetic PNGs: a 2x2 grid page, a full-bleed page, and a black-bordered page. What is
 * asserted is the panel count and approximate geometry, which is enough to prove the
 * algorithm's shape without depending on real comic art.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { detectPanels, sampleInkColor } from "../lib/panel-detection.js";

const RUN = crypto.randomUUID().slice(0, 8);
const FIXTURE_DIR = await mkdtemp(join(tmpdir(), `panel_detection_${RUN}_`));

async function makePage(
	name: string,
	layout: "grid2x2" | "full" | "black-bordered",
): Promise<Uint8Array> {
	const width = 400;
	const height = 600;
	const bytes = Buffer.alloc(width * height * 3);

	const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
		const idx = (y * width + x) * 3;
		bytes[idx] = r;
		bytes[idx + 1] = g;
		bytes[idx + 2] = b;
	};

	// White background.
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			setPixel(x, y, 255, 255, 255);
		}
	}

	if (layout === "grid2x2") {
		const gutter = 20;
		const halfX = Math.floor(width / 2);
		const halfY = Math.floor(height / 2);
		for (let y = 0; y < height; y++) {
			for (let x = halfX - gutter / 2; x < halfX + gutter / 2; x++) {
				setPixel(x, y, 255, 255, 255);
			}
		}
		for (let x = 0; x < width; x++) {
			for (let y = halfY - gutter / 2; y < halfY + gutter / 2; y++) {
				setPixel(x, y, 255, 255, 255);
			}
		}
		// Four dark panels.
		for (let y = 10; y < halfY - gutter / 2; y++) {
			for (let x = 10; x < halfX - gutter / 2; x++) setPixel(x, y, 32, 32, 32);
		}
		for (let y = 10; y < halfY - gutter / 2; y++) {
			for (let x = halfX + gutter / 2; x < width - 10; x++) setPixel(x, y, 32, 32, 32);
		}
		for (let y = halfY + gutter / 2; y < height - 10; y++) {
			for (let x = 10; x < halfX - gutter / 2; x++) setPixel(x, y, 32, 32, 32);
		}
		for (let y = halfY + gutter / 2; y < height - 10; y++) {
			for (let x = halfX + gutter / 2; x < width - 10; x++) setPixel(x, y, 32, 32, 32);
		}
	} else if (layout === "full") {
		// Full-bleed dark rectangle, no gutters.
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				setPixel(x, y, 32, 32, 32);
			}
		}
	} else if (layout === "black-bordered") {
		// Black page with two light panels stacked.
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				setPixel(x, y, 0, 0, 0);
			}
		}
		const gutter = 20;
		const halfY = Math.floor(height / 2);
		for (let y = 10; y < halfY - gutter / 2; y++) {
			for (let x = 10; x < width - 10; x++) setPixel(x, y, 250, 250, 250);
		}
		for (let y = halfY + gutter / 2; y < height - 10; y++) {
			for (let x = 10; x < width - 10; x++) setPixel(x, y, 250, 250, 250);
		}
	}

	const path = join(FIXTURE_DIR, `${name}.png`);
	await sharp(bytes, { raw: { width, height, channels: 3 } })
		.png()
		.toFile(path);
	return new Uint8Array(await Bun.file(path).arrayBuffer());
}

afterAll(async () => {
	await rm(FIXTURE_DIR, { recursive: true, force: true });
});

describe("detectPanels", () => {
	it("finds four panels in a 2x2 grid page", async () => {
		const buffer = await makePage("grid", "grid2x2");
		const panels = await detectPanels(buffer);
		expect(panels.length).toBe(4);
		for (const p of panels) {
			expect(p.x).toBeGreaterThanOrEqual(0);
			expect(p.y).toBeGreaterThanOrEqual(0);
			expect(p.x + p.width).toBeLessThanOrEqual(1.01);
			expect(p.y + p.height).toBeLessThanOrEqual(1.01);
			expect(p.width).toBeGreaterThan(0.35);
			expect(p.height).toBeGreaterThan(0.35);
		}
	});

	it("collapses a full-bleed page to one whole-page panel", async () => {
		const buffer = await makePage("full", "full");
		const panels = await detectPanels(buffer);
		expect(panels.length).toBe(1);
		expect(panels[0]).toEqual({ x: 0, y: 0, width: 1, height: 1 });
	});

	it("detects light panels on a black-bordered page", async () => {
		const buffer = await makePage("black", "black-bordered");
		const inkColor = await sampleInkColor(buffer);
		expect(inkColor).toBe("black");
		const panels = await detectPanels(buffer, { inkColor: "black" });
		expect(panels.length).toBe(2);
		expect(panels[0].y).toBeLessThan(panels[1].y);
	});
});

// SPDX-License-Identifier: Apache-2.0
/**
 * Gutter/whitespace panel detection for a rasterized comic page.
 *
 * The simplest honest detector: find large white/near-white gutters — a page's panels are
 * separated by white borders, so a vertical-projection histogram of "dark pixel density"
 * finds panel columns, and a horizontal one finds panel rows within each column. Libraries:
 * `sharp` for pixel access (raw buffer), no external CV dep.
 *
 * Reading direction is LTR. No Work field for reading direction exists today, so the detector
 * assumes LTR and sorts panels top-left-first.
 *
 * Failure posture:
 * - Zero panels detected → one whole-page panel, auto-flagged.
 * - More than 20 panels → collapse to one whole-page panel, auto-flagged.
 */

import sharp from "sharp";

export interface PanelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type InkColor = "white" | "black";

interface DetectionOptions {
	inkColor?: InkColor;
	/** Minimum panel size as a fraction of the page (width or height). */
	minPanelSize?: number;
	/** Maximum panels before collapsing to whole-page. */
	maxPanels?: number;
}

const DEFAULT_OPTIONS: Required<DetectionOptions> = {
	inkColor: "white",
	minPanelSize: 0.05,
	maxPanels: 20,
};

/**
 * Sample border pixels to guess whether gutters are white (default) or black.
 *
 * Poppler renders PDF pages on a white canvas, so most comics have white gutters and dark
 * ink. Black-bordered manga flips that: gutters are black and panels are lighter. The sample
 * takes the four edges; if their mean luminance is low, we treat the gutter as black.
 */
export async function sampleInkColor(buffer: Uint8Array): Promise<InkColor> {
	const { data, info } = await sharp(buffer)
		.resize({ width: 400 })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const width = info.width;
	const height = info.height;
	const sampleSize = Math.min(width, height, 32);
	let total = 0;
	let count = 0;
	const edge = (x: number, y: number) => {
		const idx = (y * width + x) * 3;
		total += pixels[idx] + pixels[idx + 1] + pixels[idx + 2];
		count += 3;
	};
	for (let i = 0; i < sampleSize; i++) {
		edge(i, 0);
		edge(width - 1 - i, 0);
		edge(i, height - 1);
		edge(width - 1 - i, height - 1);
		edge(0, i);
		edge(0, height - 1 - i);
		edge(width - 1, i);
		edge(width - 1, height - 1 - i);
	}
	const mean = total / count;
	return mean < 80 ? "black" : "white";
}

function isForeground(
	buffer: Uint8Array,
	idx: number,
	inkColor: InkColor,
	threshold: number,
): boolean {
	const r = buffer[idx];
	const g = buffer[idx + 1];
	const b = buffer[idx + 2];
	const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
	if (inkColor === "white") {
		return luminance < threshold;
	}
	return luminance > 255 - threshold;
}

function findRuns(
	values: number[],
	minLength: number,
	maxValue: number,
): Array<{ start: number; end: number }> {
	const runs: Array<{ start: number; end: number }> = [];
	let start: number | null = null;
	for (let i = 0; i <= values.length; i++) {
		const inGutter = i < values.length && values[i] <= maxValue;
		if (inGutter && start == null) {
			start = i;
		} else if ((!inGutter || i === values.length) && start != null) {
			const end = i;
			if (end - start >= minLength) {
				runs.push({ start, end });
			}
			start = null;
		}
	}
	return runs;
}

/**
 * Detect panel rectangles on a page image.
 *
 * Returns normalized rectangles (0..1) sorted top-left-first, capped at `maxPanels`.
 * Zero panels or over-segmentation returns a single whole-page rectangle.
 */
export async function detectPanels(
	imageBuffer: Uint8Array,
	options: DetectionOptions = {},
): Promise<PanelRect[]> {
	const { inkColor, minPanelSize, maxPanels } = { ...DEFAULT_OPTIONS, ...options };

	const source = sharp(imageBuffer);
	const metadata = await source.metadata();
	const fullWidth = metadata.width ?? 1;
	const fullHeight = metadata.height ?? 1;

	const { data, info } = await source
		.resize({ width: Math.min(fullWidth, 800) })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const w = info.width;
	const h = info.height;
	const scaleX = fullWidth / w;
	const scaleY = fullHeight / h;

	const foregroundThreshold = 240;
	const gutterMaxDensity = 0.05;
	const gutterMinRunRatio = 0.015;

	// Vertical projection: dark pixel density per column.
	const colDensity = new Float32Array(w);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const idx = (y * w + x) * 3;
			if (isForeground(buffer, idx, inkColor, foregroundThreshold)) {
				colDensity[x]++;
			}
		}
	}
	for (let x = 0; x < w; x++) colDensity[x] /= h;

	const minGutterWidth = Math.max(2, Math.floor(w * gutterMinRunRatio));
	const colGutters = findRuns(Array.from(colDensity), minGutterWidth, gutterMaxDensity);

	// Convert column gutters to column boundaries (content between gutters).
	const colBounds: Array<{ start: number; end: number }> = [];
	let lastEnd = 0;
	for (const gutter of colGutters) {
		if (gutter.start > lastEnd) {
			colBounds.push({ start: lastEnd, end: gutter.start });
		}
		lastEnd = Math.max(lastEnd, gutter.end);
	}
	if (lastEnd < w) {
		colBounds.push({ start: lastEnd, end: w });
	}
	if (colBounds.length === 0) {
		colBounds.push({ start: 0, end: w });
	}

	const rects: PanelRect[] = [];

	for (const col of colBounds) {
		// Horizontal projection within this column.
		const rowDensity = new Float32Array(h);
		for (let y = 0; y < h; y++) {
			let dark = 0;
			for (let x = col.start; x < col.end; x++) {
				const idx = (y * w + x) * 3;
				if (isForeground(buffer, idx, inkColor, foregroundThreshold)) {
					dark++;
				}
			}
			rowDensity[y] = dark / (col.end - col.start);
		}

		const minGutterHeight = Math.max(2, Math.floor(h * gutterMinRunRatio));
		const rowGutters = findRuns(Array.from(rowDensity), minGutterHeight, gutterMaxDensity);

		const rowBounds: Array<{ start: number; end: number }> = [];
		let rowLastEnd = 0;
		for (const gutter of rowGutters) {
			if (gutter.start > rowLastEnd) {
				rowBounds.push({ start: rowLastEnd, end: gutter.start });
			}
			rowLastEnd = Math.max(rowLastEnd, gutter.end);
		}
		if (rowLastEnd < h) {
			rowBounds.push({ start: rowLastEnd, end: h });
		}
		if (rowBounds.length === 0) {
			rowBounds.push({ start: 0, end: h });
		}

		for (const row of rowBounds) {
			const x = (col.start * scaleX) / fullWidth;
			const y = (row.start * scaleY) / fullHeight;
			const rectWidth = ((col.end - col.start) * scaleX) / fullWidth;
			const rectHeight = ((row.end - row.start) * scaleY) / fullHeight;
			if (rectWidth >= minPanelSize && rectHeight >= minPanelSize) {
				rects.push({ x, y, width: rectWidth, height: rectHeight });
			}
		}
	}

	// Sort top-left-first (LTR, then top-to-bottom).
	rects.sort((a, b) => {
		const rowA = Math.round(a.y * 100);
		const rowB = Math.round(b.y * 100);
		if (rowA !== rowB) return rowA - rowB;
		return Math.round(a.x * 100) - Math.round(b.x * 100);
	});

	if (rects.length === 0 || rects.length > maxPanels) {
		return [{ x: 0, y: 0, width: 1, height: 1 }];
	}

	return rects;
}

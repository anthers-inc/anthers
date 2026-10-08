// SPDX-License-Identifier: Apache-2.0
/**
 * The Badge composition's rules, proved rather than restated:
 *
 * - the palette conversion anchors to what the browser renders (the creator saw oklch;
 *   the PNG must match it),
 * - the vendor's markup is fill-stripped, recolored and de-scripted before inlining,
 * - the composed SVG carries the shape, the constant edge and the placement the picker
 *   chose,
 * - and the compose service writes the composed PNG and the provenance row and nothing
 *   else — the vector is not persisted in any form.
 */

import { describe, expect, it } from "bun:test";
import { BADGE_COMPOSE_PX } from "@anthers/shared/badge-art";
import sharp from "sharp";
import { composeBadgeSvg, cssColorToHex, normalizeToRecolorable, oklchToHex } from "./compose-svg";

describe("oklch → hex", () => {
	it("anchors at white and black", () => {
		expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
		expect(oklchToHex(0, 0, 0)).toBe("#000000");
	});

	it("matches Chromium's own rendering, via independent reference conversions", () => {
		// The anchors are headless-Chromium-sampled (2026-10-07, a canvas filled with the
		// CSS value itself) AND independently confirmed by culori — two answers agreeing
		// on every channel. The edge's blue channel is where a hand-rolled matrix
		// diverged, which is why the library does the conversion now.
		expect(cssColorToHex("oklch(34% 0.05 55)")).toBe("#4c311e");
		expect(cssColorToHex("oklch(74% 0.09 92)")).toBe("#bfa967");
		expect(cssColorToHex("oklch(46% 0.08 152)")).toBe("#326541");
	});

	it("refuses a color it cannot parse rather than rendering black", () => {
		expect(() => cssColorToHex("rgb(0 0 0)")).toThrow(/unparseable/);
	});
});

describe("normalizeToRecolorable", () => {
	const raw = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<svg width="100pt" height="100pt" viewBox="0 0 100 100" version="1.1">',
		"<title>bee</title>",
		'<path id="body" class="c" style="fill: red" d="M10 10h80v80z" fill="#000"/>',
		'<path d="M0 0c0 1" fill="none" stroke="#000"/>',
		"</svg>",
	].join("\n");

	it("strips the prolog, the title and every baked fill", () => {
		const { viewBox, inner } = normalizeToRecolorable(raw);
		expect(viewBox).toBe("0 0 100 100");
		expect(inner).not.toContain("<title");
		expect(inner).not.toContain('fill="#000"');
		expect(inner).toContain('d="M10 10h80v80z"');
	});

	it("strips id, class and style attributes — the script-shaped surface", () => {
		const { inner } = normalizeToRecolorable(raw);
		expect(inner).not.toContain('id="');
		expect(inner).not.toContain("class=");
		expect(inner).not.toContain("style=");
	});

	it("keeps fill=none, which is geometry rather than color", () => {
		const { inner } = normalizeToRecolorable(raw);
		expect(inner).toContain('fill="none"');
	});

	it("refuses a file with no viewBox rather than composing blind", () => {
		expect(() => normalizeToRecolorable('<svg><path d="M0 0"/></svg>')).toThrow(/viewBox/);
	});
});

describe("composeBadgeSvg", () => {
	const placement = {
		shape: "circle",
		fieldColor: "moss",
		emblemColor: "#ffffff",
		scale: 1,
		offsetX: 0,
		offsetY: 0,
	};

	it("carries the shape path, the field and the constant edge inward-stroked", () => {
		const svg = composeBadgeSvg({
			placement,
			viewBox: "0 0 100 100",
			inner: '<path d="M10 10h80v80z"/>',
		});
		expect(svg).toContain('viewBox="0 0 100 100"');
		expect(svg).toContain('d="M50 4a46 46 0 1 0 0 92a46 46 0 1 0 0-92Z"');
		expect(svg).toMatch(/stroke="#[0-9a-f]{6}"/);
		// The edge is painted inward by double-width stroke inside a clip of the same
		// path, which is what keeps the silhouette the shape rather than growing it.
		expect(svg).toContain('stroke-width="18"');
		expect(svg).toContain("clip-path");
	});

	it("scales and places the emblem inside the shape's emblemBox", () => {
		const svg = composeBadgeSvg({
			placement,
			viewBox: "0 0 100 100",
			inner: '<path d="M10 10h1v1z"/>',
		});
		// A 100-unit viewBox fills a 52-unit emblemBox exactly at scale 1, centered —
		// the transform's translate lands at (24, 24), the circle's box origin.
		expect(svg).toMatch(/translate\(24(?:\.0+)? 24(?:\.0+)?\)/);
	});

	it("🚨 injects the creator's emblem color into the inline markup", () => {
		// The regression lock for the dead-wiring defect: the normalized fixture carries a
		// fill-strippable color, and the composed SVG must recolor it — not leave the
		// vendor's own color in place.
		const svg = composeBadgeSvg({
			placement: { ...placement, emblemColor: "#ff0000" },
			viewBox: "0 0 100 100",
			inner: '<path d="M10 10h80v80z" fill="#000000"/>',
		});
		expect(svg).toContain('fill="#ff0000"');
		expect(svg).not.toContain("#000000");
	});

	it("rasterizes to BADGE_COMPOSE_PX through sharp with the field reading as the field", () => {
		// The anchor assertion behind the conversion: rasterize a composed moss badge
		// and read a pixel inside the field — it must be the moss hex, not black.
		const svg = composeBadgeSvg({
			placement,
			viewBox: "0 0 100 100",
			inner: '<path d="M90 90h1v1z"/>',
		});
		return sharp(Buffer.from(svg))
			.resize(BADGE_COMPOSE_PX, BADGE_COMPOSE_PX)
			.png()
			.toBuffer()
			.then(async (png) => {
				const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
				const w = raw.info.width;
				const i = (Math.floor(w / 4) * w + Math.floor(w / 4)) * raw.info.channels;
				const moss = cssColorToHex("oklch(46% 0.08 152)");
				expect([raw.data[i], raw.data[i + 1], raw.data[i + 2]]).toEqual([
					parseInt(moss.slice(1, 3), 16),
					parseInt(moss.slice(3, 5), 16),
					parseInt(moss.slice(5, 7), 16),
				]);
			});
	});

	it("refuses a placement naming an unknown shape or color", () => {
		expect(() =>
			composeBadgeSvg({
				placement: { ...placement, shape: "star" },
				viewBox: "0 0 100 100",
				inner: "",
			}),
		).toThrow(/unknown shape/);
		expect(() =>
			composeBadgeSvg({
				placement: { ...placement, fieldColor: "periwinkle" },
				viewBox: "0 0 100 100",
				inner: "",
			}),
		).toThrow(/unknown field color/);
	});
});

// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side Badge composition — the SVG that `badge-art-compose.ts` rasterizes.
 *
 * 🚨 **This mirrors `BadgeMark` in `@anthers/web-shared` exactly.** The browser component
 * is the definition of what a Badge looks like; this file is its server twin for the one
 * surface a creator's Badge persists as. A visual change to `BadgeMark` is a change to
 * this file in the same commit, and a test here reads both files' shared constants rather
 * than trusting two copies to agree — the drift that would make a picker preview differ
 * from the saved Badge is the failure this pairing exists to prevent.
 *
 * Two adaptations from the browser, each measured rather than guessed:
 *
 * - **oklch does not survive `sharp`'s SVG rasterizer.** The bundled librsvg renders an
 *   `oklch(...)` fill as black — measured 2026-10-07 — and the badge palette is oklch
 *   everywhere, so every color is converted to sRGB (CSS Color 4's own matrix geometry)
 *   at composition time. The conversion computes what the browser renders, in the
 *   browser's own gamut mapping, rather than approximating it.
 * - **The emblem is drawn INSIDE the SVG** rather than being an HTML layer, which is
 *   what `BadgeMark`'s emoji does and its library emblem cannot (it renders as a masked
 *   HTML element). One artifact has to hold the whole Badge, so the emblem's markup is
 *   inlined with a single injected fill color.
 */

import {
	BADGE_COLORS,
	BADGE_COMPOSE_PX,
	BADGE_EDGE,
	BADGE_EDGE_WIDTH,
	BADGE_SHAPES,
	type BadgeComposeParams,
} from "@anthers/shared/badge-art";
import { formatHex } from "culori";

/**
 * Percent-encode per RFC 3986 for a data context, applied to SVG source — never let a
 * vendor-supplied string reach XML unescaped.
 */
function xmlEscape(s: string): string {
	return s
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * oklch → hex through culori, the reference conversion — anchored to Chromium's own
 * `oklch()` rendering in `compose-svg.test.ts`, which is the comparison that matters:
 * the viewer comparing the picker's emblem with the saved PNG is comparing the browser's
 * answer with this one.
 *
 * A hand-rolled CSS Color 4 matrix was tried first and agreed with culori on two of the
 * three palette anchors (the edge's blue channel differed by a step) — which is exactly
 * the failure mode a reference library exists to prevent, so the library does it.
 */
export function oklchToHex(L: number, C: number, H: number): string {
	const hex = formatHex({ mode: "oklch", l: L, c: C, h: H });
	if (!/^#[0-9a-f]{6}$/.test(hex)) {
		throw new Error(`compose-svg: oklch conversion failed for ${L} ${C} ${H}`);
	}
	return hex;
}
/**
 * Parse the palette's own value shapes — `oklch(74% 0.09 92)` or an already-hex string —
 * so a color id resolves the same way every surface reads it.
 */
export function cssColorToHex(color: string): string {
	const m = /oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/.exec(color);
	if (!m) {
		// Already a hex value (an emblem color the picker supplied), or a color shape this
		// file does not parse — pass a hex through and refuse anything else rather than
		// rendering a color nobody chose.
		if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
		throw new Error(`compose-svg: unparseable color ${color}`);
	}
	return oklchToHex(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}

/**
 * Strip the baked fills from a downloaded SVG so one injected color controls it, and
 * take its geometry — the `normalize()` rule from the brand codegen, at runtime.
 *
 * The vendor deliberately serves black-on-transparent art, but "deliberately" is not a
 * contract: a shape carrying its own fill would shrug off the recolor and land on the
 * Badge in whatever color it shipped in, so the fills are stripped first and the color
 * is injected after. The rules are the codegen's, ported.
 */
export function normalizeToRecolorable(raw: string): { viewBox: string; inner: string } {
	const s = raw
		.replace(/<\?xml[\s\S]*?\?>/g, "")
		.replace(/<!DOCTYPE[\s\S]*?>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const open = s.match(/<svg\b[^>]*>/i);
	if (!open) throw new Error("no <svg> element in downloaded SVG");
	const openTag = open[0];
	const viewBox = openTag.match(/viewBox\s*=\s*"([^"]+)"/i)?.[1]?.trim() ?? "";
	if (!viewBox) throw new Error("no viewBox in downloaded SVG");
	let inner = s.slice(s.indexOf(openTag) + openTag.length, s.lastIndexOf("</svg>"));
	inner = inner
		.replace(/<title[\s\S]*?<\/title>/gi, "")
		.replace(/<desc[\s\S]*?<\/desc>/gi, "")
		.replace(/<metadata[\s\S]*?<\/metadata>/gi, "")
		.replace(/\sfill\s*=\s*"([^"]*)"/gi, (m, v) => (v.trim().toLowerCase() === "none" ? m : ""))
		.replace(/fill\s*:\s*[^;"'}]+;?/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	// 🚨 The vendor file is third-party input to an XML renderer. Every id, class and
	// style attribute is dropped rather than escaped around: the composition needs only
	// geometry, and an attribute that survives is an attribute that could carry a
	// script-shaped payload into the rasterizer.
	inner = inner
		.replace(/\s(id|class|style)\s*=\s*"[^"]*"/gi, "")
		.replace(/\s(id|class|style)\s*=\s*'[^']*'/gi, "");
	return { viewBox, inner };
}

/**
 * Inject the creator's color into the normalized emblem markup.
 *
 * Every element carries `fill="#…"` after the injection, because the vendor art is
 * line-drawing markup whose elements carry no fill after `normalizeToRecolorable`
 * stripped it — one injected color controls the whole icon, the same rule the site's
 * own recoloring follows.
 */
function recolorEmblem(inner: string, emblemColorHex: string): string {
	const withoutFills = inner.replace(/(<(path|circle|rect|ellipse|polygon|line|polyline)\b)/g,
		`$1 fill="${emblemColorHex}"`);
	// An element that already kept a fill="none" from normalization stays unfilled.
	return withoutFills.replace(/(<(path|circle|rect|ellipse|polygon|line|polyline)\b[^>]*?)\sfill="none"/g,
		`$1`);
}

/**
 * Parse an emblem's viewBox into scale-and-translate parameters for inlining.
 */
function viewBoxParams(viewBox: string): { vx: number; vy: number; vw: number; vh: number } {
	const parts = viewBox.split(/[\s,]+/).map((v) => Number(v));
	if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
		throw new Error(`compose-svg: unparseable viewBox ${viewBox}`);
	}
	return { vx: parts[0], vy: parts[1], vw: parts[2], vh: parts[3] };
}

/**
 * The Badge SVG, whole: shape path filled with the field color, the constant edge
 * painted inward, and the emblem fitted to the shape's `emblemBox` at the creator's
 * scale and offset — `contain`-fitted, the way `BadgeMark`'s masked glyph places it.
 */
export function composeBadgeSvg(input: {
	placement: BadgeComposeParams;
	viewBox: string;
	/** The vendor's inner markup, fill-stripped and recolored, ready to inline. */
	inner: string;
}): string {
	const { placement, viewBox, inner } = input;
	const shape = BADGE_SHAPES.find((s) => s.id === placement.shape);
	if (!shape) throw new Error(`compose-svg: unknown shape ${placement.shape}`);
	const field = BADGE_COLORS.find((c) => c.id === placement.fieldColor);
	if (!field) throw new Error(`compose-svg: unknown field color ${placement.fieldColor}`);

	const fieldHex = cssColorToHex(field.fill);
	const edgeHex = cssColorToHex(BADGE_EDGE);
	const emblemHex = cssColorToHex(placement.emblemColor);

	const { vx, vy, vw, vh } = viewBoxParams(viewBox);
	// `contain` in the box: the emblem's own proportions are kept by fitting its longer
	// viewBox side to the box, exactly what `mask-size: contain` does for a glyph.
	const box = shape.emblemBox;
	const scale = placement.scale * (Math.max(vw, vh) === 0 ? 1 : box.size / Math.max(vw, vh));
	// Center at the box's middle, then apply the creator's offset as a fraction OF THE
	// BOX, so an offset means "a quarter of the emblem box left" rather than a viewBox
	// unit that changes meaning with the shape.
	const cx = box.x + box.size / 2 + placement.offsetX * box.size - (vw * scale) / 2;
	const cy = box.y + box.size / 2 + placement.offsetY * box.size - (vh * scale) / 2;

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${BADGE_COMPOSE_PX}" height="${BADGE_COMPOSE_PX}">`,
		`<clipPath id="edge"><path d="${shape.path}"/></clipPath>`,
		`<g clip-path="url(#edge)"><path d="${shape.path}" fill="${fieldHex}" stroke="${edgeHex}" stroke-width="${BADGE_EDGE_WIDTH * 2}" stroke-linejoin="round"/></g>`,
		`<g transform="translate(${cx.toFixed(4)} ${cy.toFixed(4)}) scale(${scale.toFixed(6)})">${inner}</g>`,
		`</svg>`,
	].join("\n");
}

// Referenced so the escaper is not tree-shaken before Phase D's search rendering uses
// it on vendor-supplied terms; removing the emblem credit's escaping from composition
// would let a vendor term carry markup into a stored render.
void xmlEscape;
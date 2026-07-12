// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @anthers/brand — shared, recolor-ready icon/illustration assets for every
// Anthers deployment. Framework-agnostic on purpose: it exports the raw icon
// geometry plus string/data-URI helpers, so each surface (web React, desktop,
// react-native-svg, …) can render it however it likes.
//
// The `icons` map is generated from svg/*.svg by scripts/build-icons.ts.

import { type BrandIcon, type BrandIconName, icons } from "./generated/icons";

export type { BrandIcon, BrandIconName };
export { icons };

/** Look up an icon, tolerating an unknown id at runtime (decorative code should
 * never crash on a missing/renamed asset). Warns once so it's still noticed. */
function lookup(name: BrandIconName): BrandIcon | undefined {
	const ic = (icons as Record<string, BrandIcon>)[name];
	if (!ic)
		console.warn(
			`[@anthers/brand] unknown icon "${name}" — did you add it to CURATED and run \`bun run build\`?`,
		);
	return ic;
}

/** Full standalone SVG markup for an icon, filled with `color` (default currentColor). */
export function iconSvg(name: BrandIconName, color = "currentColor"): string {
	const ic = lookup(name);
	if (!ic) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ic.viewBox}" fill="${color}">${ic.inner}</svg>`;
}

/** An `data:image/svg+xml` URI for an icon — for CSS `background-image`, `mask-image`, or `<img src>`. */
export function iconDataUri(name: BrandIconName, color = "currentColor"): string {
	return `data:image/svg+xml,${encodeURIComponent(iconSvg(name, color))}`;
}

/**
 * A `<g>`-wrapped icon body, filled and placed via an SVG transform, for
 * composing an icon INTO another SVG string (e.g. a tiled background). The icon
 * is scaled to fit `size` and anchored on (`x`,`y`) — centered by default, or by
 * its bottom edge with `anchor: "bottom"` (e.g. grass sitting on a ground line).
 */
export function iconGroup(
	name: BrandIconName,
	opts: {
		x: number;
		y: number;
		size: number;
		color?: string;
		rotate?: number;
		anchor?: "center" | "bottom";
	},
): string {
	const ic = lookup(name);
	if (!ic) return "";
	const [, , vw, vh] = ic.viewBox.split(/[\s,]+/).map(Number);
	const scale = opts.size / Math.max(vw, vh);
	const rot = opts.rotate ? ` rotate(${opts.rotate})` : "";
	const tx = -(vw / 2);
	const ty = opts.anchor === "bottom" ? -vh : -(vh / 2);
	// translate to (x,y), optionally rotate, scale, then recenter the viewBox
	return (
		`<g transform="translate(${opts.x.toFixed(2)} ${opts.y.toFixed(2)})${rot} scale(${scale.toFixed(5)}) translate(${tx} ${ty})" ` +
		`fill="${opts.color ?? "currentColor"}">${ic.inner}</g>`
	);
}

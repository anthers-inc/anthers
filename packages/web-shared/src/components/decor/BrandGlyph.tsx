// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A standalone brand asset, recolored via CSS mask so its color follows `text-*`
// (like `currentColor`). Lets any single-color @anthers/brand SVG be dropped in
// and themed without inlining markup. Size/color via className (h-/w-/text-).
//
// The mask needs `display: inline-block` (or similar) to render the background,
// but hard-coding it as an inline style would override Tailwind's `hidden` and
// responsive `sm:block` / `md:block` utilities — which is exactly how the auth
// page's corner flourishes ended up poking out past the viewport on mobile
// despite being marked `hidden sm:block`. So the display is set by the
// `brand-glyph` class (defined in the shared `theme.css` under `@layer
// components`), which carries the same `inline-block` but yields to a
// same-element `hidden` utility — Tailwind's `.hidden` ships in the
// `utilities` layer, which is declared after `components`, so it wins at
// equal specificity by layer order. The responsive `sm:block` variant
// applies on top inside its `@media`.

import { type BrandIconName, iconDataUri } from "@anthers/brand";

export function BrandGlyph({
	name,
	className,
	style,
}: {
	name: BrandIconName;
	className?: string;
	style?: React.CSSProperties;
}) {
	const url = `url("${iconDataUri(name, "#000")}")`;
	return (
		<span
			aria-hidden="true"
			className={`brand-glyph ${className ?? ""}`}
			style={{
				maskImage: url,
				WebkitMaskImage: url,
				...style,
			}}
		/>
	);
}

export default BrandGlyph;

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A standalone brand asset, recolored via CSS mask so its color follows `text-*`
// (like `currentColor`). Lets any single-color @anthers/brand SVG be dropped in
// and themed without inlining markup. Size/color via className (h-/w-/text-).

import { type BrandIconName, iconDataUri } from "@anthers/brand";

export function BrandGlyph({ name, className }: { name: BrandIconName; className?: string }) {
	const url = `url("${iconDataUri(name, "#000")}")`;
	return (
		<span
			aria-hidden="true"
			className={className}
			style={{
				display: "inline-block",
				backgroundColor: "currentColor",
				maskImage: url,
				WebkitMaskImage: url,
				maskRepeat: "no-repeat",
				WebkitMaskRepeat: "no-repeat",
				maskPosition: "center",
				WebkitMaskPosition: "center",
				maskSize: "contain",
				WebkitMaskSize: "contain",
			}}
		/>
	);
}

export default BrandGlyph;

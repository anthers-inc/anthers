// SPDX-License-Identifier: AGPL-3.0-or-later
//
// <MeadowDecor> — the shared botanical decoration layer for Meadow-themed pages.
// Wraps its children with the pollen-textured base surface, the woven climbing
// side vines (wide screens only), and (optionally) the grassy floor the vines
// spring from, all in the correct z-order:
//
//   vines  z-20  — in front of section overlays, so they hold full brightness
//   content z-10 — the page
//   grass   z-30 — springs the vine bases from the floor (when `floor`)
//
// `floor` (default true) draws the grass at the bottom of this container. Set it
// false when the grass lives elsewhere — e.g. under the shared site footer, so the
// footer sits between the content and the meadow (see MeadowFloor + LoggedOutLayout).
// Baked decor colors come from ./meadowColors (they track theme.css's palette).

import {
	pollenDataUri,
	VINE_WAVES,
	VINE_WEAVES,
	type VineStyle,
	vineTileDataUri,
	wovenVineTileDataUri,
} from "@anthers/brand";
import { MeadowFloor } from "./MeadowFloor";
import { decorColors } from "./meadowColors";

export function MeadowDecor({
	mode = "dark",
	vine = "triple",
	floor = true,
	className = "",
	style,
	children,
}: {
	mode?: "light" | "dark";
	/** single meandering strand, or a woven preset (braid/helix/triple/twin) */
	vine?: VineStyle;
	/** draw the grassy floor at the bottom of this container (default true) */
	floor?: boolean;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
}) {
	const c = decorColors(mode);

	// "Pollen in the air" over the base surface (the base itself stays a live CSS var
	// so it follows whatever palette scope this lands in).
	const pollen = `url("${pollenDataUri(c.pollen, c.pollenScale)}") repeat, var(--color-base-100)`;

	// Dainty climbing vine(s) with soft-yellow blooms + amber bees, scrolling with the
	// page and springing from the grass. `vine` picks one strand or several woven.
	const vineColors = { stem: c.stem, flower: c.flower, bee: c.accent };
	const vineUri =
		vine === "single"
			? vineTileDataUri(vineColors, VINE_WAVES.calm)
			: wovenVineTileDataUri({ ...vineColors, casing: c.casing }, VINE_WEAVES[vine]);
	const vineStyle: React.CSSProperties = {
		backgroundImage: `url("${vineUri}")`,
		backgroundRepeat: "repeat-y",
		backgroundSize: "100% auto",
		backgroundPosition: "center top",
		opacity: c.vineOpacity,
	};

	return (
		<div
			className={`relative min-h-screen overflow-hidden text-base-content ${className}`}
			style={{ background: pollen, ...style }}
		>
			{/* Flowering side vines — woven strands that scroll with the page and spring
				from the grass floor; frame the centered content on wide screens */}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-28 xl:block"
				style={vineStyle}
			/>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 right-0 z-20 hidden w-28 -scale-x-100 xl:block"
				style={vineStyle}
			/>

			<div className="relative z-10">{children}</div>

			{floor && <MeadowFloor mode={mode} />}
		</div>
	);
}

export default MeadowDecor;

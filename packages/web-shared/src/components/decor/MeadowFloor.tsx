// SPDX-License-Identifier: AGPL-3.0-or-later
//
// <MeadowFloor> — the grassy/flowery floor band with a few bees drifting above it.
// A `h-56` strip meant to sit at the very bottom of a page: inside <MeadowDecor>
// (where the side vines spring from it), or on its own under the site footer so
// every marketing page ends on the same meadow. Colors are baked per mode (see
// meadowColors); the tile is nudged down 6px so the blade bases sit just below the
// clip edge (no gap).

import { grassFloorDataUri } from "@anthers/brand";
import { BrandGlyph } from "./BrandGlyph";
import { decorColors } from "./meadowColors";

export function MeadowFloor({
	mode = "dark",
	className = "",
}: {
	mode?: "light" | "dark";
	className?: string;
}) {
	const c = decorColors(mode);
	const floorStyle: React.CSSProperties = {
		backgroundImage: `url("${grassFloorDataUri({
			grass: c.stem,
			flower: c.flower,
			core: c.accent,
		})}")`,
		backgroundRepeat: "repeat-x",
		backgroundSize: "auto 100%",
		backgroundPosition: "left calc(100% + 6px)",
		opacity: c.floorOpacity,
	};
	return (
		<div aria-hidden="true" className={`pointer-events-none relative z-30 h-56 ${className}`}>
			<div className="absolute inset-0" style={floorStyle} />
			<BrandGlyph
				name="bee-flying"
				className="absolute left-[10%] top-3 h-7 w-7 -rotate-12 text-accent/85"
			/>
			<BrandGlyph
				name="bee"
				className="absolute left-[27%] top-9 h-5 w-5 rotate-6 text-accent/70"
			/>
			<BrandGlyph
				name="bee-flying"
				className="absolute left-[47%] top-1.5 h-6 w-6 rotate-12 text-accent/80"
			/>
			<BrandGlyph
				name="bee"
				className="absolute left-[64%] top-8 h-5 w-5 -rotate-6 text-accent/75"
			/>
			<BrandGlyph
				name="bee-flying"
				className="absolute right-[9%] top-4 h-7 w-7 -rotate-12 text-accent/85"
			/>
		</div>
	);
}

export default MeadowFloor;

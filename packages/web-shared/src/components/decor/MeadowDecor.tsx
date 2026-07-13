// SPDX-License-Identifier: AGPL-3.0-or-later
//
// <MeadowDecor> — the shared botanical decoration layer for Meadow-themed pages.
// Wraps its children with the pollen-textured base surface, the woven climbing
// side vines (wide screens only), and the grassy/flowery floor the vines spring
// from, all in the correct z-order:
//
//   vines  z-20  — in front of section overlays, so they hold full brightness
//   content z-10 — the page
//   grass   z-30 — springs the vine bases from the floor; a few bees drift above
//
// The SVG generators bake colors into the image (a background can't inherit
// `currentColor`), so the decor colors are concrete constants keyed by `mode`.
// They track the Meadow palette in packages/web-shared/src/styles/theme.css —
// keep them in sync (the only value read live from the theme is the base-100
// surface behind the pollen, via `var(--color-base-100)`, so it follows scope).

import {
	grassFloorDataUri,
	pollenDataUri,
	VINE_WAVES,
	VINE_WEAVES,
	type VineStyle,
	vineTileDataUri,
	wovenVineTileDataUri,
} from "@anthers/brand";
import { BrandGlyph } from "./BrandGlyph";

type DecorColors = {
	/** pollen mote color + its opacity scale (quieter on the darker surface) */
	pollen: string;
	pollenScale: number;
	/** vine + grass stem (primary), bloom (secondary), bee/flower-core (accent) */
	stem: string;
	flower: string;
	accent: string;
	/** woven-vine casing = the base surface, so crossings read as over/under gaps */
	casing: string;
	vineOpacity: number;
	floorOpacity: number;
};

const DARK: DecorColors = {
	pollen: "oklch(68% 0.1 95)",
	pollenScale: 0.5,
	stem: "oklch(75% 0.15 150)",
	flower: "oklch(86% 0.13 94)",
	accent: "oklch(79% 0.13 76)",
	casing: "oklch(17% 0.017 158)",
	vineOpacity: 0.72,
	floorOpacity: 0.48,
};

const LIGHT: DecorColors = {
	pollen: "oklch(72% 0.12 92)",
	pollenScale: 1,
	stem: "oklch(49% 0.11 152)",
	flower: "oklch(84% 0.13 92)",
	accent: "oklch(69% 0.14 74)",
	casing: "oklch(98.6% 0.012 96)",
	vineOpacity: 0.62,
	floorOpacity: 0.6,
};

export function MeadowDecor({
	mode = "dark",
	vine = "triple",
	className = "",
	style,
	children,
}: {
	mode?: "light" | "dark";
	/** single meandering strand, or a woven preset (braid/helix/triple/twin) */
	vine?: VineStyle;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
}) {
	const c = mode === "light" ? LIGHT : DARK;

	// "Pollen in the air" over the base surface (the base itself stays a live CSS var
	// so it follows whatever palette scope this lands in).
	const pollen = pollenDataUri(c.pollen, c.pollenScale);
	const bg = `url("${pollen}") repeat, var(--color-base-100)`;

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

	// Grassy/flowery floor, tiled across the bottom and nudged down so the blade bases
	// sit just below the page edge (no gap).
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
		<div
			className={`relative min-h-screen overflow-hidden text-base-content ${className}`}
			style={{ background: bg, ...style }}
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

			{/* Grassy floor across the very bottom, sitting below the content so it stays
				readable; the side vines spring from it and a few bees drift above the tops */}
			<div aria-hidden="true" className="pointer-events-none relative z-30 h-56">
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
		</div>
	);
}

export default MeadowDecor;

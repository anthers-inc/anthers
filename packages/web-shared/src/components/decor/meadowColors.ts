// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Baked decor colors for the Meadow botanical layer, keyed by light/dark. The SVG
// generators (vines, grass, pollen) bake colors into the image — a background
// can't inherit `currentColor` — so these are concrete strings. They TRACK the
// Meadow palette in ../../styles/theme.css; keep them in sync. (The only value
// read live from the theme is the base-100 surface behind the pollen, via
// `var(--color-base-100)`, so it follows whatever scope the decor lands in.)
// Shared by <MeadowDecor> (pollen + vines + floor) and <MeadowFloor> (the floor
// alone, used under the site footer).

export type DecorColors = {
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

export const DARK: DecorColors = {
	pollen: "oklch(68% 0.1 95)",
	pollenScale: 0.5,
	stem: "oklch(75% 0.15 150)",
	flower: "oklch(86% 0.13 94)",
	accent: "oklch(79% 0.13 76)",
	casing: "oklch(17% 0.017 158)",
	vineOpacity: 0.72,
	floorOpacity: 0.48,
};

export const LIGHT: DecorColors = {
	pollen: "oklch(72% 0.12 92)",
	pollenScale: 1,
	stem: "oklch(49% 0.11 152)",
	flower: "oklch(84% 0.13 92)",
	accent: "oklch(69% 0.14 74)",
	casing: "oklch(98.6% 0.012 96)",
	vineOpacity: 0.62,
	floorOpacity: 0.6,
};

/** Pick the decor color set for a mode. */
export const decorColors = (mode: "light" | "dark"): DecorColors =>
	mode === "light" ? LIGHT : DARK;

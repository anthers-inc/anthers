// SPDX-License-Identifier: Apache-2.0
//
// Baked decor colors for the botanical layer, per palette family and variant. The SVG
// generators (vines, grass, pollen) bake colors into the image — a background can't
// inherit `currentColor` — so these are concrete strings. They TRACK the palette blocks
// in ../../styles/theme.css; keep them in sync. (The only value read live from the theme
// is the base-100 surface behind the pollen, via `var(--color-base-100)`, so it follows
// whatever family scope the decor lands in.)
//
// ⭐ Every family gets its own set rather than inheriting Meadow's green: the marketing
// pages render the decor behind Reef, Ember and Heather too, and green vines under a
// coral or a plum palette read as a mistake. The role mapping stays Meadow's — stem is
// primary, bloom is a lighter secondary, and the bee/flower-core is accent — so the
// botanical layer recolors with the same rhythm the rest of the UI keeps.
//
// Shared by <MeadowDecor> (pollen + vines + floor), <MeadowFloor> (the floor alone), and
// <MeadowBackdrop> (the signed-in shell's quiet layer).

import { type Theme, type ThemeGroup, themeFamily, themeVariant } from "../../lib/theme";

export type DecorColors = {
	/** pollen mote color + its opacity scale (quieter on the darker surface) */
	pollen: string;
	pollenScale: number;
	/** vine stem (primary), bloom (secondary), bee/flower-core (accent) */
	stem: string;
	flower: string;
	accent: string;
	/** grass-blade color for the floor band (darker than the vine stem) */
	grass: string;
	/** woven-vine casing = the base surface, so crossings read as over/under gaps */
	casing: string;
	vineOpacity: number;
	floorOpacity: number;
};

export type DecorFamily = "meadow" | "reef" | "ember" | "heather";

const MEADOW: Record<ThemeGroup, DecorColors> = {
	Light: {
		pollen: "oklch(72% 0.12 92)",
		pollenScale: 1.4,
		stem: "oklch(0.486 0.106 152.671)",
		flower: "oklch(84% 0.13 92)",
		accent: "oklch(69% 0.14 74)",
		grass: "oklch(0.486 0.106 152.671)",
		casing: "oklch(98.6% 0.012 96)",
		vineOpacity: 0.62,
		floorOpacity: 1,
	},
	Dark: {
		pollen: "oklch(68% 0.1 95)",
		pollenScale: 0.35,
		stem: "oklch(66% 0.11 152)",
		flower: "oklch(71% 0.13 92)",
		accent: "oklch(76% 0.12 76)",
		grass: "oklch(38% 0.063 152)",
		casing: "oklch(16.5% 0.019 158)",
		vineOpacity: 0.72,
		floorOpacity: 1,
	},
};

const REEF: Record<ThemeGroup, DecorColors> = {
	Light: {
		pollen: "oklch(78% 0.06 200)",
		pollenScale: 1.25,
		stem: "oklch(44% 0.09 245)",
		flower: "oklch(74% 0.09 200)",
		accent: "oklch(55% 0.16 32)",
		grass: "oklch(38% 0.075 245)",
		casing: "oklch(97.8% 0.012 210)",
		vineOpacity: 0.55,
		floorOpacity: 1,
	},
	Dark: {
		pollen: "oklch(72% 0.07 200)",
		pollenScale: 0.35,
		stem: "oklch(72% 0.1 235)",
		flower: "oklch(74% 0.09 195)",
		accent: "oklch(70% 0.14 34)",
		grass: "oklch(34% 0.05 245)",
		casing: "oklch(17.5% 0.022 245)",
		vineOpacity: 0.68,
		floorOpacity: 1,
	},
};

const EMBER: Record<ThemeGroup, DecorColors> = {
	Light: {
		pollen: "oklch(76% 0.1 58)",
		pollenScale: 1.2,
		stem: "oklch(45% 0.15 28)",
		flower: "oklch(72% 0.12 58)",
		accent: "oklch(52% 0.1 18)",
		grass: "oklch(38% 0.11 28)",
		casing: "oklch(97% 0.01 55)",
		vineOpacity: 0.5,
		floorOpacity: 1,
	},
	Dark: {
		pollen: "oklch(72% 0.1 58)",
		pollenScale: 0.35,
		stem: "oklch(66% 0.14 32)",
		flower: "oklch(74% 0.12 58)",
		accent: "oklch(68% 0.1 18)",
		grass: "oklch(33% 0.07 30)",
		casing: "oklch(16.5% 0.014 30)",
		vineOpacity: 0.62,
		floorOpacity: 1,
	},
};

const HEATHER: Record<ThemeGroup, DecorColors> = {
	Light: {
		pollen: "oklch(80% 0.06 330)",
		pollenScale: 1.2,
		stem: "oklch(47% 0.11 310)",
		flower: "oklch(76% 0.07 340)",
		accent: "oklch(54% 0.15 350)",
		grass: "oklch(40% 0.08 310)",
		casing: "oklch(97.8% 0.012 310)",
		vineOpacity: 0.55,
		floorOpacity: 1,
	},
	Dark: {
		pollen: "oklch(74% 0.07 330)",
		pollenScale: 0.35,
		stem: "oklch(72% 0.1 310)",
		flower: "oklch(76% 0.07 340)",
		accent: "oklch(70% 0.14 350)",
		grass: "oklch(34% 0.05 310)",
		casing: "oklch(18% 0.024 315)",
		vineOpacity: 0.68,
		floorOpacity: 1,
	},
};

const DECOR: Record<DecorFamily, Record<ThemeGroup, DecorColors>> = {
	meadow: MEADOW,
	reef: REEF,
	ember: EMBER,
	heather: HEATHER,
};

/** The decor family a theme belongs to, keyed by the catalog's family label. */
function decorFamily(theme: Theme): DecorFamily {
	const label = themeFamily(theme).toLowerCase();
	return label === "reef" || label === "ember" || label === "heather" ? label : "meadow";
}

/**
 * The baked colors for a theme. `variant` forces the other variant of the same family,
 * for a surface that must stay light (or dark) whatever the live theme is.
 */
export function decorColors(theme: Theme, variant?: ThemeGroup): DecorColors {
	return DECOR[decorFamily(theme)][variant ?? themeVariant(theme)];
}

/** A component's lowercase forced mode, as the catalog's variant. */
export function decorVariant(mode?: "light" | "dark"): ThemeGroup | undefined {
	return mode === "dark" ? "Dark" : mode === "light" ? "Light" : undefined;
}

// 🚨 The pollen/vine/grass colors above are tuned to sit quietly on the ground each
// family's theme.css block paints — the dark sets track the darker base ramp rather than
// the light ones, so a palette change on either side has to move both.

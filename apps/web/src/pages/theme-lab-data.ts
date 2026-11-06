// SPDX-License-Identifier: Apache-2.0
//
// The theme study's catalog. These are candidates rather than shipped themes: their
// palettes live in `packages/web-shared/src/styles/theme-candidates.css`, scoped by a
// `data-theme` value, and nothing outside the study renders them. Meadow is kept in
// the list so a candidate can be read against the palette the site actually uses.
//
// Names follow the rule the brief set: one piece of nature, one family, both variants
// sharing the name. A family's stored values are `<slug>-light` and `<slug>-dark`.

export type LabVariant = "light" | "dark";

export interface LabFamily {
	/** Stable name for the palette blocks — never user-facing. */
	slug: string;
	/** The name the study (and a future picker) shows. */
	name: string;
	/** One sentence on what the palette is made of. */
	concept: string;
	/** True for Meadow, the palette the site ships today. */
	current?: boolean;
}

export const LAB_FAMILIES: readonly LabFamily[] = [
	{
		slug: "canyon",
		name: "Canyon",
		concept: "Sun-baked sandstone and terracotta, with a river blue pulled from the canyon floor.",
	},
	{
		slug: "tidepool",
		name: "Tidepool",
		concept: "Deep ocean blue and sea glass, with coral warm enough to keep it alive.",
	},
	{
		slug: "heather",
		name: "Heather",
		concept: "Moorland violet and dusty rose, softer than Meadow but just as calm.",
	},
	{
		slug: "glacier",
		name: "Glacier",
		concept: "Pale ice and steel blue, almost colorless, with a cold cyan edge.",
	},
	{
		slug: "ember",
		name: "Ember",
		concept: "Burnt red and warm charcoal, the palette of a fire settling for the night.",
	},
	{
		slug: "wildrose",
		name: "Wildrose",
		concept: "Rose and berry pink, warm without turning sweet.",
	},
] as const;

/** Meadow, the current palette, rendered through its real `light`/`dark` values. */
export const CURRENT_FAMILY: LabFamily = {
	slug: "meadow",
	name: "Meadow",
	concept: "The palette the site uses today: green ink, cream ground, soft yellow and amber.",
	current: true,
};

/** Every family the full-page view can show, current palette first. */
export const FOCUS_FAMILIES: readonly LabFamily[] = [CURRENT_FAMILY, ...LAB_FAMILIES];

/**
 * The `data-theme` value for a family and variant. Meadow predates the family scheme
 * and keeps its real `light`/`dark` values, which is what a candidate joins when it
 * is promoted into the catalog.
 */
export function themeValue(family: LabFamily, variant: LabVariant): string {
	return family.current ? variant : `${family.slug}-${variant}`;
}

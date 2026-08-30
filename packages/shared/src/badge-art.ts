// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a Badge is made of — the standard library a creator mixes and matches from.
 *
 * ⭐ **Three layers, and the point of the middle one is flexibility without inconsistency**
 * (Parker, 2026-08-29). A badge is Anthers' round botanical **frame**, a **background** of a
 * shape and a color chosen from this library, and a **foreground** that is either another
 * piece of the library or the creator's own art. So a creator who does not draw still gets a
 * badge that is recognizably theirs — shape, color and emblem are three choices, not one
 * upload they cannot make — and a creator who does draw puts their art on a consistent
 * ground rather than inventing the whole object.
 *
 * 🚨 **The lists live here rather than in the web app, because the API validates against
 * them.** A shape or color the server does not recognize is refused rather than stored, and
 * a second copy of these ids in a component would drift from the copy the server checks —
 * at which point a creator's saved choice renders as nothing and no error says why.
 *
 * ⚠️ **Colors are fixed values rather than theme tokens, deliberately.** A badge is an
 * identity object that people collect across creators, and one that changed color with the
 * viewer's light/dark preference would not be the same badge twice. The frame around it is
 * still theme-aware; what a creator picked is not.
 */

/** A background shape, as a path in a 0 0 100 100 viewBox. */
export interface BadgeShape {
	id: string;
	label: string;
	path: string;
}

/**
 * The shapes. Deliberately few — a library a creator can hold in their head beats one they
 * have to scroll, and every one of these has to read at 24 pixels as well as at 512.
 */
export const BADGE_SHAPES: BadgeShape[] = [
	{ id: "circle", label: "Circle", path: "M50 4a46 46 0 1 0 0 92a46 46 0 1 0 0-92Z" },
	{
		id: "rounded",
		label: "Rounded square",
		path: "M26 6h48a20 20 0 0 1 20 20v48a20 20 0 0 1-20 20H26A20 20 0 0 1 6 74V26A20 20 0 0 1 26 6Z",
	},
	{
		id: "hexagon",
		label: "Hexagon",
		path: "M50 4 90 27v46L50 96 10 73V27Z",
	},
	{
		id: "shield",
		label: "Shield",
		path: "M50 5 90 18v34c0 24-17 38-40 43C27 90 10 76 10 52V18Z",
	},
	{
		id: "petal",
		label: "Petal",
		path: "M50 5c14 0 25 11 25 25 14 0 25 11 25 25s-11 25-25 25c0 14-11 20-25 20s-25-6-25-20C11 80 0 69 0 55s11-25 25-25C25 16 36 5 50 5Z",
	},
	{
		id: "seed",
		label: "Seed",
		path: "M50 4c26 0 46 20 46 46 0 26-20 46-46 46S4 76 4 50C4 24 24 4 50 4Zm0 14c-8 12-8 52 0 64 8-12 8-52 0-64Z",
	},
];

export interface BadgeColor {
	id: string;
	label: string;
	/** The background fill. */
	fill: string;
	/** What reads against it — the foreground emblem's color. */
	on: string;
}

/**
 * The colors, drawn from the Meadow palette's own hues so a creator's badge sits beside
 * Anthers' own rather than beside it.
 */
export const BADGE_COLORS: BadgeColor[] = [
	{ id: "moss", label: "Moss", fill: "oklch(49% 0.11 152)", on: "oklch(98% 0.02 110)" },
	{ id: "meadow", label: "Meadow", fill: "oklch(73% 0.14 150)", on: "oklch(24% 0.05 150)" },
	{ id: "sun", label: "Sun", fill: "oklch(84% 0.13 92)", on: "oklch(32% 0.06 88)" },
	{ id: "amber", label: "Amber", fill: "oklch(69% 0.14 74)", on: "oklch(24% 0.05 74)" },
	{ id: "clay", label: "Clay", fill: "oklch(62% 0.13 40)", on: "oklch(98% 0.02 60)" },
	{ id: "dusk", label: "Dusk", fill: "oklch(45% 0.09 280)", on: "oklch(97% 0.02 280)" },
	{ id: "slate", label: "Slate", fill: "oklch(52% 0.02 240)", on: "oklch(98% 0.01 240)" },
	{ id: "cream", label: "Cream", fill: "oklch(94% 0.03 95)", on: "oklch(32% 0.06 120)" },
];

/**
 * The foreground emblems from the standard library.
 *
 * These are `BrandIconName`s, typed as plain strings here so `@anthers/shared` does not
 * depend on the browser-facing brand package — the API validates the id and never renders
 * it, and the web layer resolves it against `@anthers/brand`. ⚠️ A name added here that the
 * brand package does not carry renders as nothing, so the two are asserted against each
 * other in a test rather than trusted.
 */
export const BADGE_EMBLEMS: string[] = [
	"bloom-round",
	"bloom-tulip",
	"bloom-cluster",
	"grass-clump",
	"grass-cattail",
	"grass-reed",
	"grass-tall",
	"bee",
	"bee-flying",
	"wreath",
];

export const DEFAULT_BADGE_SHAPE = "circle";
export const DEFAULT_BADGE_COLOR = "moss";

export function isBadgeShape(id: unknown): boolean {
	return typeof id === "string" && BADGE_SHAPES.some((s) => s.id === id);
}

export function isBadgeColor(id: unknown): boolean {
	return typeof id === "string" && BADGE_COLORS.some((c) => c.id === id);
}

export function isBadgeEmblem(id: unknown): boolean {
	return typeof id === "string" && BADGE_EMBLEMS.includes(id);
}

export function badgeShape(id: string | null | undefined): BadgeShape {
	return BADGE_SHAPES.find((s) => s.id === id) ?? BADGE_SHAPES[0];
}

export function badgeColor(id: string | null | undefined): BadgeColor {
	return BADGE_COLORS.find((c) => c.id === id) ?? BADGE_COLORS[0];
}

/**
 * The emblem a rung falls back to when the creator has chosen nothing.
 *
 * ⚠️ **Keyed on ladder POSITION, and it wraps.** A creator may have more rungs than there
 * are emblems, and repricing a rung must not change its picture — keying on the index keeps
 * a ladder visually distinct rung to rung and stable under a price change, which is the
 * pair of properties that actually matter.
 */
export function defaultBadgeEmblem(index: number): string {
	const n = BADGE_EMBLEMS.length;
	return BADGE_EMBLEMS[((index % n) + n) % n];
}

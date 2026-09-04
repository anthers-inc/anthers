// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a Badge is made of — the standard library a creator mixes and matches from.
 *
 * ⭐ **Two layers, and the point of the library is flexibility without inconsistency**
 * (Parker, 2026-08-29). A badge is a **background** of a shape and a color chosen from here,
 * and a **foreground** that is either another piece of the library or the creator's own art.
 * So a creator who does not draw still gets a badge that is recognizably theirs — shape,
 * color and emblem are three choices, not one upload they cannot make — and a creator who
 * does draw puts their art on a consistent ground rather than inventing the whole object.
 *
 * ⚠️ **There is no frame, and the shapes here are not drawn to sit inside one.** The
 * background's silhouette is the badge's silhouette; `BadgeMark` carries why a wrapping
 * frame was removed rather than kept.
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

/**
 * The edging every badge wears, whatever its shape or field color.
 *
 * ⭐ **This is the whole of what makes a wall of badges read as one collection** (Parker's
 * scout-badge reference, 2026-08-29). A Girl Scout set is triangles and squares in wildly
 * different field colors, and it reads as a set because every one of them is bound in the
 * same brown stitching. So the edge is a constant and the field is the creator's — the
 * reverse of the first cut here, which derived the rim from the fill and got no shared
 * identity out of it at all.
 *
 * ⚠️ **Not a token that follows the theme.** A badge is an identity object people collect
 * across creators; one whose edging changed with the viewer's light/dark preference would
 * not be the same badge twice.
 */
export const BADGE_EDGE = "oklch(34% 0.05 55)";

/** How thick that edging is, in viewBox units, painted inward from the shape's outline. */
export const BADGE_EDGE_WIDTH = 9;

/**
 * A square region of the viewBox, as `x`/`y`/`size` in the same 0-100 units the paths use.
 *
 * ⭐ **Square rather than free-form, because every foreground is fitted into it rather than
 * stretched to it.** An emblem is masked with `mask-size: contain`, an upload is
 * `object-cover`, and an emoji is one glyph — so all three keep their own proportions and
 * only need to be told how much room they have and where it is. A rectangle would imply a
 * distortion none of them perform.
 */
export interface BadgeBox {
	x: number;
	y: number;
	size: number;
}

/** A background shape, as a path in a 0 0 100 100 viewBox. */
export interface BadgeShape {
	id: string;
	label: string;
	path: string;
	/**
	 * Where an UNCROPPED foreground sits — a library emblem, or Anthers' emoji.
	 *
	 * This is the largest square that clears the edging, so a drawing placed in it touches
	 * the stitching nowhere no matter what it is. That is why a triangle's is small and low
	 * while a circle's is large and central: it is the shape's own usable middle rather than
	 * a fixed fraction of the badge.
	 */
	emblemBox: BadgeBox;
	/**
	 * Where a SHAPE-CROPPED foreground sits — a creator's own upload.
	 *
	 * ⭐ **Bigger than `emblemBox`, and the difference is not an inconsistency.** An upload
	 * is clipped to the badge's own silhouette, so it wears the shape instead of having to
	 * fit inside it, and it can run out to a thin ring of visible field the way artwork is
	 * sewn onto a patch. A line drawing given the same room would collide with the edging.
	 */
	artBox: BadgeBox;
}

/**
 * The shapes. Deliberately few — a library a creator can hold in their head beats one they
 * have to scroll, and every one of these has to read at 24 pixels as well as at 512.
 *
 * ⭐ **Every shape carries its own foreground boxes, and that is what makes the art size
 * itself.** `BadgeMark` places a foreground by these numbers rather than by a percentage of
 * the badge, so an emblem we ship, an emblem a creator picks and a file a creator uploads
 * are all fitted to the shape they are actually sitting on — and adding a shape means
 * measuring it once here rather than special-casing it at the call sites.
 *
 * ⚠️ **The boxes are derived from the path eroded by `BADGE_EDGE_WIDTH`, not eyeballed.**
 * A path edited without recomputing them puts art under the stitching, and nothing fails —
 * it just looks wrong, which is the failure this file is least able to notice.
 *
 * ⚠️ **No `emblemBox` exceeds the circle's**, even where the shape could hold more (a
 * rounded square's inscribed square is nearer 64). A ladder reads as a set when its emblems
 * are one size and its fields differ, which is the same reasoning that makes the edging a
 * constant — an emblem that grew with the roominess of its shape would make the rungs look
 * mismatched rather than varied.
 */
export const BADGE_SHAPES: BadgeShape[] = [
	{
		id: "circle",
		label: "Circle",
		path: "M50 4a46 46 0 1 0 0 92a46 46 0 1 0 0-92Z",
		// Field radius 37 (46 less the 9 of edging), so the inscribed square is 52.3 a side.
		emblemBox: { x: 24, y: 24, size: 52 },
		artBox: { x: 16, y: 16, size: 68 },
	},
	{
		id: "triangle",
		label: "Triangle",
		path: "M50 5 97 88a6 6 0 0 1-5 9H8a6 6 0 0 1-5-9Z",
		// A triangle's room is low and narrow: the apex erodes to y≈25, and the widest square
		// that clears both slanted edges sits against the base.
		emblemBox: { x: 34, y: 56, size: 32 },
		artBox: { x: 20, y: 28, size: 60 },
	},
	{
		id: "triangle-down",
		label: "Inverted triangle",
		path: "M8 3h84a6 6 0 0 1 5 9l-42 83a6 6 0 0 1-10 0L3 12a6 6 0 0 1 5-9Z",
		emblemBox: { x: 34, y: 12, size: 32 },
		artBox: { x: 20, y: 15, size: 60 },
	},
	{
		id: "rounded",
		label: "Rounded square",
		path: "M26 6h48a20 20 0 0 1 20 20v48a20 20 0 0 1-20 20H26A20 20 0 0 1 6 74V26A20 20 0 0 1 26 6Z",
		emblemBox: { x: 24, y: 24, size: 52 },
		artBox: { x: 16, y: 16, size: 68 },
	},
	{
		id: "hexagon",
		label: "Hexagon",
		path: "M50 4 90 27v46L50 96 10 73V27Z",
		// The upper corners are what bind here, not the flat sides.
		emblemBox: { x: 27, y: 28, size: 45 },
		artBox: { x: 17, y: 17, size: 66 },
	},
	{
		id: "shield",
		label: "Shield",
		path: "M50 5 90 18v34c0 24-17 38-40 43C27 90 10 76 10 52V18Z",
		// Sits above center, because a shield's mass is in its shoulders and it tapers away
		// under them.
		emblemBox: { x: 27, y: 23, size: 46 },
		artBox: { x: 18, y: 18, size: 64 },
	},
	{
		id: "petal",
		label: "Petal",
		path: "M50 5c14 0 25 11 25 25 14 0 25 11 25 25s-11 25-25 25c0 14-11 20-25 20s-25-6-25-20C11 80 0 69 0 55s11-25 25-25C25 16 36 5 50 5Z",
		// Four lobes around a narrow waist: the notches between them, not the outline, are
		// what an emblem has to clear.
		emblemBox: { x: 32, y: 35, size: 37 },
		artBox: { x: 15, y: 17, size: 70 },
	},
	{
		id: "seed",
		label: "Seed",
		path: "M50 4c26 0 46 20 46 46 0 26-20 46-46 46S4 76 4 50C4 24 24 4 50 4Zm0 14c-8 12-8 52 0 64 8-12 8-52 0-64Z",
		emblemBox: { x: 24, y: 24, size: 52 },
		artBox: { x: 16, y: 16, size: 68 },
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
 *
 * ⭐ **Muted rather than bright, so the emblem is the thing you look at** (Parker,
 * 2026-09-04). A badge is a small object carrying a picture, and a field at full chroma
 * competes with the picture on it — the ladder read as four colored discs with something
 * in the middle rather than four emblems. These sit roughly eight points of lightness and
 * a third of the chroma below where they started.
 *
 * ⚠️ **The floor is the edging, not taste.** `BADGE_EDGE` is 34% lightness and it has to
 * stay visible as a ring against every one of these, so no field goes far below 45% —
 * which is why `moss` and `dusk` mostly lost chroma while `meadow` and `sun`, with room
 * above them, lost real lightness.
 */
export const BADGE_COLORS: BadgeColor[] = [
	{ id: "moss", label: "Moss", fill: "oklch(46% 0.08 152)", on: "oklch(98% 0.02 110)" },
	{ id: "meadow", label: "Meadow", fill: "oklch(63% 0.09 150)", on: "oklch(24% 0.05 150)" },
	{ id: "sun", label: "Sun", fill: "oklch(74% 0.09 92)", on: "oklch(32% 0.06 88)" },
	{ id: "amber", label: "Amber", fill: "oklch(61% 0.10 74)", on: "oklch(24% 0.05 74)" },
	{ id: "clay", label: "Clay", fill: "oklch(54% 0.09 40)", on: "oklch(98% 0.02 60)" },
	{ id: "dusk", label: "Dusk", fill: "oklch(45% 0.065 280)", on: "oklch(97% 0.02 280)" },
	{ id: "slate", label: "Slate", fill: "oklch(48% 0.015 240)", on: "oklch(98% 0.01 240)" },
	{ id: "cream", label: "Cream", fill: "oklch(88% 0.025 95)", on: "oklch(32% 0.06 120)" },
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

/**
 * One of the boxes above as CSS percentages, for a foreground laid over the badge.
 *
 * 🚨 **Percentages of the badge, never a length.** The viewBox units and the badge's
 * rendered size are the same scale expressed two ways, so a box stated as a percentage
 * follows the badge from a 24-pixel chip to a 512-pixel patch with nothing recomputing it.
 * A foreground sized in any absolute unit is the bug this replaced: `font-size: 46%` reads
 * as a share of the INHERITED FONT rather than of the badge, so Anthers' emoji rungs drew
 * at about seven pixels whatever size the badge was, and grew not at all when it grew.
 */
export function badgeBoxStyle(box: BadgeBox): {
	left: string;
	top: string;
	width: string;
	height: string;
} {
	return {
		left: `${box.x}%`,
		top: `${box.y}%`,
		width: `${box.size}%`,
		height: `${box.size}%`,
	};
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

/**
 * The field color a rung falls back to, by ladder position.
 *
 * ⭐ **Varied rather than uniform, for the same reason the emblem is.** A creator who has
 * touched nothing should see a ladder of distinct patches — which is what a scout set looks
 * like — rather than five identical discs that only differ if you look closely. A default
 * that reads as a set is doing the job; a default that reads as "unset" is not.
 *
 * ⚠️ **Stepped by a stride that is coprime with the list length**, so consecutive rungs land
 * far apart in the palette instead of on neighboring greens.
 */
export function defaultBadgeColor(index: number): string {
	const n = BADGE_COLORS.length;
	return BADGE_COLORS[(((index * 3) % n) + n) % n].id;
}

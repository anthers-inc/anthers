// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The badge library has to agree with itself across three packages.
 *
 * 🚨 **`@anthers/shared` names the emblems and `@anthers/brand` draws them**, and the split
 * is deliberate — the API validates a creator's choice and must not depend on a
 * browser-facing package to do it. The cost of that split is that the two lists can
 * disagree, and the failure is silent in the worst way: the server stores an id it was
 * happy with, the browser asks the brand package for an icon that is not there, and the
 * creator's badge renders as an empty frame with nothing anywhere saying why.
 *
 * ⚠️ **Which is why this is a test rather than a comment.** `iconSvg` warns once on an
 * unknown name and returns an empty `<svg>`, so nothing throws and nothing fails.
 */
import { describe, expect, it } from "bun:test";
import { icons } from "@anthers/brand";
import {
	BADGE_COLORS,
	BADGE_EMBLEMS,
	BADGE_SHAPES,
	type BadgeColor,
	badgeBoxStyle,
	badgeColor,
	badgeShape,
	DEFAULT_BADGE_COLOR,
	DEFAULT_BADGE_SHAPE,
	defaultBadgeColor,
	defaultBadgeEmblem,
	isBadgeColor,
	isBadgeEmblem,
	isBadgeShape,
} from "@anthers/shared/badge-art";
import type { Badge } from "@anthers/shared/constants";
import { BADGE_ORDER } from "@anthers/shared/constants";
import { BADGE_ART } from "./economics";

describe("the badge library", () => {
	it("🚨 names only emblems the brand package can actually draw", () => {
		const missing = BADGE_EMBLEMS.filter((name) => !(name in icons));
		expect(
			missing,
			"these are offered to creators and stored by the API, and render as nothing",
		).toEqual([]);
	});

	it("draws every shape it offers, as a closed path", () => {
		for (const shape of BADGE_SHAPES) {
			expect(shape.path, shape.id).toMatch(/^M/);
			expect(shape.path.length, shape.id).toBeGreaterThan(20);
		}
	});

	it("🚨 gives every shape both foreground boxes, inside the badge", () => {
		// A box that runs outside the viewBox puts art under the edging or off the badge, and
		// the only thing that would say so is somebody looking at it.
		for (const shape of BADGE_SHAPES) {
			for (const [which, box] of [
				["emblemBox", shape.emblemBox],
				["artBox", shape.artBox],
			] as const) {
				const where = `${shape.id}.${which}`;
				expect(box.size, where).toBeGreaterThan(0);
				expect(box.x, where).toBeGreaterThanOrEqual(0);
				expect(box.y, where).toBeGreaterThanOrEqual(0);
				expect(box.x + box.size, where).toBeLessThanOrEqual(100);
				expect(box.y + box.size, where).toBeLessThanOrEqual(100);
			}
			// An upload wears the badge's silhouette, so it always gets at least the room an
			// uncropped drawing does. The reverse would mean a photo drawn smaller than a line
			// emblem, which reads as two different objects rather than one badge.
			expect(shape.artBox.size, shape.id).toBeGreaterThanOrEqual(shape.emblemBox.size);
		}
	});

	it("⭐ sizes no emblem larger than the circle's, so a mixed ladder reads as a set", () => {
		// A rounded square could hold an emblem nearer 64 and a triangle only 32. Letting each
		// take what it could hold would make the rungs look mismatched rather than varied,
		// which is the same reasoning that keeps the edging a constant.
		const circle = badgeShape("circle").emblemBox.size;
		for (const shape of BADGE_SHAPES) {
			expect(shape.emblemBox.size, shape.id).toBeLessThanOrEqual(circle);
		}
	});

	it("🚨 states a foreground's position as a share of the badge, never as a length", () => {
		// The whole defect this replaced, in one assertion. `font-size: 46%` is a share of the
		// inherited font rather than of the badge, so Anthers' emoji rungs drew at about seven
		// pixels on a ninety-six pixel patch and did not grow with it. Anything here carrying a
		// unit is measured against something that is not the badge.
		for (const shape of BADGE_SHAPES) {
			for (const value of Object.values(badgeBoxStyle(shape.emblemBox))) {
				expect(value, shape.id).toMatch(/^-?[\d.]+%$/);
			}
		}
	});

	it("gives every color something that reads against it", () => {
		// A background with no stated foreground color would leave the emblem inheriting
		// whatever the surrounding page happened to be — invisible on half the palette.
		for (const color of BADGE_COLORS) {
			expect(color.fill, color.id).not.toBe(color.on);
			expect(color.on, color.id).toBeTruthy();
		}
	});

	it("carries no duplicate ids, in any of the three lists", () => {
		// A duplicate makes `badgeShape` return the first and the picker show two, so a
		// creator's choice would silently become the other one.
		for (const [name, ids] of [
			["shapes", BADGE_SHAPES.map((s) => s.id)],
			["colors", BADGE_COLORS.map((c) => c.id)],
			["emblems", BADGE_EMBLEMS],
		] as const) {
			expect(new Set(ids).size, name).toBe(ids.length);
		}
	});

	it("⭐ resolves an unknown or absent id to a default rather than to nothing", () => {
		// A row written before a library entry was retired still has to render. Falling back
		// is what keeps a palette correction from blanking old badges.
		expect(badgeShape(null).id).toBe(DEFAULT_BADGE_SHAPE);
		expect(badgeShape("a-shape-we-retired").id).toBe(DEFAULT_BADGE_SHAPE);
		expect(badgeColor(undefined).id).toBe(DEFAULT_BADGE_COLOR);
		expect(badgeColor("chartreuse").id).toBe(DEFAULT_BADGE_COLOR);
	});

	it("🚨 refuses an id that is not in the library, which is what the API leans on", () => {
		for (const bad of ["", "circle ", "CIRCLE", "../etc/passwd", null, 3]) {
			expect(isBadgeShape(bad), String(bad)).toBe(false);
			expect(isBadgeColor(bad), String(bad)).toBe(false);
			expect(isBadgeEmblem(bad), String(bad)).toBe(false);
		}
		expect(isBadgeShape(DEFAULT_BADGE_SHAPE)).toBe(true);
		expect(isBadgeColor(DEFAULT_BADGE_COLOR)).toBe(true);
		expect(isBadgeEmblem(BADGE_EMBLEMS[0])).toBe(true);
	});

	it("⭐ gives an untouched ladder distinct patches rather than five of the same", () => {
		// A default that reads as "unset" is not doing the job. Consecutive rungs get
		// different fields AND different emblems, so a creator who has touched nothing still
		// sees a set.
		const colors = [0, 1, 2, 3].map(defaultBadgeColor);
		expect(new Set(colors).size).toBe(4);
		for (const id of colors) expect(isBadgeColor(id)).toBe(true);
		expect(BADGE_COLORS.map((c) => c.id)).toContain(defaultBadgeColor(-1));
	});

	it("gives consecutive rungs different default emblems, and wraps rather than breaking", () => {
		// A ladder whose rungs all defaulted to the same picture would read as one rung
		// repeated, which is the opposite of what a default is for.
		const first = [0, 1, 2, 3].map(defaultBadgeEmblem);
		expect(new Set(first).size).toBe(4);
		// More rungs than emblems is ordinary, and so is a negative index from a caller
		// that subtracted before it checked.
		expect(defaultBadgeEmblem(BADGE_EMBLEMS.length)).toBe(defaultBadgeEmblem(0));
		expect(BADGE_EMBLEMS).toContain(defaultBadgeEmblem(-1));
	});
});

/**
 * ⭐ **Anthers' own four have to read as one design** (Parker, 2026-09-04). The ladder
 * once ran three Badges as dark art on a light field and one the other way round, and the
 * odd one out made the set look like two designs rather than a progression.
 *
 * ⚠️ **The palette is not what enforces this and must not be blamed for it.** Every color
 * picks the `on` that contrasts with its own `fill`, which is right — a creator choosing
 * `clay` should get a light emblem on it. Consistency across Anthers' four is a question
 * of choosing four fills from the same lightness band, and that choice lives in
 * `BADGE_ART` where nothing else would notice it changing.
 */
describe("Anthers' own ladder reads as one design", () => {
	/** The `L` of an `oklch(L% C H)` value. */
	const lightness = (c: string) => Number(/oklch\(\s*([\d.]+)%/.exec(c)?.[1] ?? Number.NaN);

	it("🚨 draws every rung the same way round — dark art on a light field", () => {
		const pattern = BADGE_ORDER.filter((b) => b !== "free").map((b) => {
			const color = BADGE_COLORS.find((c) => c.id === BADGE_ART[b as Badge].color);
			expect(color, `${b} names a color the palette does not have`).toBeDefined();
			const field = lightness((color as BadgeColor).fill);
			const art = lightness((color as BadgeColor).on);
			expect(Number.isNaN(field) || Number.isNaN(art)).toBe(false);
			return { rung: b, darkArtOnLightField: art < field };
		});
		// Reported as a list so a failure names which rung broke ranks, not just that one did.
		expect(pattern).toEqual(pattern.map((p) => ({ rung: p.rung, darkArtOnLightField: true })));
	});

	it("keeps the four fields close enough in lightness to belong together", () => {
		const ls = BADGE_ORDER.filter((b) => b !== "free").map((b) => {
			const color = BADGE_COLORS.find((c) => c.id === BADGE_ART[b as Badge].color);
			return lightness((color as BadgeColor).fill);
		});
		// A generous band: the point is to catch a field from the dark half of the palette
		// being dropped in, not to police a designer's taste inside the light half.
		expect(Math.max(...ls) - Math.min(...ls)).toBeLessThanOrEqual(35);
	});
});

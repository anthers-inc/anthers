// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Botanical decor generators — framework-agnostic SVG *string* builders that
// compose brand assets (grass, blooms, bees) with hand-drawn inline geometry
// into seamlessly tiling `data:image/svg+xml` backgrounds: climbing side vines,
// a grassy/flowery floor, and an airy pollen texture. Colors are baked in
// (background images can't inherit `currentColor`), so callers pass concrete
// color strings. These live with the brand assets they draw from; the React
// decor that arranges them (`<MeadowDecor>`) lives in @anthers/web-shared.

import { iconGroup } from "./compose";

// ─── shared helpers ───

const uri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** Tiny deterministic PRNG (mulberry-ish) so scattered elements are stable across renders. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** Almond leaf + midrib, pointing along +x from the origin, length `len`. An SVG
 * path `d` string, shared by the inline vine geometry and the React line-art. */
export function leafD(len: number): string {
	const w = len * 0.26;
	return (
		`M0 0 C ${len * 0.28} ${-w} ${len * 0.68} ${-w} ${len} 0 ` +
		`C ${len * 0.68} ${w} ${len * 0.28} ${w} 0 0 Z ` +
		`M ${len * 0.14} 0 L ${len * 0.9} 0`
	);
}

/** Filled five-petal bloom with a contrasting center, as SVG markup. */
function bloomFilled(x: number, y: number, fill: string, core: string, s: number): string {
	let p = `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s})">`;
	for (const a of [0, 72, 144, 216, 288]) {
		p += `<path d="M0 0 C -3.4 -4 -3.4 -9.5 0 -12.5 C 3.4 -9.5 3.4 -4 0 0 Z" transform="rotate(${a})" fill="${fill}"/>`;
	}
	return `${p}<circle r="2.3" fill="${core}"/></g>`;
}

// ─── vines ───

type VineColors = { stem: string; flower: string; bee: string };

// Bloom-dominant solid wildflowers scattered along the vine (see build-icons CURATED).
const VINE_BLOOMS = ["bloom-cluster", "bloom-round", "bloom-tulip"] as const;

/**
 * Stem waviness as a sum of harmonics — each `[freq, amp, phase]` where `freq` is
 * whole cycles over the tile (kept integer so the tile stays seamless). More terms
 * and higher frequencies = tighter, more aggressive left-right wander; lower = long,
 * calm sweeps. Presets below run calm → tight.
 */
export type VineWave = [freq: number, amp: number, phase: number][];
export const VINE_WAVES: Record<"calm" | "loose" | "medium" | "tight", VineWave> = {
	calm: [
		[1, 24, 0],
		[3, 9, 1.3],
	],
	loose: [
		[2, 23, 0],
		[5, 7, 1.1],
	],
	medium: [
		[3, 21, 0],
		[7, 7, 0.7],
	],
	tight: [
		[4, 19, 0],
		[9, 6, 1.4],
	],
};
export type VineWaveName = keyof typeof VINE_WAVES;

/**
 * A seamlessly vertically-tileable climbing vine as an SVG data URI — a `repeat-y`
 * background that scrolls with the page. The stem + leaves are hand-drawn inline
 * (dainty, and freer to meander than any tiling border), wandering via stacked
 * harmonics (`wave`) so the tile reads as one organic vine climbing the page rather
 * than a rigid repeating pattern. Real blooms from @anthers/brand (solid wildflowers)
 * are scattered along it in the soft yellow for life, with a few amber bees resting
 * among them. Colors are baked in (background images can't inherit `currentColor`).
 */
export function vineTileDataUri(c: VineColors, wave: VineWave = VINE_WAVES.calm): string {
	const W = 120;
	const H = 2400; // tall tile → long repeat wavelength (reads organic, not patterned)
	// Stem waviness = sum of whole-cycle harmonics over H, so position AND slope match
	// across the seam. More/faster terms → tighter, more aggressive left-right wander.
	const xAt = (y: number) =>
		60 + wave.reduce((sum, [f, a, p]) => sum + a * Math.sin((2 * Math.PI * f * y) / H + p), 0);
	let stem = "";
	for (let y = 0; y <= H; y += 10) stem += `${y === 0 ? "M" : "L"}${xAt(y).toFixed(1)} ${y} `;
	let foliage = `<path d="${stem.trim()}" stroke="${c.stem}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
	// Dainty alternating leaves along the stem.
	let i = 0;
	for (let y = 60; y < H; y += 66) {
		const x = xAt(y);
		const right = i % 2 === 0;
		foliage += `<path d="${leafD(18)}" transform="translate(${x.toFixed(1)} ${y}) rotate(${right ? -26 : 206})" stroke="${c.stem}" stroke-width="1.15" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
		foliage += `<path d="${leafD(11)}" transform="translate(${x.toFixed(1)} ${(y + 15).toFixed(1)}) rotate(${right ? -54 : 234})" stroke="${c.stem}" stroke-width="1.15" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
		i++;
	}
	// Real blooms scattered along the vine — varied kind, size, offset and tilt.
	let flowers = "";
	for (const [bi, y, off, size, rot] of [
		[0, 300, 11, 27, 6],
		[1, 720, -12, 26, -12],
		[2, 1130, 11, 23, 10],
		[0, 1540, -10, 27, -6],
		[1, 1950, 12, 25, 12],
		[2, 2280, -9, 22, -8],
	] as const) {
		flowers += iconGroup(VINE_BLOOMS[bi], {
			x: xAt(y) + off,
			y,
			size,
			color: c.flower,
			rotate: rot,
		});
	}
	// A few amber bees resting among the blooms.
	let bees = "";
	for (const [name, y, off, rot] of [
		["bee", 520, 22, 12],
		["bee-flying", 1370, -24, -10],
		["bee", 2110, 20, 6],
	] as const) {
		bees += iconGroup(name, { x: xAt(y) + off, y, size: 17, color: c.bee, rotate: rot });
	}
	return uri(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><g opacity="0.62">${foliage}</g>${flowers}${bees}</svg>`,
	);
}

/** One strand of a woven vine: a center column `cx`, a `wave` (waviness), and
 * optional line width / opacity (for depth) / whether it carries leaves. */
export type VineStrand = {
	cx: number;
	wave: VineWave;
	width?: number;
	opacity?: number;
	leaves?: boolean;
};

/**
 * Several vine strands woven together — like vines actually climb — as one
 * seamlessly tileable `repeat-y` data URI. Strands are drawn back-to-front, and
 * each lays down a background-colored "casing" under its stem, so a front strand
 * visually passes OVER the ones behind it wherever they cross (natural over/under
 * depth). Blooms + bees ride the front strand. `c.casing` should be the page's base
 * color so the casings read as gaps. Colors are baked in.
 */
export function wovenVineTileDataUri(
	c: { stem: string; flower: string; bee: string; casing: string },
	strands: VineStrand[],
	H = 2400,
): string {
	const W = 120;
	const xOf = (s: VineStrand) => (y: number) =>
		s.cx + s.wave.reduce((sum, [f, a, p]) => sum + a * Math.sin((2 * Math.PI * f * y) / H + p), 0);
	let body = "";
	strands.forEach((s, si) => {
		const xAt = xOf(s);
		const w = s.width ?? 1.3;
		let d = "";
		for (let y = 0; y <= H; y += 10) d += `${y === 0 ? "M" : "L"}${xAt(y).toFixed(1)} ${y} `;
		d = d.trim();
		// casing (wider, base-colored) then the colored stem on top of it
		let g = `<path d="${d}" stroke="${c.casing}" stroke-width="${(w + 2.6).toFixed(2)}" fill="none" stroke-linecap="round"/>`;
		g += `<path d="${d}" stroke="${c.stem}" stroke-width="${w.toFixed(2)}" fill="none" stroke-linecap="round"/>`;
		if (s.leaves !== false) {
			let i = si;
			for (let y = 46 + si * 30; y < H; y += 84) {
				const x = xAt(y);
				const right = i % 2 === 0;
				g += `<path d="${leafD(16)}" transform="translate(${x.toFixed(1)} ${y}) rotate(${right ? -28 : 208})" stroke="${c.stem}" stroke-width="${(w - 0.15).toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
				i++;
			}
		}
		body += `<g opacity="${(s.opacity ?? 1).toFixed(2)}">${g}</g>`;
	});
	// Blooms + bees ride the front strand.
	const frontX = xOf(strands[strands.length - 1]);
	let deco = "";
	for (const [bi, y, off, size, rot] of [
		[0, 360, 12, 26, 6],
		[1, 820, -13, 25, -12],
		[2, 1240, 12, 23, 10],
		[0, 1680, -11, 26, -6],
		[2, 2120, 12, 24, 8],
	] as const) {
		deco += iconGroup(VINE_BLOOMS[bi], {
			x: frontX(y) + off,
			y,
			size,
			color: c.flower,
			rotate: rot,
		});
	}
	for (const [name, y, off, rot] of [
		["bee", 600, 20, 12],
		["bee-flying", 1500, -22, -10],
		["bee", 2260, 18, 6],
	] as const) {
		deco += iconGroup(name, { x: frontX(y) + off, y, size: 17, color: c.bee, rotate: rot });
	}
	return uri(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${body}${deco}</svg>`,
	);
}

/** Woven-vine presets: sets of strands that climb around each other. */
export const VINE_WEAVES: Record<"braid" | "helix" | "triple" | "twin", VineStrand[]> = {
	// two strands, opposite phase — a tight rope-like twist
	braid: [
		{ cx: 60, wave: [[3, 19, 0]], opacity: 0.8 },
		{ cx: 60, wave: [[3, 19, Math.PI]], opacity: 1 },
	],
	// two strands, wide open twist — airier, fewer/larger crossings
	helix: [
		{ cx: 60, wave: [[2, 25, 0]], opacity: 0.78, leaves: false },
		{ cx: 60, wave: [[2, 25, Math.PI]], opacity: 1 },
	],
	// three strands at different centers/frequencies — a full natural tangle
	triple: [
		{
			cx: 56,
			wave: [
				[2, 16, 0],
				[5, 5, 0.4],
			],
			opacity: 0.55,
			leaves: false,
		},
		{
			cx: 64,
			wave: [
				[3, 14, 1.6],
				[6, 5, 0],
			],
			opacity: 0.8,
		},
		{ cx: 60, wave: [[2, 22, 3.0]], opacity: 1 },
	],
	// two strands climbing roughly parallel, crossing now and then
	twin: [
		{
			cx: 50,
			wave: [
				[2, 12, 0],
				[4, 6, 0.3],
			],
			opacity: 0.85,
		},
		{
			cx: 70,
			wave: [
				[2, 12, 0.7],
				[4, 6, 1.1],
			],
			opacity: 1,
		},
	],
};

/** How a side vine is drawn: one meandering strand, or several woven. */
export type VineStyle = "single" | keyof typeof VINE_WEAVES;

// ─── grass floor ───

/**
 * A horizontally-tiling grassy/flowery floor (blades + a few flowers rising from
 * the bottom edge) as an SVG data URI — a `repeat-x` background anchored at the
 * page bottom, that the side vines appear to spring out of.
 */
export function grassFloorDataUri(c: { grass: string; flower: string; core: string }): string {
	const W = 720; // wide tile → the repeat-x period is long, so the pattern reads as non-uniform
	const H = 172;
	const R = rng(4242);
	const tufts = ["grass-band", "grass-clump", "grass-tall", "grass-cattail", "grass-reed"] as const;
	const pick = () => tufts[Math.floor(R() * tufts.length)];
	// Each tuft carries its own size + opacity + horizontal jitter so no two are alike.
	// Anchor them well below the clip edge: every grass asset has 5.5–15 units of empty
	// space below its art in the 100-unit viewBox, and since `anchor:bottom` pins the
	// *viewBox* bottom, that gap scales with `size` — so a big tuft can float above the
	// ground line, leaving a gap underneath. `GROUND = H + 26` overshoots enough that
	// even the largest tuft's base stays below the clip edge.
	const GROUND = H + 26;
	const tuft = (x: number, size: number, op: number) =>
		`<g opacity="${op.toFixed(2)}">${iconGroup(pick(), { x, y: GROUND, size, color: c.grass, anchor: "bottom" })}</g>`;
	// A shorter, dimmer back row for depth (hidden behind the front, so small is fine).
	let back = "";
	for (let x = -18; x <= W + 18; x += 21) {
		back += tuft(x + (R() - 0.5) * 18, 52 + R() * 46, 0.34 + R() * 0.3);
	}
	// The taller, fuller front row — its min size already fills the ground; randomness
	// only scales up from there, so no front tuft is ever short enough to leave a gap.
	let front = "";
	for (let x = -14; x <= W + 14; x += 25) {
		front += tuft(x + (R() - 0.5) * 22, 100 + R() * 54, 0.74 + R() * 0.26);
	}
	// Tall accents (reeds/cattails) rising above the band — some reach the footer line;
	// random spacing + size + opacity so they scatter rather than march.
	const accentNames = ["grass-cattail", "grass-reed", "grass-tall"] as const;
	let accents = "";
	for (let x = 24; x < W; x += 96 + R() * 74) {
		const name = accentNames[Math.floor(R() * accentNames.length)];
		accents += `<g opacity="${(0.74 + R() * 0.26).toFixed(2)}">${iconGroup(name, { x, y: GROUND, size: 156 + R() * 48, color: c.grass, anchor: "bottom" })}</g>`;
	}
	// Flower pops on thin swaying stems (soft-yellow blooms among the green).
	let flowers = "";
	for (let n = 0; n < Math.round(W / 72); n++) {
		const x = 24 + R() * (W - 48);
		const h = 70 + R() * 58;
		const sway = (R() - 0.5) * 16;
		const tip = x + sway * 0.6;
		flowers += `<g opacity="${(0.72 + R() * 0.28).toFixed(2)}"><path d="M${x.toFixed(1)} ${H} Q ${(x + sway).toFixed(1)} ${(H - h * 0.5).toFixed(1)} ${tip.toFixed(1)} ${(H - h).toFixed(1)}" fill="none" stroke="${c.grass}" stroke-width="1.5" stroke-linecap="round"/>${bloomFilled(tip, H - h, c.flower, c.core, 1.0 + R() * 0.5)}</g>`;
	}
	return uri(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${back}${front}${accents}${flowers}</svg>`,
	);
}

// ─── pollen ───

/**
 * A soft, drifting "pollen in the air" texture as an SVG data URI — scattered
 * motes of varied size and opacity, plus a few large out-of-focus haloes. Meant
 * to sit behind everything (incl. text) at low overall opacity. Deterministic.
 * `opacityScale` multiplies every mote's opacity (< 1 to make it quieter, e.g. on
 * a dark surface where a bright pollen color otherwise reads too loud).
 */
export function pollenDataUri(color: string, opacityScale = 1): string {
	const T = 460;
	const R = rng(90210);
	const o = (base: number) => (base * opacityScale).toFixed(3);
	let c = "";
	for (let n = 0; n < 9; n++) {
		c += `<circle cx="${(R() * T).toFixed(1)}" cy="${(R() * T).toFixed(1)}" r="${(7 + R() * 13).toFixed(1)}" fill="${color}" opacity="${o(0.02 + R() * 0.03)}"/>`;
	}
	for (let n = 0; n < 56; n++) {
		c += `<circle cx="${(R() * T).toFixed(1)}" cy="${(R() * T).toFixed(1)}" r="${(0.7 + R() * 2.4).toFixed(2)}" fill="${color}" opacity="${o(0.05 + R() * 0.13)}"/>`;
	}
	return uri(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${T}" height="${T}" viewBox="0 0 ${T} ${T}">${c}</svg>`,
	);
}

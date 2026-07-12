// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Botanical line-art flourishes for the design lab. All inline SVG (no external
// assets), stroke = `currentColor` so a wrapping `text-primary/15` etc. tints
// them and they adapt to each variant's light/dark palette. Purely decorative:
// every piece is aria-hidden and pointer-events-none-friendly.

import { type BrandIconName, iconDataUri, iconGroup } from "@anthers/brand";

type SvgProps = { className?: string };

/**
 * A standalone brand asset, recolored via CSS mask so its color follows `text-*`
 * (like `currentColor`). Lets any single-color @anthers/brand SVG be dropped in
 * and themed without inlining markup. Size/color via className (h-/w-/text-).
 */
export function BrandGlyph({ name, className }: { name: BrandIconName; className?: string }) {
	const url = `url("${iconDataUri(name, "#000")}")`;
	return (
		<span
			aria-hidden="true"
			className={className}
			style={{
				display: "inline-block",
				backgroundColor: "currentColor",
				maskImage: url,
				WebkitMaskImage: url,
				maskRepeat: "no-repeat",
				WebkitMaskRepeat: "no-repeat",
				maskPosition: "center",
				WebkitMaskPosition: "center",
				maskSize: "contain",
				WebkitMaskSize: "contain",
			}}
		/>
	);
}

/** Almond leaf + midrib, pointing along +x from the origin, length `len`. */
function leafD(len: number): string {
	const w = len * 0.26;
	return (
		`M0 0 C ${len * 0.28} ${-w} ${len * 0.68} ${-w} ${len} 0 ` +
		`C ${len * 0.68} ${w} ${len * 0.28} ${w} 0 0 Z ` +
		`M ${len * 0.14} 0 L ${len * 0.9} 0`
	);
}

/** Five-petal stroke bloom centered at (x,y). */
function Bloom({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
	return (
		<g transform={`translate(${x} ${y}) scale(${s})`}>
			{[0, 72, 144, 216, 288].map((a) => (
				<path key={a} d="M0 0 C -3 -4 -3 -9 0 -12 C 3 -9 3 -4 0 0 Z" transform={`rotate(${a})`} />
			))}
			<circle r="2" />
		</g>
	);
}

/** Tall meandering climbing vine — used to frame page sides. viewBox 120×1000. */
export function SideVine({ className }: SvgProps) {
	const H = 1000;
	const xAt = (y: number) => 62 + 30 * Math.sin(y / 150);
	let stem = "";
	for (let y = 0; y <= H; y += 8) stem += `${y === 0 ? "M" : "L"}${xAt(y).toFixed(1)} ${y} `;
	const leaves: React.ReactNode[] = [];
	let i = 0;
	for (let y = 55; y < H - 20; y += 60) {
		const x = xAt(y);
		const right = i % 2 === 0;
		leaves.push(
			<path
				key={`a${y}`}
				d={leafD(24)}
				transform={`translate(${x} ${y}) rotate(${right ? -22 : 202})`}
			/>,
		);
		leaves.push(
			<path
				key={`b${y}`}
				d={leafD(15)}
				transform={`translate(${x} ${y + 14}) rotate(${right ? -52 : 232})`}
			/>,
		);
		i++;
	}
	return (
		<svg
			viewBox={`0 0 120 ${H}`}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			preserveAspectRatio="xMidYMid meet"
			className={className}
			aria-hidden="true"
		>
			<path d={stem} />
			{leaves}
			{[190, 520, 830].map((y) => (
				<Bloom key={y} x={xAt(y)} y={y} s={0.9} />
			))}
		</svg>
	);
}

/** Tiny deterministic PRNG (mulberry-ish) so scattered elements are stable across renders. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const uri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** Filled five-petal bloom with a contrasting center. */
function bloomFilled(x: number, y: number, fill: string, core: string, s: number): string {
	let p = `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s})">`;
	for (const a of [0, 72, 144, 216, 288]) {
		p += `<path d="M0 0 C -3.4 -4 -3.4 -9.5 0 -12.5 C 3.4 -9.5 3.4 -4 0 0 Z" transform="rotate(${a})" fill="${fill}"/>`;
	}
	return `${p}<circle r="2.3" fill="${core}"/></g>`;
}

type VineColors = {
	stem: string;
	flower: string;
	core: string;
	bee: string;
};

/**
 * A seamlessly vertically-tileable climbing vine (two sine periods for variety)
 * as an SVG data URI — a `repeat-y` background that scrolls with the page. Foliage
 * is baked at reduced opacity so the colored blooms and bees read as the pops.
 * Colors are baked in (background images can't inherit `currentColor`).
 */
export function vineTileDataUri(c: VineColors): string {
	const H = 1800;
	const period = 900;
	const xAt = (y: number) => 62 + 30 * Math.sin((2 * Math.PI * y) / period);
	let stem = "";
	for (let y = 0; y <= H; y += 8) stem += `${y === 0 ? "M" : "L"}${xAt(y).toFixed(1)} ${y} `;
	let foliage = `<path d="${stem.trim()}" stroke="${c.stem}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
	let i = 0;
	for (let y = 38; y < H; y += 56) {
		const x = xAt(y);
		const right = i % 2 === 0;
		foliage += `<path d="${leafD(25)}" transform="translate(${x.toFixed(1)} ${y}) rotate(${right ? -22 : 202})" stroke="${c.stem}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
		foliage += `<path d="${leafD(15)}" transform="translate(${x.toFixed(1)} ${y + 14}) rotate(${right ? -52 : 232})" stroke="${c.stem}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
		i++;
	}
	let flowers = "";
	for (const [y, s, off] of [
		[210, 1.15, 20],
		[560, 0.95, -18],
		[980, 1.2, 19],
		[1360, 1.0, -20],
		[1660, 1.1, 17],
	] as const) {
		flowers += bloomFilled(xAt(y) + off, y, c.flower, c.core, s);
	}
	// Bees from @anthers/brand (Noun Project), composed into the tile and recolored
	// to c.bee — resting bees and a flying bee, scattered down the vine.
	let bees = "";
	for (const [name, y, off, rot] of [
		["bee", 430, 22, 12],
		["bee-flying", 1120, -24, -10],
		["bee", 1540, 20, 6],
	] as const) {
		bees += iconGroup(name, { x: xAt(y) + off, y, size: 18, color: c.bee, rotate: rot });
	}
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 ${H}">` +
		`<g opacity="0.62">${foliage}</g>${flowers}${bees}</svg>`;
	return uri(svg);
}

/**
 * A horizontally-tiling grassy/flowery floor (blades + a few flowers rising from
 * the bottom edge) as an SVG data URI — a `repeat-x` background anchored at the
 * page bottom, that the side vines appear to spring out of.
 */
export function grassFloorDataUri(c: { grass: string; flower: string; core: string }): string {
	const W = 340;
	const H = 150;
	const R = rng(4242);
	const tufts = ["grass-band", "grass-clump", "grass-tall", "grass-cattail", "grass-reed"] as const;
	let s = "";
	// overlapping base band of grass tufts across the width, sitting on the bottom
	for (let x = -10; x <= W + 10; x += 44) {
		const name = tufts[Math.floor(R() * tufts.length)];
		s += iconGroup(name, { x, y: H + 8, size: 82 + R() * 46, color: c.grass, anchor: "bottom" });
	}
	// a few taller accent tufts
	for (const [x, name, size] of [
		[64, "grass-tall", 122],
		[196, "grass-cattail", 112],
		[300, "grass-reed", 116],
	] as const) {
		s += iconGroup(name, { x, y: H + 8, size, color: c.grass, anchor: "bottom" });
	}
	// a few flower pops on thin stems (kept inline for the soft-yellow bloom color)
	for (let n = 0; n < 3; n++) {
		const x = 44 + R() * (W - 88);
		const h = 66 + R() * 40;
		s += `<path d="M${x.toFixed(1)} ${H} Q ${(x + (R() - 0.5) * 12).toFixed(1)} ${(H - h * 0.5).toFixed(1)} ${x.toFixed(1)} ${(H - h).toFixed(1)}" fill="none" stroke="${c.grass}" stroke-width="1.4" stroke-linecap="round"/>`;
		s += bloomFilled(x, H - h, c.flower, c.core, 1.2);
	}
	return uri(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`,
	);
}

/**
 * A soft, drifting "pollen in the air" texture as an SVG data URI — scattered
 * motes of varied size and opacity, plus a few large out-of-focus haloes. Meant
 * to sit behind everything (incl. text) at low overall opacity. Deterministic.
 */
export function pollenDataUri(color: string): string {
	const T = 460;
	const R = rng(90210);
	let c = "";
	for (let n = 0; n < 9; n++) {
		c += `<circle cx="${(R() * T).toFixed(1)}" cy="${(R() * T).toFixed(1)}" r="${(7 + R() * 13).toFixed(1)}" fill="${color}" opacity="${(0.02 + R() * 0.03).toFixed(3)}"/>`;
	}
	for (let n = 0; n < 56; n++) {
		c += `<circle cx="${(R() * T).toFixed(1)}" cy="${(R() * T).toFixed(1)}" r="${(0.7 + R() * 2.4).toFixed(2)}" fill="${color}" opacity="${(0.05 + R() * 0.13).toFixed(3)}"/>`;
	}
	return uri(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${T}" height="${T}" viewBox="0 0 ${T} ${T}">${c}</svg>`,
	);
}

/** Small upward leaf sprig. viewBox 60×64. */
export function Sprig({ className }: SvgProps) {
	return (
		<svg
			viewBox="0 0 60 64"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d="M30 62 C 27 48 33 30 30 9" />
			<path d={leafD(16)} transform="translate(30 47) rotate(-40)" />
			<path d={leafD(16)} transform="translate(30 47) rotate(220)" />
			<path d={leafD(14)} transform="translate(30 33) rotate(-46)" />
			<path d={leafD(14)} transform="translate(30 33) rotate(226)" />
			<path d={leafD(12)} transform="translate(30 21) rotate(-52)" />
			<path d={leafD(12)} transform="translate(30 21) rotate(232)" />
			<path d={leafD(11)} transform="translate(30 10) rotate(-90)" />
		</svg>
	);
}

/** Symmetric horizontal leafy branch with a center bloom — a section divider. viewBox 240×40. */
export function Branch({ className }: SvgProps) {
	const side = (dir: 1 | -1) => {
		const nodes: React.ReactNode[] = [];
		let x = 120 + dir * 26;
		for (let k = 0; k < 3; k++) {
			const up = k % 2 === 0;
			nodes.push(
				<path
					key={`${dir}-${k}`}
					d={leafD(15 - k * 1.5)}
					transform={`translate(${x} 20) rotate(${dir === 1 ? (up ? -34 : 34) : up ? 214 : 146})`}
				/>,
			);
			x += dir * 28;
		}
		return nodes;
	};
	return (
		<svg
			viewBox="0 0 240 40"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d="M120 20 C 150 15 180 25 224 19" />
			<path d="M120 20 C 90 15 60 25 16 19" />
			{side(1)}
			{side(-1)}
			<Bloom x={120} y={20} s={1} />
		</svg>
	);
}

/** A large fern frond for filling negative space. viewBox 240×360. */
export function Frond({ className }: SvgProps) {
	const P0 = [120, 356];
	const P1 = [64, 232];
	const P2 = [178, 118];
	const P3 = [138, 16];
	const bez = (t: number): [number, number] => {
		const mt = 1 - t;
		const x =
			mt * mt * mt * P0[0] + 3 * mt * mt * t * P1[0] + 3 * mt * t * t * P2[0] + t * t * t * P3[0];
		const y =
			mt * mt * mt * P0[1] + 3 * mt * mt * t * P1[1] + 3 * mt * t * t * P2[1] + t * t * t * P3[1];
		return [x, y];
	};
	let rachis = "";
	for (let t = 0; t <= 1.0001; t += 0.04) {
		const [x, y] = bez(t);
		rachis += `${t === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
	}
	const pinnae: React.ReactNode[] = [];
	for (let t = 0.06; t < 0.96; t += 0.05) {
		const [x, y] = bez(t);
		const [x2, y2] = bez(t + 0.01);
		const ang = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
		const len = 34 * (1 - t) + 8;
		pinnae.push(
			<path key={`l${t}`} d={leafD(len)} transform={`translate(${x} ${y}) rotate(${ang - 62})`} />,
		);
		pinnae.push(
			<path key={`r${t}`} d={leafD(len)} transform={`translate(${x} ${y}) rotate(${ang + 62})`} />,
		);
	}
	return (
		<svg
			viewBox="0 0 240 360"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d={rachis} />
			{pinnae}
		</svg>
	);
}

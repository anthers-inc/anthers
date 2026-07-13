// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Botanical line-art flourishes — inline SVG (no external assets), stroke =
// `currentColor` so a wrapping `text-primary/60` etc. tints them and they adapt
// to the theme. Purely decorative: every piece is aria-hidden. The leaf midrib
// geometry is shared with the brand vine generators via `leafD`.

import { leafD } from "@anthers/brand";

type SvgProps = { className?: string };

/** Five-petal stroke bloom centered at (x,y). */
export function Bloom({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
	return (
		<g transform={`translate(${x} ${y}) scale(${s})`}>
			{[0, 72, 144, 216, 288].map((a) => (
				<path key={a} d="M0 0 C -3 -4 -3 -9 0 -12 C 3 -9 3 -4 0 0 Z" transform={`rotate(${a})`} />
			))}
			<circle r="2" />
		</g>
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

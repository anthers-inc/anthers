// SPDX-License-Identifier: AGPL-3.0-or-later
//
// <MeadowVines> — the woven climbing side vines as an absolutely-positioned pair
// (left + right, wide screens only), plus a field of bees drifting along them and
// inward toward center (as if flying back and forth between the two vines). Pulled
// out of <MeadowDecor> so a layout can render it spanning the WHOLE page — content
// AND the footer below it — instead of only the page's content area. Drop it inside
// a `relative` container: it fills that container's height (`inset-y-0`/`inset-0`)
// at z-20, so keep content/footer below it (z < 20) and the grass floor above it
// (z > 20). Vine colors are baked per `mode`; the bees ride `text-accent`, so they
// track the theme token directly (and match the grass bees in <MeadowFloor>).

import {
	VINE_WAVES,
	VINE_WEAVES,
	type VineStyle,
	vineTileDataUri,
	wovenVineTileDataUri,
} from "@anthers/brand";
import { BrandGlyph } from "./BrandGlyph";
import { decorColors } from "./meadowColors";
import { useDecorMode } from "./useDecorMode";

// Deterministic little PRNG (mulberry32) so bee placement is fixed — stable across
// re-renders (incl. theme toggles) instead of jumping around on every paint.
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type BeeSpec = {
	id: string;
	/** % across the page (left edge = 0) */
	left: number;
	/** % down the page (top = 0) */
	top: number;
	/** px */
	size: number;
	glyph: "bee" | "bee-flying";
	rotate: number;
	opacity: number;
};

// A swarm per side: dense right at the vine column, thinning as it drifts inward.
const BEES_PER_SIDE = 18;
const MAX_INWARD = 32; // % of page width a bee can wander in from its edge

function buildBees(): BeeSpec[] {
	const r = mulberry32(0xbee5);
	const bees: BeeSpec[] = [];
	for (const side of ["l", "r"] as const) {
		for (let n = 0; n < BEES_PER_SIDE; n++) {
			// Edge-biased: r^1.9 keeps most bees near the vine, with a tail toward center.
			const inward = r() ** 1.9 * MAX_INWARD;
			const left = side === "l" ? 1.5 + inward : 98.5 - inward;
			bees.push({
				id: `${side}-${n}`,
				left,
				top: 2 + r() * 94,
				size: 20 + r() * 8, // 20–28px, matching the grass bees
				glyph: r() < 0.5 ? "bee-flying" : "bee",
				rotate: Math.round((r() * 2 - 1) * 14),
				// fade a touch with depth (farther in = higher = more transparent)
				opacity: 0.85 - (inward / MAX_INWARD) * 0.3,
			});
		}
	}
	return bees;
}

const BEES = buildBees();

export function MeadowVines({
	mode,
	vine = "triple",
}: {
	/** force a mode; omit to track the live `data-theme` (light/dark toggle) */
	mode?: "light" | "dark";
	/** single meandering strand, or a woven preset (braid/helix/triple/twin) */
	vine?: VineStyle;
}) {
	const observed = useDecorMode();
	const c = decorColors(mode ?? observed);
	const vineColors = { stem: c.stem, flower: c.flower };
	const vineUri =
		vine === "single"
			? vineTileDataUri(vineColors, VINE_WAVES.calm)
			: wovenVineTileDataUri({ ...vineColors, casing: c.casing }, VINE_WEAVES[vine]);
	const style: React.CSSProperties = {
		backgroundImage: `url("${vineUri}")`,
		backgroundRepeat: "repeat-y",
		backgroundSize: "100% auto",
		backgroundPosition: "center top",
		opacity: c.vineOpacity,
	};
	return (
		<>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-28 xl:block"
				style={style}
			/>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 right-0 z-20 hidden w-28 -scale-x-100 xl:block"
				style={style}
			/>
			<div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 hidden xl:block">
				{BEES.map((b) => (
					<BrandGlyph
						key={b.id}
						name={b.glyph}
						className="absolute text-accent"
						style={{
							left: `${b.left}%`,
							top: `${b.top}%`,
							width: `${b.size}px`,
							height: `${b.size}px`,
							opacity: b.opacity,
							transform: `rotate(${b.rotate}deg)`,
						}}
					/>
				))}
			</div>
		</>
	);
}

export default MeadowVines;

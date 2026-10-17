// SPDX-License-Identifier: Apache-2.0
//
// <MeadowBackdrop> — the signed-in site's Meadow layer: the pollen-textured base
// surface, the woven climbing side vines with their bees, and the grassy floor at
// the bottom of the viewport, in ONE absolutely-positioned element. It is the app
// shell's counterpart to the logged-out composition in LoggedOutLayout, with the
// z-order inverted for the different surface: signed-in pages are a working app
// whose content is dense and often only marginally offset, so **the decor always
// paints beneath the page** — a creator's work or post must never have bees, vines
// or pollen rendered across it. The component carries the negative z-index itself;
// the caller supplies an ancestor that is `relative isolate`, whose stacking
// context is also the page content's, and everything above that layer simply
// paints over it. Opaque article and card surfaces hide the decor entirely, so a
// busy page reads clean while the transparent page around it carries the meadow.
//
// The vines are viewport-anchored here rather than page-scrolled (the shell's
// <main> scrolls internally, and the layer sits outside it) — a fixed frame the
// content scrolls past. The floor sits behind the scrolled footer the same way
// the logged-out footer sits on the grass.

import { pollenDataUri } from "@anthers/brand";
import { MeadowFloor } from "./MeadowFloor";
import { MeadowVines } from "./MeadowVines";
import { decorColors } from "./meadowColors";
import { useDecorMode } from "./useDecorMode";

export function MeadowBackdrop({
	mode,
	className = "",
}: {
	/** force a mode; omit to track the live `data-theme` (light/dark toggle) */
	mode?: "light" | "dark";
	className?: string;
}) {
	const observed = useDecorMode();
	const resolvedMode = mode ?? observed;
	const c = decorColors(resolvedMode);

	// "Pollen in the air" over the base surface, exactly as <MeadowDecor> paints it.
	const pollen = `url("${pollenDataUri(c.pollen, c.pollenScale)}") repeat, var(--color-base-100)`;

	return (
		// `pointer-events-none` plus `aria-hidden`: the layer is pure decoration, and its
		// negative z-index (below) keeps it from competing with content in paint order.
		<div
			aria-hidden="true"
			data-meadow-backdrop=""
			className={`pointer-events-none absolute inset-0 -z-10 ${className}`}
			style={{ background: pollen }}
		>
			<MeadowVines mode={resolvedMode} />
			<div className="absolute inset-x-0 bottom-0">
				<MeadowFloor mode={resolvedMode} />
			</div>
		</div>
	);
}

export default MeadowBackdrop;

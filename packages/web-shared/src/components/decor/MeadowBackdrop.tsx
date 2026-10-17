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

	// Signed-in quieting: on the working app the decor sits close to dense UI, so the
	// layer renders at strongly reduced opacity and a real blur — distant texture the
	// page scrolls over, rather than a foreground (Parker, 2026-10-17, tuned live in
	// the browser: padding the content away from the floor wasted vertical space the
	// Work pages want, while this keeps the last row readable through it). Applied on
	// the layer's root rather than a wrapping element, because the shell's e2e test
	// pins the parent of this root as the stacking context <main> shares: an
	// intermediate wrapper between them breaks that walk (meadow-signed-in.authed.e2e.ts).
	const QUIET_OPACITY = 0.45;
	const QUIET_BLUR_PX = 3;

	return (
		// `pointer-events-none` plus `aria-hidden`: the layer is pure decoration, and its
		// negative z-index (below) keeps it from competing with content in paint order.
		<div
			aria-hidden="true"
			data-meadow-backdrop=""
			className={`pointer-events-none absolute inset-0 -z-10 ${className}`}
			style={{
				background: pollen,
				opacity: QUIET_OPACITY,
				filter: `blur(${QUIET_BLUR_PX}px)`,
			}}
		>
			<MeadowVines mode={resolvedMode} />
			<div className="absolute inset-x-0 bottom-0">
				<MeadowFloor mode={resolvedMode} />
			</div>
		</div>
	);
}

export default MeadowBackdrop;

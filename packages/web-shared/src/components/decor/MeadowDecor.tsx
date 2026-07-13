// SPDX-License-Identifier: AGPL-3.0-or-later
//
// <MeadowDecor> — the pollen-textured base surface for Meadow-themed page content.
// Wraps its children on the pollen-over-base-100 surface, in their own z-10 layer,
// and (optionally) draws the grassy floor at the bottom.
//
// The climbing side vines used to live here too, but they now render at the LAYOUT
// level (<MeadowVines> in LoggedOutLayout) so they can span the whole page — the
// content AND the footer below it — with the grass floor still in front. `floor`
// (default true) draws the grass at the bottom of this container; the shared
// logged-out chrome sets it false and draws one grass floor under the footer.
// Baked decor colors come from ./meadowColors (they track theme.css's palette).

import { pollenDataUri } from "@anthers/brand";
import { MeadowFloor } from "./MeadowFloor";
import { decorColors } from "./meadowColors";
import { useDecorMode } from "./useDecorMode";

export function MeadowDecor({
	mode,
	floor = true,
	className = "",
	style,
	children,
}: {
	/** force a mode; omit to track the live `data-theme` (light/dark toggle) */
	mode?: "light" | "dark";
	/** draw the grassy floor at the bottom of this container (default true) */
	floor?: boolean;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
}) {
	const observed = useDecorMode();
	const resolvedMode = mode ?? observed;
	const c = decorColors(resolvedMode);

	// "Pollen in the air" over the base surface (the base itself stays a live CSS var
	// so it follows whatever palette scope this lands in).
	const pollen = `url("${pollenDataUri(c.pollen, c.pollenScale)}") repeat, var(--color-base-100)`;

	return (
		<div
			className={`relative min-h-screen overflow-hidden text-base-content ${className}`}
			style={{ background: pollen, ...style }}
		>
			<div className="relative z-10">{children}</div>
			{floor && <MeadowFloor mode={resolvedMode} />}
		</div>
	);
}

export default MeadowDecor;

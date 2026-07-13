// SPDX-License-Identifier: AGPL-3.0-or-later
//
// <MeadowVines> — the woven climbing side vines as an absolutely-positioned pair
// (left + right, wide screens only). Pulled out of <MeadowDecor> so a layout can
// render them spanning the WHOLE page — content AND the footer below it — instead
// of only the page's content area. Drop it inside a `relative` container: it fills
// that container's height (`inset-y-0`) at z-20, so keep content/footer below it
// (z < 20) and the grass floor above it (z > 20). Colors are baked per `mode`.

import {
	VINE_WAVES,
	VINE_WEAVES,
	type VineStyle,
	vineTileDataUri,
	wovenVineTileDataUri,
} from "@anthers/brand";
import { decorColors } from "./meadowColors";

export function MeadowVines({
	mode = "dark",
	vine = "triple",
}: {
	mode?: "light" | "dark";
	/** single meandering strand, or a woven preset (braid/helix/triple/twin) */
	vine?: VineStyle;
}) {
	const c = decorColors(mode);
	const vineColors = { stem: c.stem, flower: c.flower, bee: c.accent };
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
		</>
	);
}

export default MeadowVines;

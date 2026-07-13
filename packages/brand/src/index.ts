// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @anthers/brand — shared, recolor-ready icon/illustration assets for every
// Anthers deployment. Framework-agnostic on purpose: it exports the raw icon
// geometry plus string/data-URI helpers, so each surface (web React, desktop,
// react-native-svg, …) can render it however it likes.
//
// The `icons` map is generated from svg/*.svg by scripts/build-icons.ts.
// - compose.ts: low-level icon → markup/data-URI/`<g>` helpers.
// - decor.ts:   higher-level botanical background generators (vines, grass,
//               pollen) that compose those assets into tiling SVG data URIs.

export type { BrandIcon, BrandIconName } from "./compose";
export { iconDataUri, iconGroup, iconSvg, icons } from "./compose";
export type { VineStrand, VineStyle, VineWave, VineWaveName } from "./decor";
export {
	grassFloorDataUri,
	leafD,
	pollenDataUri,
	VINE_WAVES,
	VINE_WEAVES,
	vineTileDataUri,
	wovenVineTileDataUri,
} from "./decor";

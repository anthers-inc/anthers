// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compatibility shim for the design lab. The botanical decor that started here has
// graduated into shared packages during the Meadow site migration:
//   • SVG string generators (vines, grass, pollen) → @anthers/brand
//   • React line-art + the recolor glyph            → @anthers/web-shared/decor
// This file just re-exports them under the old paths so the remaining lab variants
// keep importing from "./botanical" unchanged. New code should import from the
// packages directly.

export {
	grassFloorDataUri,
	pollenDataUri,
	VINE_WAVES,
	VINE_WEAVES,
	type VineStrand,
	type VineStyle,
	type VineWave,
	type VineWaveName,
	vineTileDataUri,
	wovenVineTileDataUri,
} from "@anthers/brand";
export { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
export { Branch, Frond, SideVine, Sprig } from "@anthers/web-shared/decor/LineArt";

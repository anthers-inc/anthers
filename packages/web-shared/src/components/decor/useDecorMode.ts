// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useDecorMode — the live light/dark mode for the baked-color decor layer. The decor SVGs
// bake concrete colors (a background can't inherit currentColor), so they can't ride
// DaisyUI's CSS-var swap the way normal UI does; they have to re-render with the other
// palette when the theme flips. This is just the shared `useTheme()` under a decor-scoped
// name, so <MeadowDecor>/<MeadowVines>/<MeadowFloor> recolor on toggle (or on the
// account-preference sync) without threading theme state into this package.

export { useTheme as useDecorMode } from "../../lib/theme";

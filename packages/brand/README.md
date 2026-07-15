# @anthers/brand

Shared Anthers brand assets — icon and illustration SVGs, **recolor-ready**, meant to be consumed by every Anthers deployment (the web SPA, a future desktop/Electron build, mobile, etc.). Mirrors the role `@polysemy/brand` plays across the Polysemy repos.

The source of truth is the raw SVG files in `svg/`. A small codegen normalizes them into a framework-agnostic TypeScript map so any surface can render them however it likes (inline React SVG, CSS `mask`/`background`, `react-native-svg`, …), and — crucially — **recolor them from code** to match each theme/palette, exactly like the hand-drawn lab illustrations do with `currentColor`.


# Adding an icon

1. Download the icon from The Noun Project as **SVG**, **single-color black** (size is irrelevant for vector; prefer the paid download so there's no attribution watermark baked in). Multi-color art won't recolor from a single value — use single-color unless you want its colors fixed.
2. Drop the file into `svg/` with a clear kebab-case name, e.g. `svg/bee.svg`, `svg/bee-worker.svg`.
3. Run the codegen:
   ```bash
   cd packages/brand && bun run build
   ```
   This rewrites `src/generated/icons.ts`. The codegen strips XML noise, `<title>`/`<metadata>`, and baked-in solid fills so the color is controlled by the consumer. (`fill="none"` is preserved, so stroke-only art passes through untouched — but it won't recolor from a single value.)
4. Record its provenance/license in `THIRD-PARTY.md`.


# Using it

`@anthers/brand` is framework-agnostic — it exports geometry + string helpers, not components:

```ts
import { icons, iconSvg, iconDataUri, iconGroup } from "@anthers/brand";

iconSvg("bee", "oklch(70% 0.14 74)");        // full <svg> string, filled amber
iconDataUri("bee", "#1b3a24");               // data: URI for background-image / <img src> / mask-image
iconGroup("bee", { x: 80, y: 430, size: 14, color: c.bee }); // <g> to splice INTO another SVG string
icons.bee;                                    // { viewBox, inner } — build your own renderer
```

- **Recolor inline (React):** `dangerouslySetInnerHTML={{ __html: icons.bee.inner }}` inside an `<svg fill="currentColor">`, then set color with `text-*`.
- **Recolor without inlining (any single-color icon):** use `iconDataUri(name)` as a CSS `mask-image` on a `<span>` and set `background-color: currentColor` — the icon's alpha is the mask, so it takes whatever color you give it.
- **Compose into generated SVG backgrounds** (e.g. the lab's tiled vine): splice `iconGroup(...)` into the SVG string.


# Logo lockups (raster)

The Anthers wordmark lockup lives in `logo/` as full-colour PNGs — a raster placeholder for now, deliberately outside the recolor-ready SVG pipeline above (a full-colour logo can't recolor from a single value). Four cuts, exported by path (`./logo/*`) so any surface's bundler emits them as hashed assets:

- `anthers-lockup.png` / `anthers-lockup-dark.png` — full lockup with the "Our Creative Garden" tagline, for light / dark backgrounds.
- `anthers-lockup-oneline.png` / `anthers-lockup-oneline-dark.png` — wordmark only (no tagline), the compact navbar cut.

```ts
import lockup from "@anthers/brand/logo/anthers-lockup.png"; // → hashed URL string
```

On web surfaces, prefer the shared `<Logo>` component (`@anthers/web-shared/ui/Logo`), which wraps these four and swaps light/dark live off the active theme. Swap the files here to reship the mark everywhere at once.


# Licensing

The package's own code is AGPL-3.0-or-later. **Icon artwork in `svg/` may be third-party** (e.g. The Noun Project) under its own license — those files are exempt from the repo's AGPL SPDX-header convention. Every asset's source and license is recorded in `THIRD-PARTY.md`. Before committing third-party assets to this public repo, confirm the source's license permits redistributing the raw files.

# @anthers/brand

The Anthers brand assets that **ship**: the first-party marks and lockups, and recolor-ready icon markup generated from the icon library. Consumed by every surface — the web SPA, the desktop shell, and anything later.

```
marks/        First-party Anthers identity — SVG masters, lockups, raster exports
src/          The public API + generated icon markup
scripts/      The codegen
```


# Where the icon library is, and why it isn't here

The botanical icon set behind `iconSvg`/`iconGroup`/`iconDataUri` is ~650 Noun Project SVGs. It lived in this package until 2026-08-14, when it was **14 MiB of a 15.6 MiB repository — 91% of everything tracked**, to promote 18 icons into code. A platform's repository should not be, by weight, an icon mirror.

It now lives in a **private** repository alongside the layered design working files: the studio, as against this package, which is the product. 🚨 **Private because it mixes Anthers' own working files with ~650 licensed Noun Project SVGs**, and a repository that is 91% somebody else's art is not one Anthers should be publishing wholesale. The 18 icons the product actually ships are here, in `src/generated/icons.ts`, and their attribution is in [`THIRD-PARTY.md`](./THIRD-PARTY.md) — which is the attribution of record precisely because this is the repository that redistributes them.

**The split costs the app nothing**, which is what made it cheap. `src/generated/icons.ts` inlines each curated icon's `viewBox` and path markup, `src/` never reads the source tree, and nothing imports a raw SVG. **The app builds identically with the library absent** — verified by regenerating with it present and diffing: byte-identical. What you lose without a checkout is only the ability to re-run the codegen, so `bun run build` prints a pointer and exits 0 rather than failing.


# Adding an icon

1. Check out the icon library beside this repo (`~/Anthers-Brand`), or set `BRAND_SOURCE=/path/to/checkout`. ⚠️ **That library is private, so this step is Anthers-internal** — an outside contributor cannot re-run the codegen, and does not need to: `src/generated/icons.ts` is committed and complete, and the app builds identically without the source.
2. Find the art. Its `preview/` holds per-collection contact sheets — the filenames are Noun Project `noun-<type>-<id>` and are not individually descriptive, so browse visually. If you're adding *new* art, download it as **SVG, single-color black**; multi-color art can't recolor from one value.
3. Add `{ id, path }` to `CURATED` in `scripts/build-icons.ts`, with the path relative to the library's `svg/`.
4. `cd packages/brand && bun run build`, and commit the regenerated `src/generated/icons.ts`.

The codegen strips XML noise, `<title>`/`<metadata>`, and baked-in solid fills so the consumer controls the color. (`fill="none"` is preserved, so stroke-only art passes through — but it won't recolor from a single value.)

⚠️ **A source tree that exists but is missing a curated path is a hard error, not a skip.** Carrying on would silently drop an icon the app renders by id, so the codegen exits 1 and names what diverged. An *absent* library is fine; a *disagreeing* one is not.

🚨 **Restart the web dev server after a rebuild, or you get a stale bundle and a baffling error.** Bun's dev server watches `apps/web/src` and **not** `packages/brand`, so a regenerated `src/generated/icons.ts` does not reach a running server. The symptom is not "my new icon is missing" — it is `Cannot read properties of undefined (reading 'viewBox')`, thrown from wherever the icon is composed, which reads like a bug in the consumer rather than a stale build. (The `@anthers/brand` helpers warn-and-noop on an unknown id, so an id that is genuinely wrong fails quietly and differently; this one throws.)


# Using it

Framework-agnostic on purpose — it exports geometry and string helpers, not components:

```ts
import { icons, iconSvg, iconDataUri, iconGroup } from "@anthers/brand";

iconSvg("bee", "oklch(70% 0.14 74)");        // full <svg> string, filled amber
iconDataUri("bee", "#1b3a24");               // data: URI for background-image / <img src> / mask-image
iconGroup("bee", { x: 80, y: 430, size: 14, color: c.bee }); // <g> to splice INTO another SVG string
icons.bee;                                    // { viewBox, inner } — build your own renderer
```

- **Recolor inline (React):** `dangerouslySetInnerHTML={{ __html: icons.bee.inner }}` inside an `<svg fill="currentColor">`, then set color with `text-*`.
- **Recolor without inlining:** `iconDataUri(name)` as a CSS `mask-image` on a `<span>` with `background-color: currentColor` — the icon's alpha is the mask, so it takes whatever color you give it.
- **Compose into a generated SVG background** (the tiled vines, the meadow floor): splice `iconGroup(...)` into the SVG string. `decor.ts` builds on this.


# The marks

`marks/` is first-party Anthers identity. The palette and type notes are in `marks/README.txt`.

- **`marks/*.svg`** — the vector masters: the mark (light and reversed cuts), a flat single-color silhouette for stamps and tiny sizes, and the flower alone.
- **`marks/lockup/*.png`** — the wordmark lockups the app actually imports. Full-color raster, deliberately outside the recolor-ready pipeline above, because a full-color logo can't recolor from a single value. Four cuts: `anthers-lockup` / `-dark` carry the tagline; `-oneline` / `-oneline-dark` are the compact navbar cut.

	```ts
	import lockup from "@anthers/brand/marks/lockup/anthers-lockup.png"; // → hashed URL string
	```

	On web, prefer the shared `<Logo>` component (`@anthers/web-shared/ui/Logo`), which wraps all four and swaps light/dark off the active theme. Swap the files here to reship the mark everywhere at once.

- **`marks/export/*.png`** — raster exports at fixed sizes: 1024px marks, favicons, an apple-touch icon, and lockups on a cream ground.

	⚠️ **The favicons are not wired to anything.** `apps/web` ships no `<link rel="icon">` at all, so the site currently renders with the browser default while `favicon-32.png`, `favicon-64.png` and `apple-touch-icon-180.png` sit here unused. Wiring them means copying into `apps/web/public/` and adding the tags — noted here because the assets existing is what makes the gap easy to miss.

`app-icons/` used to sit here — Windows/macOS/Linux packaging icons reached by `tauri.conf.json` through a `../../../` path that bypassed this package's `exports`, because a Tauri config cannot resolve one. That relative path was the tell: they were desktop **packaging**, not brand art. They moved to [anthers-desktop](https://github.com/anthers-inc/anthers-desktop) with the app on 2026-08-14.


# Licensing

The package's own code is AGPL-3.0-or-later. `marks/` is first-party. The icon artwork is third-party and lives in the source repo with its attribution — see [`THIRD-PARTY.md`](./THIRD-PARTY.md) for the summary and the terms it rests on.

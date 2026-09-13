# @anthers/brand

The Anthers brand assets that **ship**: the official logo, and recolor-ready icon markup generated from Noun Project icons. Consumed by every surface — the web SPA, the desktop shell, and anything later.

```
logo/             The official logo — PSDs, their exports, and the generated web cuts
svg/              The source art for every curated icon — Noun Project SVGs
src/              The public API + generated icon markup
scripts/          The codegen
icons.json        The register — what the product uses, and what it is waiting on
provenance.json   Who drew each icon and under what license — generated from the API
```


# Where the icons come from

The botanical icons behind `iconSvg`/`iconGroup`/`iconDataUri` are Noun Project icons, used under Anthers' NounPro license, which requires no attribution. Each one is an SVG in `svg/`, and `src/generated/icons.ts` inlines its normalized `viewBox` and path markup, so `src/` never reads an SVG and the app builds without running the codegen. `svg/` holds only what the register names, so the repository carries no art the product does not use.

**Everything the codegen reads is committed**, so a fork can regenerate the icons as well as build the app. `bun run build --check` regenerates in memory and fails if `src/generated/icons.ts` no longer matches `svg/`, and `scripts/noun/authoring-time.test.ts` runs it.


# Adding an icon

🚨 **The codegen runs at AUTHORING time and must never become a build-time fetch.** `src/generated/icons.ts` and `svg/` are committed precisely so the app builds, and the icons regenerate, with no credentials and no network call — the reason a fork of this repository is genuinely buildable. `brand:search` and `brand:add` are **scripts a person runs and commits the output of**, exactly as this codegen is. Wiring a fetch into `bun run build` would put a vendor key on the deploy path for artwork that changes twice a year, cost an API call per asset on every cold build, and give that property away. `scripts/noun/authoring-time.test.ts` fails if the credential's name ever appears anywhere but `scripts/`.

⚠️ **Do not recolor at the source.** `normalize()` strips baked fills so one injected color controls each icon, and every consumer recolors from the design tokens — so a palette change re-downloads nothing, and must not start to. The Noun Project API will hand you a pre-colored file if you ask it to; the client refuses to pass the parameter.

**Three commands, and one job for a human.** Choosing happens against nearly ten million icons; the credential comes from the "Anthers Dev" Bitwarden project without your having to export anything.

```sh
bun run brand:search "wildflower" --style solid   # ids, terms, creators, licenses, permalinks
bun run brand:search --like 7595393              # icons drawn in the same hand — build a set
bun run brand:add 8040550 --as bloom-outline --why "reads at small size"
bun run brand:wanted                             # what is waiting on a file, with a link each
#   …open the links, save each as SVG single-color black, anywhere
bun run brand:collect                            # files them all and regenerates everything
```

`brand:add` fetches the artist, license and permalink, records the entry with the path its file will occupy, and puts it on the **wanted** list. `brand:collect` sweeps `~/Downloads` (or a directory you name), matches each file on the Noun Project id inside its filename — which is what their download already uses, so nothing needs renaming — files them into `svg/`, promotes them out of `wanted`, and regenerates `src/generated/icons.ts`.

`brand:wanted` needs no API key, so it works offline and in a fresh checkout, and it also lists any *curated* icon whose file has gone missing — from a person's side that is the same job. `brand:add --file <path>` does the whole thing in one step when you already have the file, and `--dry-run` shows provenance and destination without recording anything.

🚨 **Files come from the subscription and may never come from the API.** Creating the API key required agreeing that **the app will not cache SVG files** — a term in neither the published Terms of Use nor the API documentation — and writing an API-fetched SVG into `svg/` is the clearest instance of it. **The API supplies search and metadata; the NounPro subscription supplies files.** Opening a link is the one step that stays manual.

⚠️ **Do not reinstate an API fetch here on the grounds that the endpoint started working.** `/v2/icon/<id>/download` also refuses us today — `400 Must provide a hexadecimal color value` without `color`, `403 You are not authorized to edit this icon` with it, for SVG and PNG alike — and read alone that looks like a plan limitation to route around until it lifts. It is not: the constraint is contractual, so a fallback written for the day the plan changes is a breach that switches itself on when somebody upgrades for unrelated reasons. `scripts/noun/authoring-time.test.ts` fails if any script that writes to `svg/` so much as reaches for `downloadSvg`.

**`icons.json` is the register**, and it is readable by hand: `icons` is what the product uses, `wanted` is what it is waiting on, and each entry carries `why` it was chosen. `provenance.json` beside it holds the artist, license and permalink for every entry, fetched once and never typed. It is a record rather than a credit, and `scripts/noun/provenance.test.ts` audits it: ⚠️ **a hand-added entry fails until its provenance is fetched** — run `bun run brand:add --backfill` — and so does any icon under a license Anthers has not established it may use.

**`bun run brand:prune`** removes SVGs in `svg/` that nothing in the register names. It dry-runs by default and refuses to delete from a dirty checkout, because being able to `git restore` is the whole safety of it.

The codegen strips XML noise, `<title>`/`<metadata>`, and baked-in solid fills so the consumer controls the color. (`fill="none"` is preserved, so stroke-only art passes through — but it won't recolor from a single value.)

⚠️ **A curated path missing from `svg/` is a hard error, not a skip.** Carrying on would silently drop an icon the app renders by id, so the codegen exits 1 and names what diverged.

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


# The logo

`logo/` is Anthers' official logo and **the only place it is ever edited**. The art the site ships and the files it is made from live together here, so they are one copy rather than two to keep in step.

- **`logo/base/`** — the logo's layered PSD beside its exports: a one-line horizontal cut (`hone`), a two-line cut with the tagline (`htwo`), and a stacked cut with the orchids arched over the wordmark (`vert`), each for a light and a dark background.
- **`logo/preps/`** — the prepared versions, each PSD beside its exports: a 3:1 banner and a 1:1 thumb, both on a background.
- **`logo/web/`** — what the app actually loads, **generated**: every lockup trimmed to its artwork and scaled for the web, the tab and home-screen icons cut from the 1:1 thumb, and `manifest.json`.

**Re-export from a PSD, then run `bun run brand:logo` and commit what it writes.** The exports are 2560×1440 and several hundred kilobytes each, which is right for a source and wrong for a navbar, so the site never imports them directly. The generated files are committed rather than built, so the deploy path needs no image library. The manifest records the hash of every source and every output, and `scripts/brand-logo.test.ts` fails when either no longer matches — a re-export nobody regenerated, or an output somebody edited by hand. The script also writes `apps/web/public/brand/anthers-mark-256.png`, which is at a stable address on purpose; read `apps/web/public/brand/README.md` before touching it.

On web, use the shared `<Logo>` component (`@anthers/web-shared/ui/Logo`), which carries the three cuts and swaps light and dark off the active theme. Full-color art sits outside the recolor-ready icon pipeline above, because a full-color logo cannot recolor from a single value.

```ts
import lockup from "@anthers/brand/logo/web/lockup-tagline-light.png"; // → hashed URL string
```

The desktop app's packaging icons live in [anthers-desktop](https://github.com/anthers-inc/anthers-desktop), which packages the built web app rather than this package, and are made from the same 1:1 thumb.


# Licensing

The package's own code is Apache-2.0. `logo/` is Anthers' own brand art, owned by Anthers, Inc.; it is not covered by that license and may be used only in association with Anthers itself. The icon artwork in `svg/` and the markup generated from it are Noun Project art that Anthers uses under its own license, and the Apache license does not cover them; `provenance.json` records each icon's creator and license.

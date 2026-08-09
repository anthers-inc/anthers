# Third-party fonts

The four Meadow web families, self-hosted. These files are **not** covered by the repository's AGPL-3.0 license or its SPDX-header convention — all four are under the **SIL Open Font License 1.1**, whose text is in `OFL-1.1.txt` beside them.

| Family | Copyright | Upstream |
|---|---|---|
| **Caveat** | Copyright 2014 The Caveat Project Authors | [Impallari Type](https://github.com/googlefonts/caveat) |
| **Fraunces** | Copyright 2020 The Fraunces Project Authors | [Undercase Type](https://github.com/undercasetype/Fraunces) |
| **Nunito Sans** | Copyright 2016 The Nunito Sans Project Authors | [Fonthausen](https://github.com/Fonthausen/NunitoSans) |
| **Spectral** | Copyright 2017 The Spectral Project Authors | [Production Type](https://github.com/productiontype/Spectral) |

The OFL permits redistribution as part of this repository, bundled or not, provided the files are not sold on their own and the license travels with them — which is what this file and `OFL-1.1.txt` are for.


# Why these are self-hosted

They were loaded from `fonts.googleapis.com` until 2026-08-09. That sent **every visitor's IP address, user-agent and referring URL to Google on first paint**, before any consent existed and before the visitor had done anything but open the page. It was found while verifying the subprocessor list for the privacy policy (`51.05 Privacy Policy`, in the vault), and it is the kind of thing that policy's own "strictest applicable standard" decision rules out. A German court (LG München I, 3 O 17493/20) awarded damages against a site operator for exactly this pattern in 2022.

Self-hosting removes the disclosure question entirely rather than answering it: with no third-party request there is no third-party recipient, and nothing to put in the table.

**Do not reintroduce a CDN reference for these.** If a fifth family is added, vendor it the same way.


# How the files got here

`fonts.css` and the 83 `.woff2` files are the exact output of the `css2?family=…` request the site used to make, downloaded and rewritten to local paths. The 83 files are one per (family × style × weight × unicode subset); the `unicode-range` split is preserved, so a latin-only visitor still downloads only the latin cuts — five or six small files, not all 83.

To refresh or extend them, re-run the vendoring against the same URL and rewrite `url(…)` to `/fonts/<name>.woff2`. The naming convention is `family-style-weight-subset.woff2`.


# Two things that will surprise the next person

**These are static assets, not bundled ones — deliberately.** `apps/web/index.html` pulls them in with an inline `<style>@import "/fonts/fonts.css";</style>` rather than a `<link rel="stylesheet">`. The bundler resolves every `<link>` href and every `url()` in CSS it reaches, and it inlines webfonts as base64: routed through it, all 83 cuts collapse into a single render-blocking 4.5 MB chunk and the `unicode-range` split stops meaning anything. An inline `@import` passes through untouched. Setting `external: ["/fonts/*"]` in `build.ts` fixes the production build **only** — the dev server reads no such config and still fails to resolve.

**`public/fonts/` is committed; `public/vendor/` is not.** The sibling directory is gitignored and regenerated from `node_modules` by `vendor:ffmpeg`. Nothing regenerates this one. Deleting it doesn't fail a build — it silently drops the site to system fonts.


# Known gaps

**The Studio never had these fonts.** `apps/studio-web/index.html` carries no font link and never did, so `studio.anthers.org` has always rendered `FONTS.fraunces` etc. as their fallbacks (Georgia, system-ui). The comment in `packages/web-shared/src/styles/fonts.ts` claiming they are "loaded site-wide via `<link>` in each app's index.html" was wrong about the Studio. Unchanged here because fixing it changes how the Studio looks, which is a design call rather than a privacy one.

**KaTeX's own fonts are still inlined as base64**, ~1.8 MB of the built CSS chunk. Pre-existing and unrelated to this change — the `katex` package ships its `@font-face` block inside the CSS the bundler does process. Worth a separate look; it is pure page weight, not a privacy issue, since those files ship with the package rather than being fetched from anyone.

Vendored copy of foliate-js.

Upstream: https://github.com/johnfactotum/foliate-js (MIT; LICENSE carries the original
text). This tree is a **copy, not a submodule**: upstream publishes no releases and
states that its API changes at any time, so the pin is the copy itself and every patch
below is ours-side, recorded here, and kept upstream-contributable.

 Vendored at upstream commit 78914aef4466eb960965702401634c2cb348e9b1 (2026-05-01),
 "Use original hrefs for external links and add isExternal in fb2.js (#129)".

Only the modules the reflow ebook reader reaches are vendored: `view.js`, `paginator.js`,
`epub.js`, `epubcfi.js`, `progress.js`, `overlayer.js`, `text-walker.js` render and
measure; `search.js`, `tts.js` and `fixed-layout.js` ride unbuilt-but-bundled so the
view's dynamic imports resolve and the fork diff stays near zero. Upstream's format
adapters (`mobi.js`, `fb2.js`, `comic-book.js`, `pdf.js`) and their vendored
dependencies (`vendor/zip.js`, `vendor/fflate.js`, `vendor/pdfjs`) are deliberately NOT
vendored: Anthers decomposes sources at ingest, the page reader stays Anthers' own, and
PDF.js does not come along (the 2026-10-11 design's rule).

Patches (each numbered, ours-side, upstream-contributable):

1. `view.js` — the file-opening `makeBook` dispatch and its helpers (format sniffers,
   zip and directory loaders, the NotFound/Unsupported/Response error classes) are
   removed; `open()` takes a book interface object and throws on anything else. The
   reader builds that object from the access-ladder manifest (`GET /works/:id/sections`
   plus the section and asset routes); letting the view open a string, File or Blob
   would be a reader around the ladder's checks, so this is part of the security
   boundary, not dead-code trimming.
2. `view.js` — a guard comment; `open()` rejects non-object input for the same reason.
3. `epub.js` — `export` added to `Loader` and `resolveURL`. The Loader class is the
   engine's resource-rewriting machinery (`src`/`href`/`srcset`/CSS `url()`/inline
   styles rewritten against a loader's `loadText`/`loadBlob`) and Anthers' reader wants
   exactly that machinery driven by its ladder-backed loader, not a reimplementation of
   it; `resolveURL` is the one href resolver, cited from the reader glue.

The reader glue lives outside this tree (app code): where the loader maps
container-relative paths to ladder URLs, and the security decisions about what may
execute — those are Anthers' decisions, not upstream's, and do not belong in a vendored
file.
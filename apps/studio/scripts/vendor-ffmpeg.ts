// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vendor the SINGLE-THREADED ffmpeg.wasm runtime into `public/vendor/ffmpeg/` — the
 * same core the main site uses. The Studio authors with the parallel single-thread
 * encode (`@anthers/web-shared/transcode`, one worker per ladder rung) for now; the
 * multi-threaded core is deferred (see `vendor-ffmpeg-mt.ts` + epic E50). Mirrors
 * `apps/web/scripts/vendor-ffmpeg.ts` so both apps serve an identical, self-hosted,
 * same-origin runtime — no CDN or CSP dependency.
 *
 * We copy:
 *   - the ffmpeg ESM "class worker" + its sibling modules (`dist/esm/*.js`) — loaded
 *     as a module worker via `classWorkerURL`.
 *   - the single-threaded ESM core (`ffmpeg-core.js` + `ffmpeg-core.wasm`, ~32MB).
 *
 * The wasm lives in node_modules and is copied at build time, so it's never committed.
 * `public/vendor/` is gitignored; `build.ts` copies `public/` → `dist/` for the service.
 *
 * Run via `bun run vendor:ffmpeg` (wired as prebuild → predev).
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Resolve a package's installed dist dir via its package.json (hoisting-proof). */
function distDir(pkg: string, sub: string): string {
	return join(dirname(require.resolve(`${pkg}/package.json`)), sub);
}

const outDir = join(import.meta.dir, "..", "public", "vendor", "ffmpeg");
await mkdir(outDir, { recursive: true });

// 1. The ESM class-worker + siblings (const.js, errors.js, worker.js, …). Copy every
//    .js in the esm dir so the module worker's relative imports resolve same-origin.
const esmDir = distDir("@ffmpeg/ffmpeg", "dist/esm");
for (const name of await readdir(esmDir)) {
	if (name.endsWith(".js")) await cp(join(esmDir, name), join(outDir, name));
}

// 2. The single-threaded ESM core + wasm.
const coreDir = distDir("@ffmpeg/core", "dist/esm");
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
	await cp(join(coreDir, name), join(outDir, name));
}

console.log(`Vendored single-threaded ffmpeg.wasm runtime → ${outDir}`);

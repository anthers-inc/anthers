// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vendor the MULTI-THREADED ffmpeg.wasm runtime into `public/vendor/ffmpeg/`. The
 * Studio is cross-origin isolated (COOP+COEP → SharedArrayBuffer), so it uses
 * `@ffmpeg/core-mt` — which encodes across all cores. Unlike the single-threaded core
 * the main site vendors, the MT core ships a pthread `ffmpeg-core.worker.js` that must
 * be served same-origin alongside the core + wasm.
 *
 * The ~32MB wasm lives in node_modules and is copied here at build/dev time, so it's
 * never committed. `public/vendor/` is gitignored; `build.ts` copies `public/` → `dist/`.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function distDir(pkg: string, sub: string): string {
	return join(dirname(require.resolve(`${pkg}/package.json`)), sub);
}

const outDir = join(import.meta.dir, "..", "public", "vendor", "ffmpeg");
await mkdir(outDir, { recursive: true });

// 1. The ESM class-worker + siblings (const.js, errors.js, worker.js, …).
const esmDir = distDir("@ffmpeg/ffmpeg", "dist/esm");
for (const name of await readdir(esmDir)) {
	if (name.endsWith(".js")) await cp(join(esmDir, name), join(outDir, name));
}

// 2. The MULTI-THREADED core + wasm + its pthread worker.
const coreDir = distDir("@ffmpeg/core-mt", "dist/esm");
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"]) {
	await cp(join(coreDir, name), join(outDir, name));
}

console.log(`Vendored multi-threaded ffmpeg.wasm runtime → ${outDir}`);

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vendor the ffmpeg.wasm runtime into `public/vendor/ffmpeg/` so the browser can
 * transcode video client-side against a **same-origin, self-hosted** core — no CDN
 * or CSP dependency, and no COOP/COEP (single-threaded core, so cross-origin Spaces
 * images/embeds keep working).
 *
 * We copy:
 *   - the ffmpeg ESM "class worker" + its sibling modules (`dist/esm/*.js`) — loaded
 *     as a module worker via `classWorkerURL`, so we don't rely on the app bundler
 *     resolving `new Worker(new URL("./worker.js", import.meta.url))`.
 *   - the single-threaded ESM core (`ffmpeg-core.js` + `ffmpeg-core.wasm`, ~32MB),
 *     which the module worker dynamic-imports and whose wasm it fetches same-origin.
 *
 * The 32MB wasm lives in node_modules (a normal dependency) and is copied here at
 * build/dev time, so it never has to be committed to git. `public/vendor/` is
 * gitignored; `build.ts` copies `public/` into `dist/` for the static host.
 *
 * Run via `bun run vendor:ffmpeg` (wired as predev/prebuild).
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

console.log(`Vendored ffmpeg.wasm runtime → ${outDir}`);

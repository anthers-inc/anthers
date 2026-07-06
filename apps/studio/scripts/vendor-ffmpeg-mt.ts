// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DORMANT — not wired into any build (E50 Phase 2 deferred; `core-mt` hangs at
 * pthread-pool spawn in-browser). Kept as groundwork for a future in-browser MT debug
 * session / newer core / the desktop Studio. The active vendorer is `vendor-ffmpeg.ts`
 * (single-threaded core), which pairs with the parallel single-thread encode the Studio
 * uses today via `@anthers/web-shared/transcode`. See epic E50 — Creator Studio.
 *
 * Vendor the MULTI-THREADED ffmpeg.wasm runtime into `public/vendor/ffmpeg/`. The
 * Studio is cross-origin isolated (COOP+COEP → SharedArrayBuffer), so it uses
 * `@ffmpeg/core-mt` — which encodes across all cores. Unlike the single-threaded core
 * the main site vendors, the MT core ships a pthread `ffmpeg-core.worker.js` that must
 * be served same-origin alongside the core + wasm.
 *
 * The ~32MB wasm lives in node_modules and is copied here at build/dev time, so it's
 * never committed. `public/vendor/` is gitignored; `build.ts` copies `public/` → `dist/`.
 */
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

// 3. Patch the core to spawn its pthread workers as MODULE workers. The stock core
//    spawns them CLASSIC (`new Worker(url)`), but each pthread worker then does a
//    dynamic `import()` of the core — which silently HANGS in a classic worker in some
//    browsers, so the pthread pool never signals ready and `ffmpeg.load()` never
//    resolves. Module workers support dynamic import reliably.
const corePath = join(outDir, "ffmpeg-core.js");
const original = await readFile(corePath, "utf8");
const patched = original
	.replaceAll(
		'new Worker(new URL("ffmpeg-core.worker.js",import.meta.url))',
		'new Worker(new URL("ffmpeg-core.worker.js",import.meta.url),{type:"module"})',
	)
	.replaceAll("new Worker(pthreadMainJs)", 'new Worker(pthreadMainJs,{type:"module"})');
if (patched === original) {
	throw new Error(
		"vendor-ffmpeg: pthread Worker patch matched nothing — core-mt internals changed?",
	);
}
await writeFile(corePath, patched);

console.log(`Vendored + patched multi-threaded ffmpeg.wasm runtime → ${outDir}`);

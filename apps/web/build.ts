// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	minify: true,
	// Root-absolute asset URLs (/chunk-*.js) so deep SPA routes resolve them from
	// the site root. Without this, refreshing e.g. /user/project requests the JS
	// from /user/… → the SPA fallback returns index.html → module MIME error.
	publicPath: "/",
	plugins: [tailwind],
});

if (!result.success) {
	console.error("Build failed:");
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

// Copy static assets from public/ into dist/ — notably the vendored ffmpeg.wasm
// runtime at /vendor/ffmpeg/* (self-hosted, same-origin) that the browser video
// transcoder loads. `vendor:ffmpeg` (run by `bun run build`) populates
// public/vendor from node_modules first. When build.ts is run standalone without
// that step (e.g. the e2e / screenshot preview, which doesn't need ffmpeg),
// public/ may not exist yet — skip the copy rather than throwing ENOENT.
if (existsSync(`${import.meta.dir}/public`)) {
	await cp(`${import.meta.dir}/public`, `${import.meta.dir}/dist`, { recursive: true });
}

console.log(`Build complete: ${result.outputs.length} files (+ public/ assets)`);

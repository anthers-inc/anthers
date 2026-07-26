// SPDX-License-Identifier: AGPL-3.0-or-later
import { cp } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	minify: true,
	// Root-absolute asset URLs so deep routes resolve them from the site root.
	publicPath: "/",
	plugins: [tailwind],
});

if (!result.success) {
	console.error("Studio build failed:");
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

// Copy static assets from public/ into dist/ — the vendored multi-threaded ffmpeg.wasm
// runtime at /vendor/ffmpeg/* (`prebuild` populates public/vendor from node_modules).
await cp(`${import.meta.dir}/public`, `${import.meta.dir}/dist`, { recursive: true });

console.log(`Studio build complete: ${result.outputs.length} files (+ public/ assets)`);

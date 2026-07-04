// SPDX-License-Identifier: AGPL-3.0-or-later
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

console.log(`Build complete: ${result.outputs.length} files`);

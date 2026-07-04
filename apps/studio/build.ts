// SPDX-License-Identifier: AGPL-3.0-or-later
const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	minify: true,
	// Root-absolute asset URLs so deep routes resolve them from the site root.
	publicPath: "/",
});

if (!result.success) {
	console.error("Studio build failed:");
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

console.log(`Studio build complete: ${result.outputs.length} files`);

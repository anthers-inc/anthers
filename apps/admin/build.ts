// SPDX-License-Identifier: Apache-2.0
/**
 * Build the admin app into `dist/`, for the static site that serves `admin.anthers.org`.
 *
 * The same shape as `apps/web/build.ts`, including its repair of Bun's splitting output, and
 * without its `public/` copy: the admin app ships no webfonts and falls back to the theme's system
 * stacks, which is an acceptable cost for a tool a handful of people use.
 */
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = `${import.meta.dir}/dist`;
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	minify: true,
	splitting: true,
	// Root-absolute chunk URLs, so a deep route refreshed in place still finds its JS.
	publicPath: "/",
	plugins: [tailwind],
});

if (!result.success) {
	console.error("Build failed:");
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

// 🚨 Bun 1.3.9 points the HTML's module script at a leaf chunk when `splitting` is on, and the page
// then mounts nothing and reports no error. `apps/web/build.ts` carries the full account; this is the
// same assertion and repair.
const htmlOutput = result.outputs.find((o) => o.path.endsWith(".html"));
const jsEntry = result.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js"));
if (!htmlOutput || !jsEntry) {
	console.error("Build failed: expected an HTML output and a JS entry-point among the outputs");
	process.exit(1);
}
const moduleScript = /(<script\b[^>]*\btype="module"[^>]*\bsrc=")([^"]*)(")/;
const html = await Bun.file(htmlOutput.path).text();
const match = html.match(moduleScript);
if (!match) {
	console.error('Build failed: no <script type="module" src> in the emitted HTML');
	process.exit(1);
}
const entryUrl = `/${basename(jsEntry.path)}`;
if (match[2] !== entryUrl) {
	await Bun.write(htmlOutput.path, html.replace(moduleScript, `$1${entryUrl}$3`));
}

console.log(`Build complete: ${result.outputs.length} files`);

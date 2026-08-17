// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = `${import.meta.dir}/dist`;

// Wipe the output directory first. Chunk names are content-hashed, so a stale build
// leaves orphans that nothing references and nothing ever cleans up — tolerable when
// splitting produced one chunk, an accumulating pile of hundreds now that it produces
// eight hundred. It also removes the class of bug where a served file is older than
// the source in front of you.
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	minify: true,
	// Route-level chunks. Without this Bun INLINES every dynamic import, so the eight
	// React.lazy authoring pages in App.tsx ship to every reader (+484 KB) instead of
	// loading when someone opens the Studio.
	splitting: true,
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

// 🚨 Repoint the HTML's module script at the real JS entry-point.
//
// Bun 1.3.9 rewrites `<script type="module" src>` to the WRONG output when `splitting`
// is on: it emits a leaf chunk that only exports bindings, while the chunk carrying the
// `createRoot(...).render(...)` bootstrap — the one Bun itself labels `entry-point` in
// `result.outputs` — is never fetched at all. The page then loads seven chunks, mounts
// nothing, and reports NO error: blank body, empty console, HTTP 200 throughout. That
// silence is the expensive part, so assert rather than best-effort, and let the build
// fail loudly if the shape of Bun's output ever changes under us.
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
	console.log(`Repointed index.html: ${match[2]} → ${entryUrl} (Bun splitting bug)`);
}

// Copy static assets from public/ into dist/ — the self-hosted webfonts at /fonts/*,
// which must stay OUT of the bundler (see the fonts note in the Agents Hub: routed
// through it, all 83 subset cuts inline as base64 into one 4.5 MB chunk). Guarded
// because public/ is committed content rather than generated, so an absent directory
// should skip the copy rather than throw ENOENT.
if (existsSync(`${import.meta.dir}/public`)) {
	await cp(`${import.meta.dir}/public`, `${import.meta.dir}/dist`, { recursive: true });
}

console.log(`Build complete: ${result.outputs.length} files (+ public/ assets)`);

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web dev server. Bundles the SPA (with HMR + Tailwind) via Bun's HTML routes, and
 * ALSO serves `public/` static files — the vendored ffmpeg.wasm runtime at
 * `/vendor/ffmpeg/*` and the self-hosted webfonts at `/fonts/*` — which the plain
 * `bun ./index.html` server does not serve (it returns the SPA fallback, giving a
 * module-MIME error). Prod serves the same paths because `build.ts` copies
 * `public/` into `dist/`.
 *
 * The two differ in one way worth knowing: `public/vendor/` is gitignored and
 * regenerated from node_modules by `vendor:ffmpeg`, while `public/fonts/` is
 * committed — nothing regenerates it, and losing it would silently send the site
 * back to system fonts.
 */
import { serve } from "bun";
import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

/** Serve a file out of `public/`, 404ing rather than falling through to the SPA. */
const publicFile = async (req: Request) => {
	const { pathname } = new URL(req.url);
	const file = Bun.file(`./public${pathname}`);
	if (await file.exists()) return new Response(file);
	return new Response("Not found", { status: 404 });
};

const server = serve({
	port,
	development: { hmr: true, console: true },
	routes: {
		// Static files under public/. More specific than "/*", so these win.
		"/vendor/*": publicFile,
		"/fonts/*": publicFile,
		// Everything else: the bundled SPA (handles its own hashed JS/CSS chunks).
		"/*": index,
	},
});

console.log(`Web dev server on http://localhost:${server.port}`);

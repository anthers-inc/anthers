// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web dev server. Bundles the SPA (with HMR + Tailwind) via Bun's HTML routes, and
 * ALSO serves `public/` static files — the self-hosted webfonts at `/fonts/*` — which
 * the plain `bun ./index.html` server does not serve (it returns the SPA fallback,
 * giving a module-MIME error). Prod serves the same paths because `build.ts` copies
 * `public/` into `dist/`.
 *
 * `public/fonts/` is **committed** and nothing regenerates it; losing it would
 * silently send the site back to system fonts. (There was a second entry here, a
 * gitignored `public/vendor/` holding the ffmpeg.wasm runtime the browser encoder
 * loaded same-origin. That encoder was removed on 2026-08-17.)
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
		"/fonts/*": publicFile,
		// Everything else: the bundled SPA (handles its own hashed JS/CSS chunks).
		"/*": index,
	},
});

console.log(`Web dev server on http://localhost:${server.port}`);

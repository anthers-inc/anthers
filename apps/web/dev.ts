// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web dev server. Bundles the SPA (with HMR + Tailwind) via Bun's HTML routes, and
 * ALSO serves `public/` static files — notably the vendored ffmpeg.wasm runtime at
 * `/vendor/ffmpeg/*`, which the plain `bun ./index.html` server does not serve (it
 * returns the SPA fallback, giving a module-MIME error). Prod serves the same paths
 * because `build.ts` copies `public/` into `dist/`.
 */
import { serve } from "bun";
import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

const server = serve({
	port,
	development: { hmr: true, console: true },
	routes: {
		// Static files under public/ (e.g. /vendor/ffmpeg/ffmpeg-core.wasm). More
		// specific than "/*", so it wins for these paths.
		"/vendor/*": async (req) => {
			const { pathname } = new URL(req.url);
			const file = Bun.file(`./public${pathname}`);
			if (await file.exists()) return new Response(file);
			return new Response("Not found", { status: 404 });
		},
		// Everything else: the bundled SPA (handles its own hashed JS/CSS chunks).
		"/*": index,
	},
});

console.log(`Web dev server on http://localhost:${server.port}`);

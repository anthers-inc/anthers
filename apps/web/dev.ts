// SPDX-License-Identifier: Apache-2.0
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
import { devBuildApiOrigin, devBuildPage } from "./src/lib/dev-build-page.js";
import { assertPortFree } from "./src/lib/dev-port.js";

const port = Number(process.env.PORT ?? 3000);
assertPortFree(port);

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
		// The dev-only web-build harness, shared with serve.ts (the static preview). More
		// specific than "/*", so it wins over the SPA fallback — and it must, because the SPA
		// would boot into the SiteGate and the harness is meant to sit beside the gated app.
		"/dev/web-build": (req: Request) => devBuildPage(devBuildApiOrigin(req)),
		// Static files under public/. More specific than "/*", so these win.
		"/fonts/*": publicFile,
		// Everything else: the bundled SPA (handles its own hashed JS/CSS chunks).
		"/*": index,
	},
});

// 🚨 **Under portless, dev answers at a named URL, not a port.** `portless.json` names this
// app `anthers`; the proxy allocates the port it binds here, routes `https://anthers.localhost`
// to it, and the URL is what to print. Direct fallback (PORTLESS=0, or no portless on the
// machine) binds :3000 and the site is reached at `http://127.0.0.1:3000` — the `127.0.0.1`
// matters, because the ATProto dev OAuth callback is restricted to that spelling and cookies
// are host-scoped.
console.log(`Web dev server on ${process.env.PORTLESS_URL ?? `http://127.0.0.1:${server.port}`}`);

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Anthers Studio web service.
 *
 * The Studio is a SEPARATE, cross-origin-isolated origin (studio.anthers.org). DO
 * App Platform static sites can't set custom response headers, so the Studio is a
 * SERVICE that serves its built SPA and stamps the cross-origin-isolation headers on
 * every response:
 *   - Cross-Origin-Opener-Policy: same-origin
 *   - Cross-Origin-Embedder-Policy: require-corp
 * Together these make `self.crossOriginIsolated === true`, unlocking SharedArrayBuffer
 * (→ multi-threaded ffmpeg.wasm in Phase 2). Isolation is contained to THIS origin;
 * the consumer site (anthers.org) stays non-isolated so its cross-origin game/software
 * embeds keep working.
 *
 * Cross-origin subresources under require-corp must be CORS or carry CORP. Phase 1's
 * only cross-origin request is the credentialed `fetch` to anthers.org/api, which is a
 * CORS request (allowed). Spaces media previews (Phase 3) will need CORS/crossorigin.
 */
const PORT = Number(process.env.PORT ?? 3001);
const DIST = `${import.meta.dir}/dist`;

const ISOLATION_HEADERS: Record<string, string> = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

function withIsolation(res: Response): Response {
	for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.headers.set(k, v);
	return res;
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		// Serve a static file from dist/ when it exists…
		const file = Bun.file(`${DIST}${pathname}`);
		if (pathname !== "/" && (await file.exists())) {
			return withIsolation(new Response(file));
		}
		// …otherwise the SPA shell (client-side routing).
		return withIsolation(new Response(Bun.file(`${DIST}/index.html`)));
	},
});

console.log(`Anthers Studio on http://localhost:${PORT} (COOP+COEP isolated)`);

// SPDX-License-Identifier: Apache-2.0
/**
 * The web origin — production, and the preview the browser suite pairs with an API.
 *
 * This is the component that made per-Work link previews possible. The app itself is
 * still a client-rendered SPA: this server serves the built `dist/` exactly as the static
 * site did, and on a document request it swaps the shell's neutral share block for the
 * Work's own title, blurb and thumbnail (see `src/lib/share-head.ts`). Nothing else about
 * the page changes, so the SPA, its routes and its own data fetches are untouched.
 *
 * 🚨 **Fail open is the rule for the card.** No API reachable, a slow answer, a 404, a
 * malformed body — each returns the shell exactly as it shipped, which carries the site
 * card. A preview must never be able to take a page down, and the site card is a good
 * answer rather than a degraded one.
 *
 * 🚨 **The card read is the API's, not this process's.** `GET /api/content/works/:id/card`
 * applies the visibility gates and the rating rule beside the page route that owns them;
 * this server only renders what it is handed. Re-deriving "may this be shown" here would
 * be a second copy of the answer, and the copies would drift.
 *
 * The API origin: `API_ORIGIN` in the App Platform spec (`http://api`, over the app's
 * private network), `API_PORT` when the browser session starts a server beside a test
 * API, and the public site as the last resort so a missing variable degrades to a slower
 * read rather than to no previews at all.
 *
 * A browser session also needs the page itself to know that non-default API port: the SPA
 * reads the `anthers-dev-api-port` meta tag, and without it every call falls back to :8000
 * and the whole authenticated suite walks a signed-out page. `apps/admin/serve.ts` carries
 * the same tag for the same reason.
 */
import { resolve, sep } from "node:path";
import type { WorkPreview } from "@anthers/shared/work-preview";
import { devBuildApiOrigin, devBuildPage } from "./src/lib/dev-build-page.js";
import { injectShareHead } from "./src/lib/share-head.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST = resolve(import.meta.dir, "dist");

/**
 * The port of the API this preview pairs with, announced to the page when it is not the dev
 * default. A browser test session starts its API on a free port, and the page has no other way to
 * learn which; `rpc.ts` reads the tag. Only a digit string is ever written into the markup.
 */
const API_PORT = /^\d{2,5}$/.test(process.env.API_PORT ?? "") ? process.env.API_PORT : undefined;

/**
 * The API port the page must talk to, written into the document it is served with.
 *
 * 🚨 **A browser session puts the API on a free port, and the page has no other way to
 * learn which.** `rpc.ts`'s `devApiPort` reads this tag and falls back to `:8000`, so
 * without it every API call from a session-served page reaches `make dev`'s address (or
 * nothing at all) — the symptom is a signed-in page that still redirects to `/login`,
 * which reads as an auth bug rather than a missing tag. The static site this server
 * replaced used to carry the tag in its built HTML; this is the half that replaced it.
 *
 * Only a digit string is ever written into the markup, and only when a session supplied
 * one, so a production page can never be pointed at an address by its own document.
 */
const DEV_API_META =
	API_PORT !== undefined ? `<meta name="anthers-dev-api-port" content="${API_PORT}">` : "";

function withDevApiPort(html: string): string {
	return DEV_API_META ? html.replace("</head>", `${DEV_API_META}</head>`) : html;
}

const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? "https://anthers.org").replace(/\/$/, "");
const API_ORIGIN =
	process.env.API_ORIGIN?.replace(/\/$/, "") ??
	(API_PORT ? `http://127.0.0.1:${API_PORT}` : SITE_ORIGIN);

/** `/works/{slug}-{publicId}` — the one family this task renders. */
const WORK_PATH = /^\/works\/([^/]+)\/?$/;

async function indexHtml(): Promise<string> {
	const html = await Bun.file(resolve(DIST, "index.html")).text();
	// Announce a non-default API port to the page, the same way `apps/admin/serve.ts` does:
	// a browser session puts its API on a free port, and `rpc.ts` has no other way to learn
	// which. Without this the SPA falls back to :8000 and every call fails in a local run.
	if (!API_PORT) return html;
	return html.replace("<head>", `<head><meta name="anthers-dev-api-port" content="${API_PORT}">`);
}

/**
 * The Work's card, or null for the site card.
 *
 * A null answer is the neutral one for all of: not a Work path, no API, a 404 (which is
 * what an Adult Work, a withdrawn Work and a suspended creator's Work answer), a rating
 * above General (the endpoint answers `preview: null`), and any failure at all.
 */
async function workPreview(pathname: string): Promise<WorkPreview | null> {
	const match = WORK_PATH.exec(pathname);
	if (!match) return null;
	try {
		const res = await fetch(
			`${API_ORIGIN}/api/content/works/${encodeURIComponent(match[1])}/card`,
			{
				headers: { accept: "application/json" },
				// Long enough for a cold API, short enough that a crawler is not held.
				signal: AbortSignal.timeout(1500),
			},
		);
		if (!res.ok) return null;
		const body = (await res.json()) as { preview?: WorkPreview | null };
		return body.preview ?? null;
	} catch {
		return null;
	}
}

/**
 * Hashed bundle output can be cached forever; everything else gets an hour. The hash is
 * the guarantee, so only a name carrying one is marked immutable — `og-card.png` and the
 * fonts keep their names across deploys and must stay revalidatable.
 */
function cacheControl(pathname: string): string {
	return /-[a-z0-9]{8}\.[a-z0-9]+$/i.test(pathname)
		? "public, max-age=31536000, immutable"
		: "public, max-age=3600";
}

/** Resolve a request path inside `dist`, refusing anything that climbs out of it. */
function distFile(pathname: string): string | null {
	const file = resolve(DIST, `.${pathname}`);
	return file === DIST || file.startsWith(DIST + sep) ? file : null;
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/dev/web-build") return devBuildPage(devBuildApiOrigin(req, API_PORT));
		if (url.pathname === "/_health") return new Response("ok");
		if (url.pathname === "/index.html") {
			return new Response(withDevApiPort(await indexHtml()), {
				headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
			});
		}

		const file = (() => {
			try {
				return distFile(decodeURIComponent(url.pathname));
			} catch {
				return null;
			}
		})();
		if (file) {
			const asset = Bun.file(file);
			if (await asset.exists()) {
				return new Response(asset, {
					headers: { "Cache-Control": cacheControl(url.pathname) },
				});
			}
		}

		// SPA fallback: the shell, with this route's card when it has one.
		const [html, preview] = await Promise.all([indexHtml(), workPreview(url.pathname)]);
		return new Response(
			withDevApiPort(injectShareHead(html, preview, `${SITE_ORIGIN}${url.pathname}`)),
			{
				headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
			},
		);
	},
});

console.log(`Serving ${DIST} on port ${PORT} (API ${API_ORIGIN})`);

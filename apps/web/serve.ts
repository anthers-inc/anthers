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
 * 🚨 **A Work's page, a post's permalink and the share link that points at a Work all carry
 * that card.** A `/s/{token}` link is what the Share button hands a sharer, so it is the
 * address that actually gets pasted — and the token carries no slug, so the shell cannot
 * describe it without asking. The token resolves through the API's own read, each card comes
 * from the endpoint its document family owns, and the canonical address is the document's
 * own page: a share link is a locator and never a page, and it must not become one to a
 * crawler.
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
import { devBuildApiOrigin, devBuildPage } from "./src/lib/dev-build-page.js";
import { previewRoute } from "./src/lib/preview-route.js";
import { injectShareHead, type LinkCard } from "./src/lib/share-head.js";

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

async function indexHtml(): Promise<string> {
	return Bun.file(resolve(DIST, "index.html")).text();
}

/** The card a document is served with, and the address it canonically lives at. */
interface ServedPreview {
	preview: LinkCard;
	/** The document's own page, which is what the card and the canonical link name. */
	canonicalPath: string;
}

/** The API path family each document kind's card read lives under. */
const CARD_FAMILY = { work: "works", post: "posts" } as const;

/**
 * Who a document path is about, as the card endpoint's parameter and the canonical path.
 *
 * A Work's page and a post's permalink carry both in their own address. A share link
 * carries an opaque token, so it costs one read to learn which Work it names — and that
 * read is the API's, answered with the slug and public id the Work's own page would use.
 */
async function shareTarget(
	token: string,
	signal: AbortSignal,
): Promise<{ kind: "work"; param: string; canonicalPath: string } | null> {
	const res = await fetch(`${API_ORIGIN}/api/content/share/${encodeURIComponent(token)}`, {
		headers: { accept: "application/json" },
		signal,
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { slug?: unknown; publicId?: unknown };
	if (typeof body.slug !== "string" || body.slug === "") return null;
	if (typeof body.publicId !== "number") return null;
	const param = `${body.slug}-${body.publicId}`;
	return { kind: "work", param, canonicalPath: `/works/${param}` };
}

/**
 * The card the document at this path is served with, or null for the site card.
 *
 * A null answer is the neutral one for all of: a route with no card, no API, a 404 (which
 * is what an Adult Work, a withdrawn Work, a suspended creator's Work and an unpublished
 * post answer), a rating above General (the endpoint answers `preview: null`), and any
 * failure at all.
 */
async function previewFor(pathname: string): Promise<ServedPreview | null> {
	const route = previewRoute(pathname);
	if (!route) return null;
	// One deadline for the whole lookup, so a share link cannot spend the budget twice.
	const signal = AbortSignal.timeout(1500);
	try {
		const target = route.kind === "share" ? await shareTarget(route.token, signal) : route;
		if (!target) return null;
		const res = await fetch(
			`${API_ORIGIN}/api/content/${CARD_FAMILY[target.kind]}/${encodeURIComponent(target.param)}/card`,
			{ headers: { accept: "application/json" }, signal },
		);
		if (!res.ok) return null;
		const body = (await res.json()) as { preview?: LinkCard | null };
		if (!body.preview) return null;
		return { preview: body.preview, canonicalPath: target.canonicalPath };
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
		const [html, served] = await Promise.all([indexHtml(), previewFor(url.pathname)]);
		const canonical = `${SITE_ORIGIN}${served?.canonicalPath ?? url.pathname}`;
		return new Response(withDevApiPort(injectShareHead(html, served?.preview ?? null, canonical)), {
			headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
		});
	},
});

console.log(`Serving ${DIST} on port ${PORT} (API ${API_ORIGIN})`);

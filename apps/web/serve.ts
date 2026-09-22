// SPDX-License-Identifier: Apache-2.0
const PORT = parseInt(process.env.PORT || "3000", 10);

/**
 * The port of the API this preview pairs with, announced to the page when it is not the dev
 * default. A browser test session starts its API on a free port, and the page has no other way to
 * learn which; `rpc.ts` reads the tag. Only a digit string is ever written into the markup.
 */
const API_PORT = /^\d{2,5}$/.test(process.env.API_PORT ?? "") ? process.env.API_PORT : undefined;

async function indexHtml(): Promise<Response> {
	const file = Bun.file("./dist/index.html");
	if (!API_PORT) return new Response(file);
	const html = (await file.text()).replace(
		"<head>",
		`<head><meta name="anthers-dev-api-port" content="${API_PORT}">`,
	);
	return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}

import { devBuildApiOrigin, devBuildPage } from "./src/lib/dev-build-page.js";

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/dev/web-build") return devBuildPage(devBuildApiOrigin(req, API_PORT));
		if (url.pathname === "/index.html") return indexHtml();
		// Try serving static file from dist/
		const file = Bun.file(`./dist${url.pathname}`);
		if (await file.exists()) return new Response(file);
		// SPA fallback: return index.html for all other routes
		return indexHtml();
	},
});

console.log(`Serving on port ${PORT}`);

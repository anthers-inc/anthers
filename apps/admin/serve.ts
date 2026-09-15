// SPDX-License-Identifier: Apache-2.0
/**
 * Preview server for a built admin app — the browser tests' target, never production, which serves
 * `dist/` as a static site. It announces a non-default API port to the page the same way
 * `apps/web/serve.ts` does, which is how `rpc.ts` finds a test session's API.
 */
const PORT = Number.parseInt(process.env.PORT || "3001", 10);
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

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/index.html") return indexHtml();
		const file = Bun.file(`./dist${url.pathname}`);
		if (await file.exists()) return new Response(file);
		return indexHtml();
	},
});

console.log(`Serving the admin app on port ${PORT}`);

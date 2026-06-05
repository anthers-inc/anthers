const PORT = parseInt(process.env.PORT || "3000");

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		// Try serving static file from dist/
		const file = Bun.file(`./dist${url.pathname}`);
		if (await file.exists()) return new Response(file);
		// SPA fallback: return index.html for all other routes
		return new Response(Bun.file("./dist/index.html"));
	},
});

console.log(`Serving on port ${PORT}`);

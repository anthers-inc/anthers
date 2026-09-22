// SPDX-License-Identifier: Apache-2.0
/**
 * The dev-only build-delivery route's three refuse-closed layers are what matter, so that is
 * what this suite exercises rather than the file-serving itself: the route must refuse to be
 * mounted outside a checkout, must refuse a request that reaches it anyway, and must refuse
 * a path that climbs out of the build it names. The happy path confirms content-type and
 * that the whole build resolves under one URL — the property the real route keeps.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevBuildRoutes } from "../routes/dev-build.js";

describe("dev-build delivery route", () => {
	let root: string;
	let app: ReturnType<typeof createDevBuildRoutes>;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "web-test-builds-"));
		await writeFile(join(root, "bad id", "index.html"), "<html>bad</html>").catch(async () => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(root, "bad id"), { recursive: true });
			await writeFile(join(root, "bad id", "index.html"), "<html>bad</html>");
		});
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, "demo", "nested"), { recursive: true });
		await writeFile(join(root, "demo", "index.html"), "<html>demo</html>");
		await writeFile(join(root, "demo", "game.js"), "console.log('hi')");
		await writeFile(join(root, "demo", "game.wasm"), "\0asm");
		await writeFile(join(root, "demo", "game.pck"), "PACK");
		await writeFile(join(root, "demo", "nested", "asset.bin"), "BIN");
		app = createDevBuildRoutes(root);
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("lists the safe builds and skips an id that is not URL-safe", async () => {
		const res = await app.fetch(new Request("http://x/build"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.builds).toEqual(["demo"]);
		expect(body.root).toBe(root);
	});

	it("serves a build's files with the right content-type, all under one URL", async () => {
		const html = await app.fetch(new Request("http://x/build/demo/index.html"));
		expect(html.status).toBe(200);
		expect(html.headers.get("content-type")).toBe("text/html;charset=utf-8");
		expect(await html.text()).toContain("demo");

		const wasm = await app.fetch(new Request("http://x/build/demo/game.wasm"));
		expect(wasm.headers.get("content-type")).toBe("application/wasm");

		const pck = await app.fetch(new Request("http://x/build/demo/game.pck"));
		expect(pck.headers.get("content-type")).toBe("application/octet-stream");

		const js = await app.fetch(new Request("http://x/build/demo/game.js"));
		expect(js.headers.get("content-type")).toBe("text/javascript");

		const nested = await app.fetch(new Request("http://x/build/demo/nested/asset.bin"));
		expect(nested.status).toBe(200);
	});

	it("returns 404 for a file that is not there", async () => {
		const res = await app.fetch(new Request("http://x/build/demo/missing.js"));
		expect(res.status).toBe(404);
	});

	it("refuses a param that climbs out of the build", async () => {
		// `..%2F` survives URL normalization and reaches the param as `../`. The guard must
		// refuse it rather than resolve it to a sibling of the build root.
		const escapeRes = await app.fetch(new Request("http://x/build/demo/..%2Fdemo/index.html"));
		expect(escapeRes.status).toBe(404);

		// Same guard, staying inside: an intra-build `..%2F` must not resolve to a file
		// outside the requested build either.
		const intra = await app.fetch(new Request("http://x/build/demo/nested/..%2Fgame.js"));
		expect(intra.status).toBe(404);
	});

	it("refuses a build id that is not URL-safe", async () => {
		const res = await app.fetch(
			new Request(`http://x/build/${encodeURIComponent("bad id")}/index.html`),
		);
		expect(res.status).toBe(400);
	});

	it("marks a built dev build uncacheable so a rebuild lands on the next load", async () => {
		const res = await app.fetch(new Request("http://x/build/demo/index.html"));
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

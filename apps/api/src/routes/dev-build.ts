// SPDX-License-Identifier: Apache-2.0
/**
 * Dev-only web-game-build delivery: serve the files of a build dropped in a directory,
 * through the same access-checked shape every other delivery uses, with no Work.
 *
 * This exists so a real web build (a Godot export — `index.html`, the loader `.js`,
 * `.wasm`, `.pck`, and their assets) can be played and its delivery behavior tested
 * before the feature that hosts builds ships. The plan for that feature is the task
 * *Host web game builds through the access-checked route*; this is its test harness.
 *
 * 🚨 **Dev-only, and every layer refuses closed.** The module exists for the dev server
 * and the browser suite, never for production. It is gated three ways, each independent:
 *
 *   1. The route is only registered when `apps/api/src/index.ts` sees `isDevCheckout()`.
 *   2. Mounting here calls `assertDevCheckout()`, so a route module bundled into the image
 *      would throw at boot rather than answer.
 *   3. Every request re-checks `isDevCheckout()`, so a route that somehow got mounted
 *      anyway still refuses. A missing value never removes a protection.
 *
 * The production shape this previews, and the two deviations a reader should know:
 *
 *   - **Same shape:** one URL prefix (`/api/dev/build/<id>/`) the page hands the runtime
 *     as its iframe `src`, and every file — `.wasm`, `.pck`, the loader — resolves
 *     against it, so nothing the game loads escapes the route. That is the property
 *     *How a File Reaches You* requires: a public `.pck` is an ungated copy of the game.
 *   - **Deviation — no per-request signing.** In production each file is authorized by a
 *     signed URL because the Anthers session is never sent to `anthers.run`. Here the
 *     directory is local and the gate is "this is a checkout," so signing would test
 *     nothing the real route won't.
 *   - **Deviation — no per-Work origin.** Production isolates each Work on its own
 *     `anthers.run` subdomain so saves in `user://` don't collide. This harness serves
 *     from the one dev origin, so saves are shared per origin across every build — fine
 *     for testing delivery, and the reason a "clear saves" control is on the page.
 *
 * ⚠️ **Cross-origin isolation (threaded builds) is deliberately left out.** A threaded
 * Godot build needs `COOP: same-origin` + `COEP: require-corp`, which infects every other
 * subresource on the page. Single-threaded is the engine's default and needs neither, so the
 * harness serves single-threaded builds. The task's posture decision is not made here.
 */

import { readdir } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { assertDevCheckout, devCheckoutRoot, isDevCheckout } from "@anthers/db/dev-only";
import { Hono } from "hono";

export const DEV_BUILD_ROOT_ENV = "WEB_TEST_BUILD_DIR";
const DEFAULT_BUILD_ROOT = "builds/web-test";

/**
 * The directory builds are served from. Overridable via `WEB_TEST_BUILD_DIR`, which
 * must point inside the checkout so a stray environment can't serve arbitrary files.
 * The checkout is anchored at the repository this module sits in — never `process.cwd()`,
 * which is whatever directory the session or suite was launched from.
 */
function buildRoot(moduleDir: string): string {
	const checkout = devCheckoutRoot(moduleDir);
	if (!checkout) throw new Error(`${DEV_BUILD_ROOT_ENV} is only meaningful in a checkout`);
	const root = resolve(checkout, process.env[DEV_BUILD_ROOT_ENV] ?? DEFAULT_BUILD_ROOT);
	if (root !== checkout && !root.startsWith(checkout + sep)) {
		throw new Error(
			`${DEV_BUILD_ROOT_ENV} must live inside the checkout — refusing to serve ${root}`,
		);
	}
	return root;
}

/** The ids a build directory may use. Conservative on purpose: ids become URLs. */
function isSafeBuildId(id: string): boolean {
	return /^[a-z0-9-]+$/.test(id);
}

/** A file path inside the build, kept under its root so `..` cannot climb out. */
function safeFileWithin(root: string, requestedPath: string): string | null {
	// 🚨 Reject any traversal segment outright, even one that *would* stay inside. Hono hands
	// the param URL-decoded, so an encoded `..` arrives as `..`; a browser-normalized plain
	// `..` never reaches us at all. Refusing rather than resolving makes the guard independent
	// of which normalization the request happened to survive.
	if (requestedPath.split("/").includes("..")) return null;
	const resolved = normalize(join(root, requestedPath));
	if (!resolved.startsWith(root + sep) && resolved !== root) return null;
	return resolved;
}

/** The content-type of the files a build actually contains. Everything else is octet-stream. */
function contentTypeFor(filePath: string): string {
	const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	return (
		{
			".html": "text/html;charset=utf-8",
			".js": "text/javascript",
			".mjs": "text/javascript",
			".wasm": "application/wasm",
			".pck": "application/octet-stream",
			".json": "application/json",
			".css": "text/css",
			".png": "image/png",
			".jpg": "image/jpeg",
			".svg": "image/svg+xml",
			".ico": "image/x-icon",
			".woff2": "font/woff2",
			".worker.js": "text/javascript",
			".data": "application/octet-stream",
			".zip": "application/zip",
		}[ext] ?? "application/octet-stream"
	);
}

/** The third refuse-closed layer, called on every request rather than once at setup. */
function refuseOutsideDev(c: {
	json: (data: unknown, status: number) => Response;
}): Response | null {
	return isDevCheckout() ? null : c.json({ error: "not available" }, 404);
}

export function createDevBuildRoutes(defaultRoot?: string): Hono {
	assertDevCheckout();
	const resolvedRoot = defaultRoot ? resolve(defaultRoot) : buildRoot(import.meta.dir);
	return new Hono()
		.get("/build", async (c) => {
			const refusal = refuseOutsideDev(c);
			if (refusal) return refusal;
			let ids: string[] = [];
			try {
				ids = (await readdir(resolvedRoot, { withFileTypes: true }))
					.filter((entry) => entry.isDirectory() && isSafeBuildId(entry.name))
					.map((entry) => entry.name)
					.sort();
			} catch {
				// Missing builds/ directory → an empty list, not an error: the harness is new.
			}
			return c.json({ root: resolvedRoot, builds: ids });
		})
		.get("/build/:id/:file{.+}", async (c) => {
			const refusal = refuseOutsideDev(c);
			if (refusal) return refusal;
			const id = c.req.param("id");
			if (!isSafeBuildId(id)) return c.json({ error: "bad build name" }, 400);
			const dir = join(resolvedRoot, id);
			const filePath = safeFileWithin(dir, c.req.param("file"));
			if (!filePath) return c.json({ error: "bad path" }, 404);
			const file = Bun.file(filePath);
			if (!(await file.exists())) return c.json({ error: "not found" }, 404);
			return new Response(file, {
				headers: {
					"Content-Type": contentTypeFor(filePath),
					// A dev build is not cacheable between edits; always revalidate so a rebuild
					// lands on the next load rather than being served from memory.
					"Cache-Control": "no-store",
				},
			});
		});
}

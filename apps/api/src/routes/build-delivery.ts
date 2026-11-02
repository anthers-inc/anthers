// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-build delivery: serve the files of a Work's hosted build on the Work's own
 * delivery origin, every request authorized by a short-lived signed play token and
 * resolved against the build's registered file list — *How a File Reaches You*'s rule,
 * carried to creator code.
 *
 * 🚨 **The session is never consulted here, by design and by contract.** The delivery
 * origin (`anthers.run` in production) never receives the Anthers session cookie — the
 * privacy policy promises so — so the entitlement is the token in the URL: minted
 * only by the play route at a moment access was just re-checked, expiring like every
 * other signed address. Any design that reads the cookie on this route is a regression
 * against the promise that no Anthers cookie crosses, which is why the check is a
 * token and nothing else.
 *
 * 🚨 **`work_build_files` is the delivery allowlist.** A requested path resolves against
 * the build's registered rows — the upload route registered each one under the same
 * path the build references it by — and nothing else. A file the creator did not
 * register is not served, whatever it is named on disk: one prefix, every file in the
 * list, nothing the build loads escaping the check. The dev harness (`dev-build.ts`)
 * previews the same property with a directory; this route stands on the database half
 * of it.
 *
 * ⚠️ **The path re-check happens here rather than being trusted to the upload route.**
 * Both ends run `buildPathProblem` (imported from `lib/web-build.ts`), so a path that
 * could escape a build cannot be registered *and* cannot resolve. Two checks of one
 * function is cheaper than one trust.
 *
 * Deviation a checkout runs with, and it is one: **no per-Work origin in dev.** The
 * delivery host is the API's own, so builds share per-origin saves in dev exactly as
 * the harness's do. `BUILD_ORIGIN_SUFFIX` set (dev or production) gives each Work its
 * `<publicId>`-suffixed host; the host guard is what tells the two apart.
 */

import { db } from "@anthers/db/client";
import { workBuildFiles, workBuilds, works } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { saveShimScript } from "../lib/save-shim-script.js";
import {
	buildFileContentType,
	contentTypeIsHtml,
	injectSaveShim,
	isBuildDeliveryHost,
	verifyPlayToken,
} from "../lib/web-build.js";
import { storage } from "../services/storage/index.js";

/**
 * Whether a request URL is addressed to build delivery — host check first, then the
 * path prefix. What the global X-Frame-Options stripper consults, so the header comes
 * off only for these responses and never for anything else.
 */
export function isBuildDeliveryRequest(url: string): boolean {
	const { host, pathname } = new URL(url);
	return pathname === "/build" || (pathname.startsWith("/build/") && isBuildDeliveryHost(host));
}

export function createBuildDeliveryRoutes(): Hono {
	return (
		new Hono()
			// ── One file of one build ──
			//
			// The token IS the path prefix — `/build/<token>/<entryPath>` — so the build's own
			// relative references resolve underneath without any HTML rewriting, the same
			// property the harness rides on. Tokens are opaque (`<base64url>.<mac>`), so no
			// path separator can hide inside one.
			.get("/:token/:file{.+}", async (c) => {
				if (!isBuildDeliveryHost(new URL(c.req.url).host)) {
					return c.json({ error: "not available" }, 404);
				}
				const payload = verifyPlayToken(c.req.param("token"));
				if (!payload) {
					// Expired, forged, or from a process whose secret died: none of them are
					// distinguishable to the holder, and none of them are served.
					return c.json({ error: "This play address has expired. Reload the Work's page." }, 403);
				}

				const workId = payload.w;
				const [work] = await db
					.select({
						id: works.id,
						publicId: works.publicId,
						visibility: works.visibility,
						quarantineStatus: works.quarantineStatus,
						takedownStatus: works.takedownStatus,
					})
					.from(works)
					.where(eq(works.id, workId))
					.limit(1);
				// A withdrawn, quarantined, taken-down or deleted Work invalidates every
				// outstanding token for it: the row is what the entitlement points at, and
				// when it goes the addresses go. The quarantine and takedown checks are what
				// kill a token minted before the finding; a signed URL is not revocable, but
				// this route is the one that reads it.
				if (
					!work ||
					work.visibility === "withdrawn" ||
					work.quarantineStatus === "quarantined" ||
					work.takedownStatus === "taken_down"
				) {
					return c.json({ error: "not found" }, 404);
				}

				const requestedPath = c.req.param("file");
				// 🚨 Re-run the path rules here rather than trusting the upload side. A path that
				// could escape the build never registered and never resolves. The bare `..`
				// segment check is the one that matters at this end (an encoded climb arrives
				// decoded); the register route's fuller check lives in `buildPathProblem`.
				if (!requestedPath || requestedPath.split("/").includes("..")) {
					return c.json({ error: "not found" }, 404);
				}

				// Find the build whose file list holds this path — the primary build is what a
				// play session means; a non-primary variant is registered storage, not content.
				const [build] = await db
					.select({ id: workBuilds.id })
					.from(workBuilds)
					.where(and(eq(workBuilds.workId, workId), eq(workBuilds.isPrimary, true)))
					.limit(1);
				if (!build) return c.json({ error: "not found" }, 404);

				const [file] = await db
					.select({
						storageKey: workBuildFiles.storageKey,
						contentType: workBuildFiles.mimeType,
					})
					.from(workBuildFiles)
					.where(and(eq(workBuildFiles.buildId, build.id), eq(workBuildFiles.path, requestedPath)))
					.limit(1);
				if (!file) return c.json({ error: "not found" }, 404);

				// There deliberately is no redirect to a signed storage URL: the object's own
				// signed address would outlive this check's answer by the storage TTL and be
				// re-shareable — the exact shape the playlist lesson warns about (a working set
				// of directions around the gate). HTML entries are small and get the save shim;
				// everything else streams in bounded chunks, because `storage.read` would put a
				// 500 MB engine build in a 512 MB api container's heap.
				const total = await storage.size(file.storageKey);
				if (total == null) return c.json({ error: "not found" }, 404);

				if (contentTypeIsHtml(requestedPath)) {
					if (total > 8 * 1024 * 1024) return c.json({ error: "not found" }, 404);
					const bytes = await storage.read(file.storageKey);
					if (!bytes) return c.json({ error: "not found" }, 404);
					const html = new TextDecoder().decode(bytes);
					// The shim's engine family is a constant of the shim itself ("godot" —
					// the IDBFS record shape is what restore is written against); the save
					// row's runtime col carries what the parent relayed, for the desktop
					// SDK's future restore path, not for this route.
					const shimmed = injectSaveShim(html, saveShimScript("godot"));
					return new Response(shimmed, {
						headers: {
							"Content-Type": buildFileContentType(requestedPath),
							"Cache-Control": "no-store",
							"X-Content-Type-Options": "nosniff",
						},
					});
				}

				const CHUNK = 4 * 1024 * 1024;
				let offset = 0;
				const stream = new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (offset >= total) {
							controller.close();
							return;
						}
						const length = Math.min(CHUNK, total - offset);
						const chunk = await storage.readRange(file.storageKey, offset, length);
						if (!chunk) {
							controller.error(new Error("build object disappeared mid-stream"));
							return;
						}
						offset += chunk.byteLength;
						controller.enqueue(chunk);
					},
				});
				return new Response(stream, {
					headers: {
						"Content-Type": file.contentType || buildFileContentType(requestedPath),
						"Content-Length": String(total),
						// Per-request: the token rides in the URL, so a response must never be
						// cached at a shared layer and replayed at a user the check would refuse.
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				});
			})
	);
}

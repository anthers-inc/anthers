// SPDX-License-Identifier: Apache-2.0
/**
 * The upload surface for a browser build: how a creator's multi-file export — an HTML
 * entry, the engine loader, a `.wasm`, a `.pck`, worklets, assets — becomes one build
 * unit attached to a game or software Work, with every file in the private bucket.
 *
 * 🚨 **This route registers objects; it never serves them.** Delivery is the access-checked
 * route this task's remaining half builds, and the split is the point: here a creator
 * uploads into their own prefix, and the only URLs returned are the ones the client needs
 * to PUT through — never a way to read a build back. A public `.pck` is an ungated copy of
 * the whole game, which is the storage split's private half exactly; not one file minted
 * here lands outside `creators/{id}/web-builds/`, and `PUBLIC_MEDIA_TYPES` does not know
 * this media type, so the ACL fails closed.
 *
 * 🚨 **Every file a client names as landed goes through `isOwnStorageRef`**, the same check
 * every other storage reference takes: a finalize naming another creator's object as one
 * of this build's files would put somebody else's bytes inside this build's delivery
 * prefix. The check lives in `services/storage/keys.ts`.
 *
 * The two-phase shape (presign per file below, register+finalize here) exists because a
 * build can carry hundreds of megabytes — the API must never buffer one. The direct
 * variant exists for local dev and small files, exactly as `/media-upload/direct` does.
 *
 * One build at a time is the unit of completeness: the row is created open, files are
 * registered as they land, and `complete` is the creator's own act of saying the file
 * list is whole. Nothing guesses when an export is finished.
 */

import { db, webBuildFiles, webBuilds, works } from "@anthers/db";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireCreator } from "../middleware/auth.js";
import { webBuildPrefix } from "../services/media-purge.js";
import { aclForMediaType } from "../services/storage/acl.js";
import { isLocalStorage, storage } from "../services/storage/index.js";
import { FOREIGN_FILE_REFUSAL, isOwnStorageRef } from "../services/storage/keys.js";

/** How large a single build file may be. A real export's `.pck` runs to tens of MB. */
const BUILD_FILE_MAX = 500 * 1024 * 1024;

/** The endpoint the local-dev direct upload POSTs to. */
function buildDirectPath(workId: number, buildId: number): string {
	return `/api/web-builds/works/${workId}/web-build/${buildId}/upload`;
}

/** One file path within the build. Refusals here are what keep every file inside the prefix. */
function buildPathProblem(value: string): string | null {
	if (value === "") return "Every file needs a name saying where it sits in the build.";
	if (value.startsWith("/") || value.endsWith("/")) {
		return "Paths are relative to the build's root, without leading or trailing slashes.";
	}
	if (value.includes("\\")) return "Paths use forward slashes.";
	if (value.includes("\0")) return "That path contains a character file names cannot carry.";
	const parts = value.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		return "A path in a build cannot climb out of the build with .. or name an empty segment.";
	}
	if (parts.some((p) => p.includes("?") || p.includes("#"))) {
		return "A path in a build cannot carry ? or # — the browser cuts the URL at them.";
	}
	if (value.length > 250) return "That path is too long.";
	return null;
}

const createSchema = z.object({
	label: z.string().max(120).optional().default(""),
	entryPath: z.string().max(250),
	/**
	 * Whether this build needs cross-origin isolation (a threaded export). Declared at
	 * create and fixed there: it decides where the build plays from, so changing it
	 * retroactively would move a live game's origin — the thing that strands saves.
	 * A creator who re-exports with a different posture uploads it as its own build.
	 */
	requiresIsolation: z.boolean().optional().default(false),
});

const registerSchema = z.object({
	files: z
		.array(
			z
				.object({
					path: z.string(),
					// The reference the presign/direct upload handed back; checked, never trusted.
					storageRef: z.string().max(500),
					fileSize: z.number().int().nonnegative().optional(),
					contentType: z.string().max(100).optional().default(""),
				})
				.superRefine((f, ctx) => {
					const problem = buildPathProblem(f.path);
					if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["path"] });
				}),
		)
		.min(1)
		.max(1000),
});

const finalizeSchema = z.object({
	entryPath: z.string().max(250).optional(),
	isPrimary: z.boolean().optional(),
	label: z.string().max(120).optional(),
});

/** The Work row a build request needs: owned by the caller, of a type that can carry a build. */
async function findOwnedBuildWork(workId: number, userId: number) {
	const [work] = await db
		.select({ id: works.id, type: works.type })
		.from(works)
		.where(and(eq(works.id, workId), eq(works.creatorId, userId)))
		.limit(1);
	if (!work) return null;
	return work.type === "game" || work.type === "software" ? work : "wrong-type";
}

const webBuildRoutes = new Hono()
	.use("*", requireAuth, requireCreator)
	// ── Create the build unit ──
	.post("/works/:id/web-build", zValidator("json", createSchema), async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		const work = await findOwnedBuildWork(workId, user.id);
		if (!work) return c.json({ error: "Work not found" }, 404);
		if (work === "wrong-type") {
			return c.json({ error: "Only a game or software Work carries a browser build." }, 400);
		}
		const { label, entryPath, requiresIsolation } = c.req.valid("json");
		const problem = buildPathProblem(entryPath);
		if (problem) return c.json({ error: problem }, 400);

		const [build] = await db
			.insert(webBuilds)
			.values({ workId, label, entryPath, requiresIsolation })
			.returning();
		return c.json({ build }, 201);
	})
	// ── Register files that have landed ──
	.post("/works/:id/web-build/:buildId/files", zValidator("json", registerSchema), async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		const buildId = Number(c.req.param("buildId"));
		const work = await findOwnedBuildWork(workId, user.id);
		if (!work) return c.json({ error: "Work not found" }, 404);
		if (work === "wrong-type") {
			return c.json({ error: "Only a game or software Work carries a browser build." }, 400);
		}
		const [build] = await db
			.select({ id: webBuilds.id })
			.from(webBuilds)
			.where(and(eq(webBuilds.id, buildId), eq(webBuilds.workId, workId)))
			.limit(1);
		if (!build) return c.json({ error: "Build not found" }, 404);

		const { files } = c.req.valid("json");
		for (const f of files) {
			// The reference a client hands us names an object that will be served as part
			// of this build, so it takes the same check every file reference takes.
			if (!(await isOwnStorageRef(f.storageRef, user.id))) {
				return c.json(FOREIGN_FILE_REFUSAL, 400);
			}
		}

		const inserted = await db
			.insert(webBuildFiles)
			.values(
				files.map((f) => ({
					buildId,
					path: f.path,
					storageKey: f.storageRef,
					fileSize: f.fileSize ?? 0,
					mimeType: f.contentType ?? "",
				})),
			)
			.onConflictDoUpdate({
				target: [webBuildFiles.buildId, webBuildFiles.path],
				set: {
					storageKey: sql`excluded.storage_key`,
					fileSize: sql`excluded.file_size`,
					mimeType: sql`excluded.mime_type`,
				},
			})
			.returning();
		return c.json({ files: inserted }, 201);
	})
	// ── Say the file list is whole ──
	.post("/works/:id/web-build/:buildId/complete", zValidator("json", finalizeSchema), async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		const buildId = Number(c.req.param("buildId"));
		const work = await findOwnedBuildWork(workId, user.id);
		if (!work) return c.json({ error: "Work not found" }, 404);
		if (work === "wrong-type") {
			return c.json({ error: "Only a game or software Work carries a browser build." }, 400);
		}
		const [build] = await db
			.select({ id: webBuilds.id, entryPath: webBuilds.entryPath })
			.from(webBuilds)
			.where(and(eq(webBuilds.id, buildId), eq(webBuilds.workId, workId)))
			.limit(1);
		if (!build) return c.json({ error: "Build not found" }, 404);

		const data = c.req.valid("json");
		const entryPath = data.entryPath ?? build.entryPath;
		const entryProblem = buildPathProblem(entryPath);
		if (entryProblem) return c.json({ error: entryProblem }, 400);

		const [fileCount] = await db
			.select({ count: count() })
			.from(webBuildFiles)
			.where(eq(webBuildFiles.buildId, buildId));
		if (!fileCount || fileCount.count === 0) {
			return c.json({ error: "A build completes with at least one file." }, 400);
		}
		const [entry] = await db
			.select({ id: webBuildFiles.id })
			.from(webBuildFiles)
			.where(and(eq(webBuildFiles.buildId, buildId), eq(webBuildFiles.path, entryPath)))
			.limit(1);
		if (!entry) {
			return c.json(
				{ error: "The entry point has to be one of the build's registered files." },
				400,
			);
		}

		// The count is authoritative here rather than the client's list: the first build ever
		// completed on this Work becomes its primary unless the creator asked for something
		// else, and any explicit true (or a first build) clears the old primary first — the
		// partial unique index below backs this up against a writer that skips the flip.
		const [primaryCount] = await db
			.select({ count: count() })
			.from(webBuilds)
			.where(and(eq(webBuilds.workId, workId), eq(webBuilds.isPrimary, true)));
		const wantPrimary = data.isPrimary ?? (primaryCount?.count ?? 0) === 0;
		if (wantPrimary) {
			await db
				.update(webBuilds)
				.set({ isPrimary: false })
				.where(and(eq(webBuilds.workId, workId), eq(webBuilds.isPrimary, true)));
		}
		const [updated] = await db
			.update(webBuilds)
			.set({
				entryPath,
				label: data.label ?? undefined,
				isPrimary: wantPrimary || undefined,
				updatedAt: new Date(),
			})
			.where(eq(webBuilds.id, buildId))
			.returning();
		return c.json({ build: updated }, 200);
	})
	// ── Presign one file of this build ──
	// The generic /media-upload/presign mints UUID names, which would lose the relative
	// path a build resolves its files by — `index.js` has to stay `index.js`. So this
	// module mints its own keys, shaped exactly `creators/{id}/web-builds/{buildId}/{path}`,
	// with the private ACL (an ACL question about a build file has one answer).
	.post(
		"/works/:id/web-build/:buildId/presign",
		zValidator(
			"json",
			z.object({
				path: z.string().max(250),
				contentType: z.string().max(100).optional().default("application/octet-stream"),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const workId = Number(c.req.param("id"));
			const buildId = Number(c.req.param("buildId"));
			const work = await findOwnedBuildWork(workId, user.id);
			if (!work) return c.json({ error: "Work not found" }, 404);
			if (work === "wrong-type") {
				return c.json({ error: "Only a game or software Work carries a browser build." }, 400);
			}
			const [build] = await db
				.select({ id: webBuilds.id })
				.from(webBuilds)
				.where(and(eq(webBuilds.id, buildId), eq(webBuilds.workId, workId)))
				.limit(1);
			if (!build) return c.json({ error: "Build not found" }, 404);

			const { path, contentType } = c.req.valid("json");
			const problem = buildPathProblem(path);
			if (problem) return c.json({ error: problem }, 400);

			// webBuildPrefix carries the shape; the creator prefix wraps it. No `uuid.ext`
			// renaming: the build's own path IS the storage path under this prefix.
			const key = `creators/${user.id}/${webBuildPrefix(buildId)}${path}`;
			if (isLocalStorage) {
				// Local dev: the browser cannot PUT to a filesystem path, so the client POSTs
				// the bytes to the sibling upload route, which writes them. Same key shape.
				return c.json({
					method: "direct" as const,
					uploadUrl: buildDirectPath(workId, buildId),
					headers: {},
					key,
				});
			}
			const { url, headers } = await storage.getPresignedUploadUrl(
				key,
				contentType,
				aclForMediaType("web-build"), // not in PUBLIC_MEDIA_TYPES → private, the door we want
				3600,
			);
			return c.json({ method: "presigned" as const, uploadUrl: url, headers, key });
		},
	)
	// The direct half of the presign above — local dev only in effect, because a real
	// deployment answers from object storage. Keyed by the same build ownership gate.
	.post("/works/:id/web-build/:buildId/upload", async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		const buildId = Number(c.req.param("buildId"));
		const work = await findOwnedBuildWork(workId, user.id);
		if (!work) return c.json({ error: "Work not found" }, 404);
		if (work === "wrong-type") {
			return c.json({ error: "Only a game or software Work carries a browser build." }, 400);
		}
		const [build] = await db
			.select({ id: webBuilds.id })
			.from(webBuilds)
			.where(and(eq(webBuilds.id, buildId), eq(webBuilds.workId, workId)))
			.limit(1);
		if (!build) return c.json({ error: "Build not found" }, 404);

		const form = await c.req.formData();
		const file = form.get("file");
		const path = form.get("path");
		if (!(file instanceof File) || typeof path !== "string") {
			return c.json({ error: "A file and its build path are both required." }, 400);
		}
		const problem = buildPathProblem(path);
		if (problem) return c.json({ error: problem }, 400);
		if (file.size > BUILD_FILE_MAX) {
			return c.json({ error: "That file is too large for a build file." }, 413);
		}

		const key = `creators/${user.id}/${webBuildPrefix(buildId)}${path}`;
		const buffer = Buffer.from(await file.arrayBuffer());
		await storage.upload(key, buffer, file.type || "application/octet-stream", "private");
		return c.json({ key }, 201);
	})
	.delete("/works/:id/web-build/:buildId", async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		const buildId = Number(c.req.param("buildId"));
		const work = await findOwnedBuildWork(workId, user.id);
		if (!work) return c.json({ error: "Work not found" }, 404);
		if (work === "wrong-type") {
			return c.json({ error: "Only a game or software Work carries a browser build." }, 400);
		}
		const [build] = await db
			.select({ id: webBuilds.id })
			.from(webBuilds)
			.where(and(eq(webBuilds.id, buildId), eq(webBuilds.workId, workId)))
			.limit(1);
		if (!build) return c.json({ error: "Build not found" }, 404);

		// Storage first (best-effort, it swallows failures), then the rows cascade. The
		// prefix sits under the creator's own, exactly as every upload key was minted;
		// deleting the bare `web-builds/{id}/` would sweep the wrong tree.
		try {
			await storage.deletePrefix(`creators/${user.id}/${webBuildPrefix(buildId)}`);
		} catch (err) {
			console.error(`[web-build] deletePrefix failed for build ${buildId}:`, err);
		}
		await db.delete(webBuilds).where(eq(webBuilds.id, buildId));
		return c.body(null, 204);
	});

export { webBuildRoutes };

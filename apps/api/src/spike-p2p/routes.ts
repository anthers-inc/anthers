// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery spike routes.
 *
 * Two endpoints, mounted under /api/spike-p2p:
 *
 * 1. POST /works/:id/assets/:assetId/manifest
 *    Access-checked (reuses the real resolveAccessSync via workAccessFor). If access is
 *    granted, mints a short-lived P2P token and returns the manifest + token. If denied,
 *    returns 403 with the access verdict — same shape as the existing download endpoint.
 *
 * 2. GET /works/:id/assets/:assetId/chunks/:index
 *    Verifies the P2P token (from the Authorization: Bearer header). If valid and
 *    unexpired, serves the chunk bytes. If not, 401. This is the hub-hosted seeder.
 *
 * The seeder reads the file once at startup (or on first request) and holds the manifest
 * + raw bytes in memory. For a spike with a ~10 MiB test file, this is fine. The real
 * implementation would read chunks from storage on demand.
 *
 * Bandwidth accounting: every chunk served from the seeder is counted as "hub-served
 * bytes." The spike doesn't have additional peers — the "without peers" case is the only
 * case — but the counter is here so the measurement is tractable when peers are added.
 */

import { db } from "@anthers/db/client";
import { assets, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bearerToken } from "../middleware/bearer.js";
import { buildAccessContext, resolveAccessSync } from "../services/access.js";
import { validateSession } from "../services/auth.js";
import { storage } from "../services/storage/index.js";
import { buildManifest, type Manifest } from "./chunking.js";
import { spikeP2pClient } from "./client.js";
import { mintP2pToken, verifyP2pToken } from "./token.js";
import { WEBRTC_CLIENT_HTML } from "./webrtc-client.js";

const TOKEN_TTL_SECONDS = 300; // 5 minutes — same as the existing download signed URL

// In-memory store: assetId -> { manifest, bytes, hubBytesServed }
// For the spike, we hold the whole file in memory. The real implementation wouldn't.
interface SeederEntry {
	manifest: Manifest;
	bytes: Uint8Array;
	hubBytesServed: number;
}
const seederStore = new Map<number, SeederEntry>();

/** Resolve a viewer from either a bearer token or the session cookie. */
async function resolveViewer(c: Parameters<typeof getCookie>[0]): Promise<number | null> {
	// Bearer first (the P2P client path)
	const bearer = bearerToken(c);
	if (bearer) {
		const result = await validateSession(bearer);
		return result?.user.id ?? null;
	}
	// Then cookie (the browser path)
	const cookie = getCookie(c, "session");
	if (cookie) {
		const result = await validateSession(cookie);
		return result?.user.id ?? null;
	}
	return null;
}

/** Load the asset file from storage and build the manifest. Caches in seederStore. */
async function getOrCreateSeederEntry(workId: number, assetId: number): Promise<SeederEntry> {
	const cached = seederStore.get(assetId);
	if (cached) return cached;

	const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
	if (!asset) throw new Error(`Asset ${assetId} not found`);

	const fileBytes = await storage.read(asset.file);
	if (!fileBytes) throw new Error(`Asset file not found in storage: ${asset.file}`);

	const manifest = await buildManifest({
		workId,
		assetId,
		storageKey: asset.file,
		filename: asset.filename,
		fileSize: asset.fileSize ?? fileBytes.length,
		mimeType: asset.mimeType ?? "application/octet-stream",
		bytes: fileBytes,
	});

	const entry: SeederEntry = {
		manifest,
		bytes: fileBytes,
		hubBytesServed: 0,
	};
	seederStore.set(assetId, entry);
	return entry;
}

export const spikeP2pRoutes = new Hono()
	// ── Manifest endpoint (access-checked, mints token) ──────────────────────────
	.post("/works/:id/assets/:assetId/manifest", async (c) => {
		const workIdParam = c.req.param("id");
		const assetId = Number(c.req.param("assetId"));

		// Resolve the Work (accept numeric id, publicId, or slug)
		const workIdNum = Number(workIdParam);
		const [work] = isNaN(workIdNum)
			? await db.select().from(works).where(eq(works.slug, workIdParam)).limit(1)
			: await db.select().from(works).where(eq(works.id, workIdNum)).limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		// Verify the asset belongs to this Work
		const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		if (!asset || asset.workId !== work.id) {
			return c.json({ error: "Asset not found" }, 404);
		}

		// Re-resolve access using the REAL resolver — same path as the existing download endpoint
		const viewerId = await resolveViewer(c);
		const ctx = await buildAccessContext(viewerId, { workIds: [work.id] });
		const access = resolveAccessSync(work as any, ctx);

		if (!access.canAccess) {
			return c.json({ error: "Purchase or subscription required", access }, 403);
		}

		// Build (or fetch cached) manifest
		let entry: SeederEntry;
		try {
			entry = await getOrCreateSeederEntry(work.id, assetId);
		} catch (err) {
			return c.json({ error: "Failed to build manifest", detail: String(err) }, 500);
		}

		// Mint the P2P delivery token
		const token = await mintP2pToken({
			workId: work.id,
			assetId,
			userId: viewerId ?? 0,
			exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
		});

		return c.json({ manifest: entry.manifest, token });
	})
	// ── Chunk endpoint (token-verified, serves bytes) ────────────────────────────
	.get("/works/:id/assets/:assetId/chunks/:index", async (c) => {
		const assetId = Number(c.req.param("assetId"));
		const chunkIndex = Number(c.req.param("index"));

		// The P2P token is the credential — from the Authorization: Bearer header
		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Token required" }, 401);
		}
		const token = authHeader.slice(7);
		const payload = await verifyP2pToken(token);
		if (!payload) {
			return c.json({ error: "Invalid or expired token" }, 401);
		}

		// The token is scoped to one asset — don't serve chunks for a different one
		if (payload.assetId !== assetId) {
			return c.json({ error: "Token not valid for this asset" }, 403);
		}

		const entry = seederStore.get(assetId);
		if (!entry) return c.json({ error: "Manifest not built yet" }, 404);

		const chunk = entry.manifest.chunks[chunkIndex];
		if (!chunk) return c.json({ error: "Chunk not found" }, 404);

		const bytes = entry.bytes.subarray(chunk.offset, chunk.offset + chunk.size);

		// Bandwidth accounting: count hub-served bytes
		entry.hubBytesServed += chunk.size;

		return new Response(bytes as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(chunk.size),
				"X-Chunk-Index": String(chunkIndex),
				"X-Chunk-Sha256": chunk.sha256,
				"Cache-Control": "no-store",
			},
		});
	})
	// ── Bandwidth accounting report ───────────────────────────────────────────────
	.get("/bandwidth-report", (c) => {
		const report: Record<number, { filename: string; hubBytesServed: number; fileSize: number }> =
			{};
		for (const [assetId, entry] of seederStore) {
			report[assetId] = {
				filename: entry.manifest.filename,
				hubBytesServed: entry.hubBytesServed,
				fileSize: entry.manifest.fileSize,
			};
		}
		return c.json(report);
	})
	// ── Browser test client ──────────────────────────────────────────────────────
	.route("/", spikeP2pClient)
	.get("/webrtc-client", (c) => c.html(WEBRTC_CLIENT_HTML));

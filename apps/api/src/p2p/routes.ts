// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery routes — the production hub-hosted seeder (per 45.04 + 45.05).
 *
 * Three endpoints, mounted under /api/p2p:
 *
 * 1. POST /works/:id/assets/:assetId/manifest
 *    Access-checked (reuses the real resolveAccessSync). If access is granted, mints a
 *    short-lived P2P token (Ed25519 per 45.05) and returns the manifest + token. If
 *    denied, returns 403 with the access verdict — same shape as the existing download
 *    endpoint. This is the P2P form of the private-by-default delivery rule (40.03).
 *
 * 2. GET /works/:id/assets/:assetId/chunks/:index
 *    Verifies the P2P token (from the Authorization: Bearer header). If valid and
 *    unexpired, serves the chunk bytes. If not, 401. This is the hub host — always in
 *    the swarm as the floor (45.01 § Milestone 3).
 *
 * 3. GET /pubkey
 *    Unauthenticated. Returns the hub's Ed25519 public key so peers can verify tokens
 *    without calling the hub per chunk (45.05 § Public key distribution).
 *
 * The seeder reads the file on first request and caches the manifest + raw bytes in
 * memory. For production, the cache should be bounded (LRU with size limit); for now,
 * the gauntlet test file (10 MiB) is the only thing in it. The real implementation
 * would read chunks from storage on demand rather than holding the whole file, but the
 * manifest format and token protocol are the same regardless.
 *
 * Bandwidth accounting: every chunk served from the seeder is counted as "hub-served
 * bytes." Swarm-served bytes (from peers) are free (45.01 § Milestone 6). The counter
 * is here so the measurement is tractable when peers are added.
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
import { buildManifest, chunkRange, type Manifest } from "./manifest.js";
import { getPublicKeyB64, mintP2pToken, verifyP2pToken } from "./token.js";

// In-memory cache: assetId -> { manifest, bytes, hubBytesServed }
interface SeederEntry {
	manifest: Manifest;
	bytes: Uint8Array;
	hubBytesServed: number;
}
const seederStore = new Map<number, SeederEntry>();

/** Resolve a viewer from either a bearer token or the session cookie. */
async function resolveViewer(c: Parameters<typeof getCookie>[0]): Promise<number | null> {
	const bearer = bearerToken(c);
	if (bearer) {
		const result = await validateSession(bearer);
		return result?.user.id ?? null;
	}
	const cookie = getCookie(c, "session");
	if (cookie) {
		const result = await validateSession(cookie);
		return result?.user.id ?? null;
	}
	return null;
}

/** Resolve a Work by numeric id, publicId, or slug (same as content routes). */
async function findWork(workIdParam: string) {
	const n = Number(workIdParam);
	if (!Number.isNaN(n)) {
		const [byId] = await db.select().from(works).where(eq(works.id, n)).limit(1);
		if (byId) return byId;
		const [byPublic] = await db.select().from(works).where(eq(works.publicId, n)).limit(1);
		return byPublic ?? null;
	}
	const [bySlug] = await db.select().from(works).where(eq(works.slug, workIdParam)).limit(1);
	return bySlug ?? null;
}

/** Load the asset file from storage and build the manifest. Caches in seederStore. */
async function getOrCreateSeederEntry(
	workId: number,
	workPublicId: string,
	asset: (typeof assets.$inferSelect)[],
): Promise<SeederEntry> {
	const assetRow = asset[0];
	const cached = seederStore.get(assetRow.id);
	if (cached) return cached;

	const fileBytes = await storage.read(assetRow.file);
	if (!fileBytes) throw new Error(`Asset file not found in storage: ${assetRow.file}`);

	const manifest = await buildManifest({
		workId,
		workPublicId,
		assetId: assetRow.id,
		assetFilename: assetRow.filename,
		assetSize: assetRow.fileSize ?? fileBytes.length,
		assetMimeType: assetRow.mimeType ?? "application/octet-stream",
		bytes: fileBytes,
	});

	const entry: SeederEntry = {
		manifest,
		bytes: fileBytes,
		hubBytesServed: 0,
	};
	seederStore.set(assetRow.id, entry);
	return entry;
}

export const p2pRoutes = new Hono()
	// ── Public key endpoint ──────────────────────────────────────────────────────
	.get("/pubkey", async (c) => {
		try {
			const publicKeyB64 = await getPublicKeyB64();
			return c.json({
				keyId: 1,
				publicKey: publicKeyB64,
				algorithm: "Ed25519",
			});
		} catch (err) {
			return c.json({ error: "P2P signing key not configured", detail: String(err) }, 500);
		}
	})
	// ── Manifest endpoint (access-checked, mints token) ──────────────────────────
	.post("/works/:id/assets/:assetId/manifest", async (c) => {
		const workIdParam = c.req.param("id");
		const assetId = Number(c.req.param("assetId"));

		const work = await findWork(workIdParam);
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
			entry = await getOrCreateSeederEntry(work.id, work.publicId.toString(), [asset]);
		} catch (err) {
			return c.json({ error: "Failed to build manifest", detail: String(err) }, 500);
		}

		// Mint the P2P delivery token
		const token = await mintP2pToken({
			workId: work.id,
			assetId,
			userId: viewerId ?? 0,
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
		if (payload.a !== assetId) {
			return c.json({ error: "Token not valid for this asset" }, 403);
		}

		const entry = seederStore.get(assetId);
		if (!entry) return c.json({ error: "Manifest not built yet" }, 404);

		if (chunkIndex < 0 || chunkIndex >= entry.manifest.chunks.length) {
			return c.json({ error: "Chunk not found" }, 404);
		}

		const { offset, size } = chunkRange(
			chunkIndex,
			entry.manifest.chunks.length,
			entry.manifest.chunkSize,
			entry.manifest.assetSize,
		);
		const bytes = entry.bytes.subarray(offset, offset + size);

		// Bandwidth accounting: count hub-served bytes
		entry.hubBytesServed += size;

		return new Response(bytes as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(size),
				"X-Chunk-Index": String(chunkIndex),
				"X-Chunk-Sha256": entry.manifest.chunks[chunkIndex],
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
				filename: entry.manifest.assetFilename,
				hubBytesServed: entry.hubBytesServed,
				fileSize: entry.manifest.assetSize,
			};
		}
		return c.json(report);
	});

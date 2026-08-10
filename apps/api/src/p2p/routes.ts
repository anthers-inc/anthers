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
 * The seeder hashes an asset on first request and caches the resulting MANIFEST — never
 * the bytes. Chunks are read from storage per request via `storage.readRange`, so the
 * resident cost is bounded by the manifest cache rather than by asset size. The cache is
 * bounded too (`MANIFEST_CACHE_LIMIT`), and a miss rebuilds rather than failing, because
 * with eviction and restarts a miss is ordinary while the token is still valid.
 *
 * Known cost, and the next thing to fix here: building a manifest is one full pass over
 * the object, and it happens inside the request that first asks for it. Memory is fine —
 * a chunk at a time — but a large asset makes that request slow. Manifests are immutable
 * per asset version (45.04), so the real answer is to precompute one at release time and
 * persist it, leaving this path as the fallback.
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
import { buildManifestFromStorage, chunkRange, type Manifest } from "./manifest.js";
import { getPublicKeyB64, mintP2pToken, verifyP2pToken } from "./token.js";

/**
 * How many assets' manifests to keep hashed. A manifest is one hex hash per 256 KiB, so
 * a 5 GiB asset costs roughly 1.3 MB here — small, but not free, and the map used to be
 * unbounded. The eviction cost is re-reading that asset from storage on its next request,
 * which is a latency cost rather than a correctness one.
 */
const MANIFEST_CACHE_LIMIT = 64;

/**
 * In-memory cache: assetId -> manifest + bytes-served counter.
 *
 * 🚨 **It holds no file bytes, deliberately.** It used to cache the complete asset
 * alongside its manifest, which made the first request for any real Work a whole-file
 * read into a 512 MB instance that was then never released — an OOM of the entire hub,
 * reachable by one download. Chunks are read from storage per request instead
 * (`storage.readRange`), so the resident cost here is bounded by the manifests alone.
 * If you find yourself adding a `bytes` field back, that is the bug.
 */
interface SeederEntry {
	manifest: Manifest;
	/** The object key chunks are read from. Held so serving a chunk costs no database hit. */
	storageKey: string;
	hubBytesServed: number;
}
const seederStore = new Map<number, SeederEntry>();

/**
 * Drop every cached manifest. Tests use this to reach the rebuild path that a restart,
 * a redeploy or an eviction would otherwise be needed to produce.
 */
export function _resetSeederCacheForTest(): void {
	seederStore.clear();
}

/** Insertion-ordered eviction — Map preserves insertion order, so the first key is oldest. */
function rememberManifest(assetId: number, entry: SeederEntry): void {
	if (seederStore.size >= MANIFEST_CACHE_LIMIT) {
		const oldest = seederStore.keys().next();
		if (!oldest.done) seederStore.delete(oldest.value);
	}
	seederStore.set(assetId, entry);
}

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

/**
 * Build (or return the cached) manifest for an asset, streaming it out of storage.
 *
 * Hashing still costs one full pass over the object, but a chunk at a time — the asset is
 * never resident in full. `assetSize` comes back from the walk rather than from
 * `assets.file_size`, so a stale column cannot desynchronize the manifest from the bytes.
 */
async function getOrCreateSeederEntry(
	workId: number,
	workPublicId: string,
	asset: (typeof assets.$inferSelect)[],
): Promise<SeederEntry> {
	const assetRow = asset[0];
	const cached = seederStore.get(assetRow.id);
	if (cached) return cached;

	const manifest = await buildManifestFromStorage({
		workId,
		workPublicId,
		assetId: assetRow.id,
		assetFilename: assetRow.filename,
		assetMimeType: assetRow.mimeType ?? "application/octet-stream",
		storageKey: assetRow.file,
	});

	if (!manifest) throw new Error(`Asset file not found in storage: ${assetRow.file}`);

	const entry: SeederEntry = { manifest, storageKey: assetRow.file, hubBytesServed: 0 };
	rememberManifest(assetRow.id, entry);
	return entry;
}

/**
 * The seeder entry for a token-bearing chunk request, rebuilding it if it isn't cached.
 *
 * A cache miss is normal rather than exceptional: the manifest cache is per-process and
 * bounded, so a restart, a redeploy, or simply the 65th asset all drop an entry while
 * perfectly valid 15-minute tokens are still in flight. Returning 404 there — which is
 * what this did — fails a download that the hub has already authorized, and it fails it
 * more often the busier the hub gets.
 *
 * Rebuilding needs no access re-check, and that is a property of the token rather than an
 * omission: it is Ed25519-signed by the hub, scoped to exactly this Work and asset, and
 * short-lived. `verifyP2pToken` has already established all of that. Re-resolving access
 * here would additionally be wrong for the case the swarm exists to serve — a peer
 * presenting a token it was legitimately given is not necessarily the user it was minted
 * for, which is precisely why the token is the credential at this endpoint and the
 * session is not.
 */
async function seederEntryForToken(workId: number, assetId: number): Promise<SeederEntry | null> {
	const cached = seederStore.get(assetId);
	if (cached) return cached;

	const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
	if (!asset || asset.workId !== workId) return null;

	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	if (!work) return null;

	try {
		return await getOrCreateSeederEntry(work.id, work.publicId.toString(), [asset]);
	} catch {
		return null;
	}
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

		const entry = await seederEntryForToken(payload.w, assetId);
		if (!entry) return c.json({ error: "Asset not available" }, 404);

		if (chunkIndex < 0 || chunkIndex >= entry.manifest.chunks.length) {
			return c.json({ error: "Chunk not found" }, 404);
		}

		const { offset, size } = chunkRange(
			chunkIndex,
			entry.manifest.chunks.length,
			entry.manifest.chunkSize,
			entry.manifest.assetSize,
		);

		// Read just this chunk out of storage. The seeder holds no file bytes — see the
		// note on SeederEntry for why that matters more than the extra read costs.
		const bytes = await storage.readRange(entry.storageKey, offset, size);
		if (!bytes || bytes.length !== size) {
			// The object changed or vanished under a manifest built from it. Serving a
			// short chunk would fail the peer's hash check with no explanation, so say so.
			return c.json({ error: "Chunk unavailable" }, 404);
		}

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

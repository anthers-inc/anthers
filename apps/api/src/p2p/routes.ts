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
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { buildManifestForAsset } from "../jobs/build-p2p-manifest.js";
import { bearerToken } from "../middleware/bearer.js";
import { buildAccessContext, resolveAccessSync } from "../services/access.js";
import { validateSession } from "../services/auth.js";
import { storage } from "../services/storage/index.js";
import { chunkRange, type Manifest } from "./manifest.js";
import { getPublicKeyB64, mintP2pToken, verifyP2pToken } from "./token.js";

/**
 * 🚨 **Nothing here caches a manifest, and that is deliberate — measured, not assumed.**
 *
 * An earlier version kept up to 64 whole manifests in a Map, on the reasoning that a
 * manifest is "one hex hash per 256 KiB, so a 5 GiB asset costs roughly 1.3 MB". That
 * arithmetic describes the JSON on the wire, not an array of 64-character strings in the
 * JS heap. Measured on Bun (fresh process per sample, RSS after a forced GC):
 *
 *     1 GiB asset →   4,096 chunks →  16 MB
 *     5 GiB asset →  20,480 chunks →  53 MB
 *    20 GiB asset →  81,920 chunks → 177 MB
 *
 * — about **2.3 KB per chunk**, some 35× the estimate. Sixty-four of anything blows the
 * 512 MB instance; a single 20 GiB manifest takes a third of it on its own. So there is
 * no cache size that is both useful and safe, which is the tell that caching whole
 * manifests was the wrong shape once they became persistent (migration 0026).
 *
 * What replaced it: the chunk endpoint asks Postgres for exactly the four small values it
 * needs — storage key, asset size, chunk size, and the ONE chunk hash at the requested
 * index, extracted inside the database with `p2p_manifest->'chunks'->>n`. The megabytes
 * never enter the process at all. That is strictly better than caching them, because the
 * old path also pulled the whole jsonb column out of Postgres on every cache miss.
 *
 * Only the manifest ENDPOINT materializes a full manifest, because returning it is its
 * entire job, and it does not retain it afterwards.
 */

/**
 * Hub-served byte counters, for the bandwidth accounting in 45.01 § Milestone 6.
 *
 * Numbers keyed by asset id — the one thing here worth keeping in memory, at a few dozen
 * bytes an entry rather than megabytes. Bounded anyway, because an unbounded map is what
 * got us here. Losing a counter to eviction costs telemetry and nothing else.
 */
const HUB_BYTES_TRACKED_ASSETS = 1024;
const hubBytesServed = new Map<number, number>();

function recordHubBytes(assetId: number, bytes: number): void {
	if (!hubBytesServed.has(assetId) && hubBytesServed.size >= HUB_BYTES_TRACKED_ASSETS) {
		const oldest = hubBytesServed.keys().next();
		if (!oldest.done) hubBytesServed.delete(oldest.value);
	}
	hubBytesServed.set(assetId, (hubBytesServed.get(assetId) ?? 0) + bytes);
}

/** Reset the bandwidth counters. Tests use this to assert against a known baseline. */
export function _resetSeederCacheForTest(): void {
	hubBytesServed.clear();
}

/**
 * Everything the chunk endpoint needs, and nothing else.
 *
 * The `->>` extraction is the point: it returns one 64-character hash out of an array
 * that may hold eighty thousand of them, so the row this hands back is a few hundred
 * bytes regardless of how large the asset is. Selecting the column and indexing in
 * JavaScript would work and would drag the whole array across the wire every time.
 *
 * Returns null when the asset does not belong to that Work, has no stored manifest, or
 * has no chunk at that index — three different reasons the caller answers identically,
 * because distinguishing them for an unauthenticated-ish caller leaks the shape of the
 * catalog for nothing.
 *
 * 🚨 **The `::int` cast on the index is load-bearing.** In Postgres, `jsonb ->> integer`
 * takes an ARRAY ELEMENT while `jsonb ->> text` takes an OBJECT KEY — same spelling, two
 * operators. Drizzle binds the parameter as text, so without the cast Postgres quietly
 * resolves the object-key form, finds no key named "0", and returns null for every index
 * ever requested. That surfaces as a 404 on every chunk of every download, with no error
 * anywhere. The tests caught it; reading the query would not have.
 */
async function chunkLocator(
	workId: number,
	assetId: number,
	index: number,
): Promise<{ storageKey: string; assetSize: number; chunkSize: number; sha256: string } | null> {
	const rows = await db.execute<{
		file: string;
		asset_size: string | null;
		chunk_size: string | null;
		sha256: string | null;
	}>(sql`
		SELECT
			${assets.file}                                   AS file,
			${assets.p2pManifest}->>'assetSize'              AS asset_size,
			${assets.p2pManifest}->>'chunkSize'              AS chunk_size,
			${assets.p2pManifest}->'chunks'->>(${index})::int AS sha256
		FROM ${assets}
		WHERE ${assets.id} = ${assetId} AND ${assets.workId} = ${workId}
		LIMIT 1
	`);
	const row = rows[0];
	if (!row?.sha256 || row.asset_size === null || row.chunk_size === null) return null;
	return {
		storageKey: row.file,
		assetSize: Number(row.asset_size),
		chunkSize: Number(row.chunk_size),
		sha256: row.sha256,
	};
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
 * The manifest for an asset — from the row if the release job has built it, otherwise
 * hashed on the spot.
 *
 * The stored half is content-only (`assetSize`, `assetSha256`, `chunkSize`, `chunks`), so
 * the identity fields are composed here from the live Work and asset rows. That is what
 * makes a rename show up immediately in the served manifest while the immutable half stays
 * exactly as it was hashed — 45.04 requires both: manifests are immutable in their content,
 * and the hub always serves the current one.
 *
 * The on-demand path is the fallback rather than the norm. It still exists because Works
 * released before the job did have no stored manifest, and because a job can fail; what it
 * costs is a slow first request, not a broken download. When it runs, it does NOT write the
 * result back — persisting is the job's responsibility, and a request handler that writes
 * would make a burst of first-requests race each other over the same row.
 */
/**
 * The full manifest for an asset — for the one endpoint whose job is to return it.
 *
 * The stored half is content-only (`assetSize`, `assetSha256`, `chunkSize`, `chunks`), so
 * identity is composed here from the live Work and asset rows. That is what makes a rename
 * show up immediately in the served manifest while the immutable half stays exactly as it
 * was hashed — 45.04 requires both: manifests are immutable in their content, and the hub
 * always serves the current one.
 *
 * When nothing is stored it builds AND PERSISTS, which reverses an earlier decision worth
 * explaining. This used to build without writing, on the reasoning that persisting is the
 * release job's business and a handler that wrote would let a burst of first-requests race
 * over one row. The race is real and turns out to be benign — every racer hashes the same
 * bytes and writes the same value, so the loser overwrites with an identical row. Not
 * writing is the more expensive mistake: the chunk endpoint now reads its per-chunk hash
 * straight out of this column, so an asset that is never persisted would re-hash on the
 * manifest request and then be unable to serve a single chunk.
 */
async function manifestFor(
	work: typeof works.$inferSelect,
	assetRow: typeof assets.$inferSelect,
): Promise<Manifest | null> {
	const identity = {
		workId: work.id,
		workPublicId: work.publicId.toString(),
		assetId: assetRow.id,
		assetFilename: assetRow.filename,
		assetMimeType: assetRow.mimeType ?? "application/octet-stream",
	};

	if (assetRow.p2pManifest) return { specVersion: 1, ...identity, ...assetRow.p2pManifest };

	// No stored manifest — a Work released before the job existed, or a job that failed.
	// Build it, persist it, and serve it.
	const outcome = await buildManifestForAsset(assetRow.id, { force: true });
	if (outcome !== "built") return null;

	const [refreshed] = await db.select().from(assets).where(eq(assets.id, assetRow.id)).limit(1);
	if (!refreshed?.p2pManifest) return null;
	return { specVersion: 1, ...identity, ...refreshed.p2pManifest };
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

		let manifest: Manifest | null;
		try {
			manifest = await manifestFor(work, asset);
		} catch (err) {
			return c.json({ error: "Failed to build manifest", detail: String(err) }, 500);
		}
		if (!manifest) return c.json({ error: "Asset file not available" }, 404);

		// Mint the P2P delivery token
		const token = await mintP2pToken({
			workId: work.id,
			assetId,
			userId: viewerId ?? 0,
		});

		return c.json({ manifest, token });
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

		if (chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
			return c.json({ error: "Chunk not found" }, 404);
		}

		// One small row: storage key, sizes, and just this chunk's hash. Never the array.
		// A chunk index past the end comes back null here, so the bounds check is the
		// query's rather than a separate length comparison.
		const locator = await chunkLocator(payload.w, assetId, chunkIndex);
		if (!locator) return c.json({ error: "Chunk not found" }, 404);

		const totalChunks = Math.ceil(locator.assetSize / locator.chunkSize);
		const { offset, size } = chunkRange(
			chunkIndex,
			totalChunks,
			locator.chunkSize,
			locator.assetSize,
		);

		// Read just this chunk out of storage. The seeder holds no file bytes and no
		// manifests — see the note at the top of this file for why both matter.
		const bytes = await storage.readRange(locator.storageKey, offset, size);
		if (!bytes || bytes.length !== size) {
			// The object changed or vanished under a manifest built from it. Serving a
			// short chunk would fail the peer's hash check with no explanation, so say so.
			return c.json({ error: "Chunk unavailable" }, 404);
		}

		recordHubBytes(assetId, size);

		return new Response(bytes as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(size),
				"X-Chunk-Index": String(chunkIndex),
				"X-Chunk-Sha256": locator.sha256,
				"Cache-Control": "no-store",
			},
		});
	})
	// ── Bandwidth accounting report ───────────────────────────────────────────────
	.get("/bandwidth-report", async (c) => {
		// The counters are the only thing held in memory, so the asset metadata that used
		// to ride along in the cache is fetched here instead — for the handful of assets
		// actually counted, not for everything.
		const ids = [...hubBytesServed.keys()];
		const report: Record<number, { filename: string; hubBytesServed: number; fileSize: number }> =
			{};
		if (ids.length === 0) return c.json(report);

		const rows = await db
			.select({ id: assets.id, filename: assets.filename, fileSize: assets.fileSize })
			.from(assets)
			.where(inArray(assets.id, ids));
		for (const row of rows) {
			report[row.id] = {
				filename: row.filename,
				hubBytesServed: hubBytesServed.get(row.id) ?? 0,
				fileSize: row.fileSize ?? 0,
			};
		}
		return c.json(report);
	});

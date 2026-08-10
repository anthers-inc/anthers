// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build and persist the P2P manifest for an asset (45.04), so the download path never
 * has to hash a file inside a request.
 *
 * Hashing an asset is one full pass over its bytes. Doing that lazily — on the first
 * request that asks for a manifest — is correct and bounded in memory, but it makes that
 * one request as slow as the asset is large, and it repeats after every deploy. Manifests
 * are immutable per content version (45.04 § Versioning), so the work belongs here: once,
 * off the request path, at release.
 *
 * **Only the content half is stored.** `assetSha256` and `chunks` are what 45.04 makes
 * immutable; `workPublicId`, `assetFilename` and `assetMimeType` travel in the same
 * manifest but can change without the bytes changing, and the spec requires the hub to
 * always serve the *current* manifest. So those are composed at request time and this job
 * persists only what a rename cannot invalidate. See the column comment on
 * `assets.p2pManifest`.
 *
 * Idempotent, and cheap to re-run when nothing changed: it compares the stored
 * `assetSize` against storage before doing any hashing, so the common "released again"
 * case costs one HEAD request.
 */

import { db } from "@anthers/db";
import { assets } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { buildManifestFromStorage } from "../p2p/manifest.js";
import { storage } from "../services/storage/index.js";

export interface BuildP2pManifestData {
	/** Build for every downloadable asset on this Work. */
	workId: number;
	/** Rebuild even when the stored manifest looks current. */
	force?: boolean;
}

/**
 * Build the manifest for one asset row, unless it is already current.
 *
 * Returns what happened, so the caller can log something truthful rather than "done".
 */
export async function buildManifestForAsset(
	assetId: number,
	opts: { force?: boolean } = {},
): Promise<"built" | "current" | "missing"> {
	const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
	if (!asset) return "missing";

	const storedSize = await storage.size(asset.file);
	if (storedSize === null) return "missing";

	// Size is a cheap proxy for "the bytes did not change", not a proof of it — a
	// same-length replacement passes this check. That is the right trade here because the
	// alternative is re-hashing every asset on every release, and a stale manifest is a
	// safe failure by design (45.04 § Versioning: the client reassembles the old version
	// intact, or the hub 410s). `force` exists for when the bytes are known to have moved.
	if (!opts.force && asset.p2pManifest && asset.p2pManifest.assetSize === storedSize) {
		return "current";
	}

	const manifest = await buildManifestFromStorage({
		workId: asset.workId,
		// Identity fields are not persisted, so what is passed here only has to be
		// well-formed — the served manifest recomposes them from live rows.
		workPublicId: "",
		assetId: asset.id,
		assetFilename: asset.filename,
		assetMimeType: asset.mimeType ?? "application/octet-stream",
		storageKey: asset.file,
	});
	if (!manifest) return "missing";

	await db
		.update(assets)
		.set({
			p2pManifest: {
				assetSize: manifest.assetSize,
				assetSha256: manifest.assetSha256,
				chunkSize: manifest.chunkSize,
				chunks: manifest.chunks,
			},
			p2pManifestBuiltAt: new Date(),
		})
		.where(eq(assets.id, asset.id));

	return "built";
}

/** Build manifests for every asset on a Work. */
export async function buildP2pManifest(data: BuildP2pManifestData): Promise<void> {
	const rows = await db
		.select({ id: assets.id })
		.from(assets)
		.where(eq(assets.workId, data.workId));
	if (rows.length === 0) return;

	const results = await Promise.all(
		rows.map(async (row) => {
			try {
				return await buildManifestForAsset(row.id, { force: data.force });
			} catch (err) {
				// One bad asset must not abandon the others — a Work commonly carries a
				// Windows, macOS and Linux build, and two of them working is better than none.
				console.error(`[build-p2p-manifest] asset ${row.id} failed:`, err);
				return "failed" as const;
			}
		}),
	);

	const tally = results.reduce<Record<string, number>>((acc, r) => {
		acc[r] = (acc[r] ?? 0) + 1;
		return acc;
	}, {});
	console.log(
		`[build-p2p-manifest] work ${data.workId}: ${Object.entries(tally)
			.map(([k, v]) => `${v} ${k}`)
			.join(", ")}`,
	);
}

/** Clear stored manifests for assets whose bytes are being replaced. */
export async function invalidateP2pManifests(assetIds: number[]): Promise<void> {
	if (assetIds.length === 0) return;
	await db
		.update(assets)
		.set({ p2pManifest: null, p2pManifestBuiltAt: null })
		.where(inArray(assets.id, assetIds));
}

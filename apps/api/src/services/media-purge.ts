// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The single place object storage is swept when content or an account goes away.
 *
 * It exists because there were two deletion paths and only one of them swept anything:
 * `DELETE /works/:id` purged its media, while account deletion dropped rows with a bare
 * `tx.delete(works)` and made **no object-storage calls at all** — so a deleted user's
 * avatar stayed publicly downloadable at its CDN URL forever, and their originals, HLS
 * renditions and assets stayed in the private bucket indefinitely. Privacy Policy promised
 * otherwise. Found 2026-08-11, closed here.
 *
 * The rule this file encodes: **a caller says WHAT is going away, never WHICH KEYS** —
 * enumeration lives here, once. A second hand-written key list is how the two paths
 * diverged in the first place.
 *
 * 🚨 Every function is best-effort and swallows storage failures after logging. A storage
 * hiccup must never block a database delete, because the row is the record of the promise
 * and the object is only its payload; a stranded object can be swept later, while a row
 * that refused to delete is a deletion request we did not honour.
 */

import { assets, db, transcodingJobs, works } from "@anthers/db";
import { and, inArray } from "drizzle-orm";
import { storage } from "./storage/index.js";

type WorkRow = typeof works.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type TranscodingJobRow = typeof transcodingJobs.$inferSelect;

/**
 * Normalize a stored URL or key to a storage key. Stored media columns hold whichever
 * the backend produced at write time — a `cdn.anthers.org` URL under S3, a `/content/…`
 * path under local — so every sweep goes through here rather than assuming one shape.
 */
export function urlToKey(urlOrKey: string): string {
	let path = urlOrKey;
	if (/^(https?:)?\/\//.test(urlOrKey)) {
		try {
			path = decodeURIComponent(new URL(urlOrKey).pathname);
		} catch {
			path = urlOrKey;
		}
	}
	path = path.replace(/^\/+/, "");
	if (path.startsWith("content/")) path = path.slice("content/".length);
	return path;
}

/** Delete a set of prefixes and keys, logging and swallowing every failure. */
async function sweep(keys: Set<string>, prefixes: Set<string>, label: string): Promise<void> {
	for (const prefix of prefixes) {
		if (!prefix) continue;
		try {
			await storage.deletePrefix(prefix);
		} catch (err) {
			console.error(`[${label}] deletePrefix failed for ${prefix}:`, err);
		}
	}
	for (const key of keys) {
		if (!key) continue;
		try {
			await storage.delete(key);
		} catch (err) {
			console.error(`[${label}] delete failed for ${key}:`, err);
		}
	}
}

/** Collect every storage key and prefix a Work owns, given its already-loaded rows. */
function keysForWork(
	item: WorkRow,
	workAssets: AssetRow[],
	jobRows: TranscodingJobRow[],
): { keys: Set<string>; prefixes: Set<string> } {
	const keys = new Set<string>();
	const prefixes = new Set<string>();

	if (item.sourceKey) keys.add(urlToKey(item.sourceKey));
	if (item.thumbnail) keys.add(urlToKey(item.thumbnail));
	for (const a of workAssets) if (a.file) keys.add(urlToKey(a.file));
	for (const job of jobRows) {
		if (job.hlsManifestUrl) {
			const masterKey = urlToKey(job.hlsManifestUrl);
			const prefix = masterKey.replace(/\/[^/]+$/, "");
			if (prefix && prefix !== masterKey) prefixes.add(prefix);
		}
		if (job.outputFileUrl) keys.add(urlToKey(job.outputFileUrl));
	}

	return { keys, prefixes };
}

/**
 * Best-effort purge of one Work's stored media before its row (and its cascaded assets,
 * transcodes and post-refs) are deleted: the source, thumbnail, every asset file, each
 * completed video transcode's HLS output prefix, and any processed-audio output.
 */
export async function purgeWorkMedia(
	item: WorkRow,
	workAssets: AssetRow[],
	jobRows: TranscodingJobRow[],
): Promise<void> {
	const { keys, prefixes } = keysForWork(item, workAssets, jobRows);
	await sweep(keys, prefixes, "work delete");
}

/**
 * Best-effort purge for a set of Works identified only by id — the account-deletion
 * shape, where the caller has ids rather than loaded rows.
 *
 * 🚨 **Load before you delete, sweep after you commit.** This reads `works`, `assets` and
 * `transcoding_jobs`, so it must run BEFORE the transaction that removes them or it finds
 * nothing and silently sweeps nothing. Its *storage* half should run after the commit, for
 * the same reason the withdrawal notice does: destroying media for an account whose
 * deletion then rolled back is unrecoverable, while a crash between commit and sweep
 * merely strands objects. Use {@link collectWorkMedia} + {@link sweepCollected} when the
 * two halves need to straddle a transaction.
 */
export async function purgeWorksMedia(workIds: number[]): Promise<void> {
	const collected = await collectWorkMedia(workIds);
	await sweepCollected(collected);
}

export type CollectedMedia = { keys: Set<string>; prefixes: Set<string> };

/** Enumerate the storage footprint of a set of Works. Call BEFORE the rows are deleted. */
export async function collectWorkMedia(workIds: number[]): Promise<CollectedMedia> {
	const keys = new Set<string>();
	const prefixes = new Set<string>();
	if (workIds.length === 0) return { keys, prefixes };

	const [workRows, assetRows, jobRows] = await Promise.all([
		db.select().from(works).where(inArray(works.id, workIds)),
		db.select().from(assets).where(inArray(assets.workId, workIds)),
		db
			.select()
			.from(transcodingJobs)
			.where(and(inArray(transcodingJobs.workId, workIds))),
	]);

	for (const w of workRows) {
		const forThis = keysForWork(
			w,
			assetRows.filter((a) => a.workId === w.id),
			jobRows.filter((j) => j.workId === w.id),
		);
		for (const k of forThis.keys) keys.add(k);
		for (const p of forThis.prefixes) prefixes.add(p);
	}

	return { keys, prefixes };
}

/** Add a user's own profile images to a collection. They belong to no Work. */
export function addUserImages(
	collected: CollectedMedia,
	user: { avatar?: string | null; headerImage?: string | null },
): CollectedMedia {
	if (user.avatar) collected.keys.add(urlToKey(user.avatar));
	if (user.headerImage) collected.keys.add(urlToKey(user.headerImage));
	return collected;
}

/** Perform the deletions a {@link collectWorkMedia} pass enumerated. Call AFTER commit. */
export async function sweepCollected(collected: CollectedMedia): Promise<void> {
	await sweep(collected.keys, collected.prefixes, "account erase");
}

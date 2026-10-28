// SPDX-License-Identifier: Apache-2.0
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
 * that refused to delete is a deletion request we did not honor.
 */

import {
	assets,
	db,
	transcodingJobs,
	webBuilds,
	workCaptionTracks,
	workMediaVersions,
	workPreviewMedia,
	workSourceFiles,
	works,
} from "@anthers/db";
import { isPaged } from "@anthers/shared/content";
import { and, eq, inArray } from "drizzle-orm";
import { storage } from "./storage/index.js";
import { isKeyUnder, urlToKey } from "./storage/keys.js";
import { keysInMedia } from "./work-versions.js";

type WorkRow = typeof works.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type TranscodingJobRow = typeof transcodingJobs.$inferSelect;
type SourceFileRow = typeof workSourceFiles.$inferSelect;
type PreviewMediaRow = typeof workPreviewMedia.$inferSelect;
type PreviewCaptionRow = typeof workCaptionTracks.$inferSelect;

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

/**
 * Sweep the video HLS run prefixes no transcoding row points at.
 *
 * Since the transcode's per-variant restructure, every run of the job — the first
 * attempt and every retry alike — renders into its own run prefix
 * (`creators/{id}/videos/hls/<run>/`). An attempt that never finished is a prefix full
 * of private, unreachable-by-client bytes sitting inside its creator's allowance, with
 * nothing pointing at or reclaiming it: the delete and withdrawal paths enumerate from
 * rows, and the retry that died left no row carrying the prefix at all.
 *
 * The rule, per this module's ownership rules:
 *
 * - **Enumeration is storage-first, not row-first** — `listChildPrefixes` finds what
 *   actually exists, and the database answers which runs are referenced. A reference
 *   is a video transcode row whose `hlsManifestUrl` key resolves under the candidate
 *   prefix.
 * - 🚨 **A creator with a live video transcode is skipped entirely.** A pending row's
 *   own run prefix does not exist anywhere in the database yet — the job mints it when
 *   it runs — so there is no way to know from rows alone that `…/hls/<future>/` is
 *   about to be written, and a prefix deleted while an encode is still writing into it
 *   is the one unrecoverable error a sweep could make. An account with any
 *   `pending` or `processing` video job this cycle simply waits for the next run.
 */
export async function sweepOrphanedVideoHlsPrefixes(): Promise<number> {
	let deleted = 0;
	for (const creatorRoot of await storage.listChildPrefixes("creators/")) {
		const creatorId = Number.parseInt(creatorRoot.replace("creators/", ""), 10);
		if (!Number.isInteger(creatorId)) continue;

		const candidates = await storage.listChildPrefixes(`creators/${creatorId}/videos/hls/`);
		if (candidates.length === 0) continue;

		// The live-write guard above, one query per creator who has anything to sweep.
		const [live] = await db
			.select({ id: transcodingJobs.id })
			.from(transcodingJobs)
			.innerJoin(works, eq(works.id, transcodingJobs.workId))
			.where(
				and(
					eq(works.creatorId, creatorId),
					eq(transcodingJobs.mediaType, "video"),
					inArray(transcodingJobs.status, ["pending", "processing"]),
				),
			)
			.limit(1);
		if (live) continue;

		// Every run prefix some row's master playlist still points at. Normalized to the
		// candidate form — trailing slash — so the comparison can never miss on the two
		// spellings of the same directory.
		const rows = await db
			.select({ hlsManifestUrl: transcodingJobs.hlsManifestUrl })
			.from(transcodingJobs)
			.innerJoin(works, eq(works.id, transcodingJobs.workId))
			.where(and(eq(works.creatorId, creatorId), eq(transcodingJobs.mediaType, "video")));
		const referenced = new Set(
			rows
				.map((r) => urlToKey(r.hlsManifestUrl ?? ""))
				.filter(Boolean)
				.map((key) => `${key.replace(/\/[^/]+$/, "")}/`),
		);

		for (const candidate of candidates) {
			const prefix = candidate;
			if (referenced.has(prefix)) continue;
			try {
				await storage.deletePrefix(prefix);
				deleted += 1;
			} catch (err) {
				console.error(`[media-purge] orphan sweep: deletePrefix failed for ${prefix}:`, err);
			}
		}
	}
	return deleted;
}

/**
 * Collect every storage key and prefix a Work owns, given its already-loaded rows.
 *
 * 🚨 **Only what sits under the Work's own creator's prefix, whatever its columns say.** Those
 * columns were written by clients, and a Work naming another creator's original used to mean
 * that deleting the Work deleted the other creator's file. The write routes refuse such a
 * reference now (`storage/keys.ts`), and this refuses to act on one that got in anyway — a row
 * written before the check, or by a path that forgot it. A Work whose creator is gone names no
 * prefix, so it sweeps nothing, which strands objects rather than destroying someone's.
 */
/** The archived originals a Work's version manifests name, owner-filtered like the rest. */
function versionKeysForWork(
	creatorId: number | null,
	versions: { media: Parameters<typeof keysInMedia>[0] }[],
): Set<string> {
	const keys = new Set<string>();
	for (const version of versions) {
		for (const key of keysInMedia(version.media)) {
			if (creatorId != null && isKeyUnder(key, creatorId)) keys.add(key);
		}
	}
	return keys;
}

function keysForWork(
	item: WorkRow,
	workAssets: AssetRow[],
	jobRows: TranscodingJobRow[],
	sourceFiles: SourceFileRow[],
	previews: PreviewMediaRow[] = [],
	previewCaptions: PreviewCaptionRow[] = [],
): { keys: Set<string>; prefixes: Set<string> } {
	const all = collectRawKeysForWork(
		item,
		workAssets,
		jobRows,
		sourceFiles,
		previews,
		previewCaptions,
	);
	const owner = item.creatorId;
	const mine = (key: string) => owner != null && isKeyUnder(key, owner);
	return {
		keys: new Set([...all.keys].filter(mine)),
		// A prefix is checked with its trailing slash, so `creators/5` cannot pass as `creators/5/`.
		prefixes: new Set([...all.prefixes].filter((prefix) => mine(`${prefix}/`))),
	};
}

/**
 * A Work's browser-build prefixes, read from the build rows — full keys under the Work's
 * creator's prefix, exactly as the upload route minted them: `creators/{id}/web-builds/{buildId}/`.
 * Which `isKeyUnder` accepts, so the owner filter in `keysForWork` would pass them; they are
 * added past it in the caller because the creator here is read from the Work row itself.
 *
 * The single-file shape of this module means a Work delete asks here rather than assembling
 * build keys itself, so nothing has to remember the prefix shape in two places.
 */
async function webBuildPrefixesForWorks(workIds: number[]): Promise<string[]> {
	const rows = await db
		.select({ id: webBuilds.id, creatorId: works.creatorId })
		.from(webBuilds)
		.innerJoin(works, eq(webBuilds.workId, works.id))
		.where(inArray(webBuilds.workId, workIds));
	return rows.map((r) => `creators/${r.creatorId}/${webBuildPrefix(r.id)}`);
}

/** Add many Works' browser-build prefixes to a collection (the account-erase shape). */
async function addWebBuildPrefixes(collected: CollectedMedia, workIds: number[]): Promise<void> {
	for (const prefix of await webBuildPrefixesForWorks(workIds)) {
		collected.prefixes.add(prefix);
	}
}

/**
 * The storage prefix all of one build's files live under — the shape every upload key and
 * every purge sweep resolves against. **Kept here on the one-enumeration rule**: the route
 * that mints keys and the sweeps that delete them both import it, so a prefix change is a
 * one-file edit and the two can never disagree.
 *
 * ⚠️ **This function exists to be imported, and exporting it from a service is the shape
 * rather than a mistake** — `keysForWork` stays private because a caller says WHAT is going
 * away, but the prefix builder is the other half of that bargain: the key-minting side may
 * not re-derive the shape either.
 */
export function webBuildPrefix(buildId: number): string {
	return `web-builds/${buildId}/`;
}

function collectRawKeysForWork(
	item: WorkRow,
	workAssets: AssetRow[],
	jobRows: TranscodingJobRow[],
	sourceFiles: SourceFileRow[],
	previews: PreviewMediaRow[] = [],
	previewCaptions: PreviewCaptionRow[] = [],
): { keys: Set<string>; prefixes: Set<string> } {
	const keys = new Set<string>();
	const prefixes = new Set<string>();

	if (item.sourceKey) keys.add(urlToKey(item.sourceKey));
	// The remux-retained original rides its pointer column (see the schema comment) so
	// every sweep reaches it — an object this enumeration cannot name is one no path
	// deletes without a second hand-written key list, the shape this module exists to end.
	if (item.sourceOriginalKey) keys.add(urlToKey(item.sourceOriginalKey));
	if (item.thumbnail) keys.add(urlToKey(item.thumbnail));
	// The full upload the thumbnail was framed from — unreferenced by any render, and so
	// only this enumeration can name it for deletion.
	if (item.thumbnailSource) keys.add(urlToKey(item.thumbnailSource));
	// A paged Work's source set — every file's original, not only the one the legacy
	// column names. A removed source file's row is already gone when a delete runs, so
	// the sweep cannot see it here by design: the remove path asks the sweep directly
	// (`removeSourceFileStorage`, below) rather than through this enumeration.
	for (const sourceFile of sourceFiles) keys.add(urlToKey(sourceFile.file));
	// The storefront's screenshots and trailers, and every caption file on a trailer. A
	// preview removed on its own takes its objects with it (`work-preview-media.ts`); this
	// is the Work-delete half, which must name what the rows still hold.
	for (const preview of previews) keys.add(urlToKey(preview.file));
	for (const caption of previewCaptions) keys.add(urlToKey(caption.storageKey));
	for (const a of workAssets) if (a.file) keys.add(urlToKey(a.file));
	for (const job of jobRows) {
		if (job.hlsManifestUrl) {
			const masterKey = urlToKey(job.hlsManifestUrl);
			const prefix = masterKey.replace(/\/[^/]+$/, "");
			if (prefix && prefix !== masterKey) prefixes.add(prefix);
		}
		if (job.outputFileUrl) keys.add(urlToKey(job.outputFileUrl));
	}
	// 🚨 **A paged Work's derived storage lives under one deterministic prefix** — its
	// rendered pages (and a reflow ebook's ladder sections), all
	// `creators/{id}/ebook/{workId}/`, one per-run sub-prefix per render or ingest. The
	// prefix IS the enumeration here rather than the rows: rows are deleted and rewritten
	// mid-replace, and a prefix sweep takes everything every run wrote. Found during the
	// replace work: a Work delete cascaded the page rows and stranded every page object
	// in the creator's prefix forever.
	if (isPaged(item.type) && item.creatorId != null) {
		prefixes.add(`creators/${item.creatorId}/ebook/${item.id}/`);
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
	const sourceFileRows = await db
		.select()
		.from(workSourceFiles)
		.where(eq(workSourceFiles.workId, item.id));
	const previewRows = await db
		.select()
		.from(workPreviewMedia)
		.where(eq(workPreviewMedia.workId, item.id));
	const previewCaptionRows =
		previewRows.length === 0
			? []
			: await db
					.select()
					.from(workCaptionTracks)
					.where(
						inArray(
							workCaptionTracks.previewId,
							previewRows.map((p) => p.id),
						),
					);
	const versionRows = await db
		.select({ media: workMediaVersions.media })
		.from(workMediaVersions)
		.where(eq(workMediaVersions.workId, item.id));
	const { keys, prefixes } = keysForWork(
		item,
		workAssets,
		jobRows,
		sourceFileRows,
		previewRows,
		previewCaptionRows,
	);
	for (const key of versionKeysForWork(item.creatorId, versionRows)) keys.add(key);
	// A browser build is swept by prefix — one whole `web-builds/{buildId}/` prefix per
	// build — rather than file by file, because the number of files a real engine export
	// carries makes enumerating keys the wrong shape and a missed file an ungated copy of
	// the game left behind. The build rows themselves cascade in the database; this is
	// their storage half.
	for (const prefix of await webBuildPrefixesForWorks([item.id])) {
		prefixes.add(prefix);
	}
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

	const [workRows, assetRows, jobRows, sourceFileRows, previewRows, versionRows] =
		await Promise.all([
			db.select().from(works).where(inArray(works.id, workIds)),
			db.select().from(assets).where(inArray(assets.workId, workIds)),
			db
				.select()
				.from(transcodingJobs)
				.where(and(inArray(transcodingJobs.workId, workIds))),
			db.select().from(workSourceFiles).where(inArray(workSourceFiles.workId, workIds)),
			db.select().from(workPreviewMedia).where(inArray(workPreviewMedia.workId, workIds)),
			db
				.select({ workId: workMediaVersions.workId, media: workMediaVersions.media })
				.from(workMediaVersions)
				.where(inArray(workMediaVersions.workId, workIds)),
		]);
	const previewCaptionRows =
		previewRows.length === 0
			? []
			: await db
					.select()
					.from(workCaptionTracks)
					.where(
						inArray(
							workCaptionTracks.previewId,
							previewRows.map((p) => p.id),
						),
					);
	const previewWorkId = new Map(previewRows.map((p) => [p.id, p.workId]));
	await addWebBuildPrefixes({ keys, prefixes }, workIds);

	for (const w of workRows) {
		const forThis = keysForWork(
			w,
			assetRows.filter((a) => a.workId === w.id),
			jobRows.filter((j) => j.workId === w.id),
			sourceFileRows.filter((s) => s.workId === w.id),
			previewRows.filter((p) => p.workId === w.id),
			previewCaptionRows.filter(
				(c) => c.previewId != null && previewWorkId.get(c.previewId) === w.id,
			),
		);
		for (const k of forThis.keys) keys.add(k);
		for (const p of forThis.prefixes) prefixes.add(p);
		for (const key of versionKeysForWork(
			w.creatorId,
			versionRows.filter((v) => v.workId === w.id),
		)) {
			keys.add(key);
		}
	}

	return { keys, prefixes };
}

/**
 * Add a user's own profile images to a collection. They belong to no Work.
 *
 * Only an image under the user's own prefix is added, for the reason `keysForWork` gives: an
 * avatar column naming somebody else's object must not make erasing this account erase theirs.
 */
export function addUserImages(
	collected: CollectedMedia,
	user: {
		id: number;
		avatar?: string | null;
		bannerImage?: string | null;
		avatarSource?: string | null;
		bannerImageSource?: string | null;
	},
): CollectedMedia {
	for (const ref of [user.avatar, user.bannerImage, user.avatarSource, user.bannerImageSource]) {
		if (!ref) continue;
		const key = urlToKey(ref);
		if (isKeyUnder(key, user.id)) collected.keys.add(key);
	}
	return collected;
}

/** Perform the deletions a {@link collectWorkMedia} pass enumerated. Call AFTER commit. */
export async function sweepCollected(collected: CollectedMedia): Promise<void> {
	await sweep(collected.keys, collected.prefixes, "account erase");
}

/**
 * Sweep ONE source file's object, when a mutation removes it from its Work's set (a removal,
 * or the file a replace retires). The remove path runs immediately — not through the Work
 * delete enumeration, which by definition reads only keys the Work still names — so the
 * ownership refusal `keysForWork` applies is applied here the same way: the key must be under
 * the Work's creator's own prefix, or it is not touched.
 */
export async function removeSourceFileStorage(
	sourceFile: Pick<SourceFileRow, "file">,
	creatorId: number | null,
): Promise<void> {
	const key = urlToKey(sourceFile.file);
	if (creatorId == null || !isKeyUnder(key, creatorId)) return;
	await sweep(new Set([key]), new Set(), "work source remove");
}

/**
 * Sweep the media a source REPLACEMENT retires, from the Work's prior state alone —
 * the caller passes the row and the job rows as they were before the new source was
 * written, because after it the enumeration can no longer see any of this.
 *
 * 🚨 **This is what "keep no old versions" is made of**: the prior source object, the
 * prior remux-retained original, and every derived output the prior job rows name
 * (the HLS run prefixes and processed-audio files). Nothing survives a replace under
 * the one rule a creator's allowance is metered by. Ownership-guarded like
 * {@link removeSourceFileStorage}: a prior key not under the creator's own prefix is
 * never touched.
 *
 * The caller owns the rows: the superseded `transcoding_jobs` rows are deleted by the
 * route that retires them, and a paged set's rows and their objects belong to
 * `work-source-files.ts`.
 */
export async function purgeReplacedWorkMedia(
	prior: Pick<WorkRow, "sourceKey" | "sourceOriginalKey" | "creatorId">,
	priorJobs: Pick<TranscodingJobRow, "hlsManifestUrl" | "outputFileUrl">[],
	opts: { keep?: Set<string> } = {},
): Promise<void> {
	const keys = new Set<string>();
	const prefixes = new Set<string>();
	const mine = (key: string) => prior.creatorId != null && isKeyUnder(key, prior.creatorId);
	// A version archives one of these two pointers as the original it keeps. Everything
	// else a replacement retires — the other pointer and every derived output — still goes.
	const keep = opts.keep ?? new Set<string>();

	if (prior.sourceKey) {
		const key = urlToKey(prior.sourceKey);
		if (mine(key) && !keep.has(key)) keys.add(key);
	}
	if (prior.sourceOriginalKey) {
		const key = urlToKey(prior.sourceOriginalKey);
		if (mine(key) && !keep.has(key)) keys.add(key);
	}
	for (const job of priorJobs) {
		if (job.hlsManifestUrl) {
			const masterKey = urlToKey(job.hlsManifestUrl);
			const prefix = masterKey.replace(/\/[^/]+$/, "");
			if (prefix && prefix !== masterKey && mine(`${prefix}/`)) prefixes.add(prefix);
		}
		if (job.outputFileUrl) {
			const key = urlToKey(job.outputFileUrl);
			if (mine(key)) keys.add(key);
		}
	}
	await sweep(keys, prefixes, "work source replace");
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The storage ladder's meter — snapshot what each account holds against its allowance.
 *
 * One row per (account, cycle) in `storage_usage`, recomputed daily and idempotent per
 * cycle: the upsert is keyed on (userId, billingCycle), so a repeated run rewrites the
 * in-flight month's row in place and never duplicates. The cycle's last snapshot is the
 * figure billing reads — a running estimate that solidifies at settlement, the same
 * posture `GET /earnings` takes (`settled: true|false` rather than a second kind of
 * number).
 *
 * 🚨 **Bytes are counted from the database rows, never from walking the bucket's
 * `creators/{id}/` prefix.** The schema doc on `storage_usage` carries the full
 * reasoning: the DB is the same authority `calculate-crf` reads, a bucket walk would
 * sweep avatars and display chrome the ladder never prices, and a paginated
 * `ListObjectsV2` per account per night is an API bill paid to measure figures grouped
 * queries answer. The five surfaces and how each is reached:
 *
 * - **Assets and build files carry their own sizes** — `assets.file_size` and
 *   `web_build_files.file_size`, summed per account in grouped queries; the same
 *   authority `calculate-crf` reads for the first of them, so the subsidy job and this
 *   meter cannot disagree about a creator's catalog.
 * - **The Work record's own media** — `works.source_key` and `works.thumbnail` — are the
 *   columns whose size is carried nowhere in the database, so they are this job's one
 *   per-row `size()` cost: two heads per Work, once a day, on rows a whole-table sweep
 *   reaches anyway.
 * - **HLS output** — a transcoding job's manifest key names its rendition prefix (the
 *   read `media-purge.ts` already established: master key minus its file). One
 *   `prefixSize` per job row — narrow, per-Work, exactly the priced population.
 * - **Inline images** — a creator's post body images, no table carries their size, so
 *   one `prefixSize` per creator prefix. These are body content rather than display
 *   chrome, which is what puts this prefix on the metered side of the line
 *   `aclForMediaType` draws: the ladder's catalog purpose is where body images bill.
 * - **Cloud saves** — `work_saves.byte_size`, attributed to the *player's* account: the
 *   settled design's rule is that the blob charges the player's floor like any kept
 *   file, not the creator's.
 *
 * Attribution is per-purpose (`catalog`, `cloud-saves`, `kept-files`) under one summed
 * figure, because the allowance is combined but the reading a creator sees and the audit
 * the rescue window's 1/N keeper-share check needs are per-purpose lines. `kept-files`
 * stays zero until the rescue-window sweep lands its surface; the kind exists so the
 * sweep's first row is a line in an existing vocabulary rather than a migration.
 */

import { db } from "@anthers/db/client";
import {
	assets,
	inlineImages,
	storageUsage,
	transcodingJobs,
	webBuildFiles,
	webBuilds,
	workSaves,
	works,
} from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { STORAGE_USE_KINDS, type StorageUseKind } from "@anthers/shared/constants";
import { eq, sql } from "drizzle-orm";
import { storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";

/**
 * The byte size of one stored object, by key — `null` when absent.
 *
 * Empty keys are `null` by construction (a Work without a source names no object), and a
 * `size()` failure is swallowed into `null` after logging: a reading is best-effort in the
 * same posture `media-purge.ts` takes toward its sweeps, and a missing figure reports as
 * absent rather than as zero — zero would silently *undercount* the account's draw, which
 * for a meter is the one error that hides cost.
 */
async function sizeOfKey(key: string | null | undefined): Promise<number | null> {
	if (!key) return null;
	const storageKey = urlToKey(key);
	if (!storageKey) return null;
	try {
		return await storage.size(storageKey);
	} catch (err) {
		console.error(`[storage-usage] size() failed for ${storageKey}:`, err);
		return null;
	}
}

/**
 * The total bytes under one prefix.
 *
 * A per-Work HLS prefix or a per-creator inline-images prefix — both exactly the priced
 * population, never the broad `creators/{id}/` walk the DB-first rule forbids. Failures
 * log and answer zero: an undercount reported beside the row's other figures, never a run
 * lost to one prefix.
 */
async function prefixBytes(prefix: string): Promise<number> {
	try {
		return await storage.prefixSize(prefix);
	} catch (err) {
		console.error(`[storage-usage] prefixSize failed for ${prefix}:`, err);
		return 0;
	}
}

/**
 * A new, empty per-purpose split — every known kind zeroed.
 *
 * Built from the closed set rather than a literal, so a kind declared in
 * `STORAGE_USE_KINDS` but never wired into the sweep's collection shows up in every
 * snapshot as a standing zero — visible — rather than as a key absent from every row —
 * silent.
 */
function emptyPurposes(): Record<StorageUseKind, number> {
	return Object.fromEntries(STORAGE_USE_KINDS.map((k) => [k, 0])) as Record<StorageUseKind, number>;
}

/** Add `bytes` to one kind, as a whole number — sizes can arrive fractional in tests. */
function add(purposes: Record<StorageUseKind, number>, kind: StorageUseKind, bytes: number): void {
	purposes[kind] += Math.max(0, Math.round(bytes ?? 0));
}

/**
 * Snapshot every account's usage for the current cycle and upsert the rows.
 *
 * **The shape is one day's sweep, not one account's question.** The daily job reads the
 * whole population in a handful of grouped queries and per-row `size()` calls bounded by
 * the day, and the per-account reading (`services/storage-reading.ts`) composes its answer
 * from the stored row — it never recomputes, so the route figure is always the figure the
 * meter stored, not a second derivation that could drift from it.
 *
 * The sweep is deliberately quiet on an empty population, `0` like every other job's
 * worker, so a dev session that stored nothing produces no rows and no noise.
 */
export async function runStorageUsageSweep(now = new Date()): Promise<number> {
	const cycle = currentCycleKey(now);

	// Per-account accumulators. Rows enter when the first query that sees the account
	// brings it in; every later query adds onto the same split.
	const byUser = new Map<number, { purposes: Record<StorageUseKind, number> }>();
	const account = (userId: number) => {
		let entry = byUser.get(userId);
		if (!entry) {
			entry = { purposes: emptyPurposes() };
			byUser.set(userId, entry);
		}
		return entry;
	};

	// ── Assets, by the Work's creator ────────────────────────────────────────────
	// The same figure `calculate-crf` reads. A null-creator Work's rows cannot be
	// attributed and are skipped by the join condition rather than summed into nobody.
	const assetRows = await db
		.select({
			creatorId: works.creatorId,
			total: sql<string>`COALESCE(SUM(${assets.fileSize}), 0)`,
		})
		.from(assets)
		.innerJoin(works, eq(assets.workId, works.id))
		.where(sql`${works.creatorId} IS NOT NULL`)
		.groupBy(works.creatorId);
	for (const row of assetRows) {
		if (row.creatorId == null) continue;
		add(account(row.creatorId).purposes, "catalog", Number(row.total));
	}

	// ── Browser build files, through the build and its Work ─────────────────────
	const buildRows = await db
		.select({
			creatorId: works.creatorId,
			total: sql<string>`COALESCE(SUM(${webBuildFiles.fileSize}), 0)`,
		})
		.from(webBuildFiles)
		.innerJoin(webBuilds, eq(webBuildFiles.buildId, webBuilds.id))
		.innerJoin(works, eq(webBuilds.workId, works.id))
		.where(sql`${works.creatorId} IS NOT NULL`)
		.groupBy(works.creatorId);
	for (const row of buildRows) {
		if (row.creatorId == null) continue;
		add(account(row.creatorId).purposes, "catalog", Number(row.total));
	}

	// ── HLS output, one prefix read per transcoding job with a manifest ──────────
	const hlsRows = await db
		.select({ creatorId: works.creatorId, manifestKey: transcodingJobs.hlsManifestUrl })
		.from(transcodingJobs)
		.innerJoin(works, eq(transcodingJobs.workId, works.id))
		.where(sql`${works.creatorId} IS NOT NULL AND ${transcodingJobs.hlsManifestUrl} <> ''`);
	for (const row of hlsRows) {
		if (row.creatorId == null) continue;
		// The manifest's key minus its file IS the rendition prefix — the same read
		// `media-purge.ts` established, pasted as the rule it is rather than re-derived.
		const masterKey = urlToKey(row.manifestKey ?? "");
		if (!masterKey) continue;
		const slash = masterKey.lastIndexOf("/");
		if (slash <= 0) continue;
		const prefix = `${masterKey.slice(0, slash)}/`;
		add(account(row.creatorId).purposes, "catalog", await prefixBytes(prefix));
	}

	// ── Inline images, one prefix read per creator ───────────────────────────────
	const imageRows = await db
		.select({ creatorId: inlineImages.creatorId })
		.from(inlineImages)
		.groupBy(inlineImages.creatorId);
	for (const row of imageRows) {
		// The prefix carries the images' keys by construction (`inline_images.image`
		// stores exactly the key under the creator's prefix), and this is the case the
		// DB-first rule bends for: no table carries these sizes, and one prefix read per
		// *creator with images* is a bounded population, not the per-account walk.
		add(
			account(row.creatorId).purposes,
			"catalog",
			await prefixBytes(`creators/${row.creatorId}/inline-images/`),
		);
	}

	// ── The Work record's own media, sized where it is stored ────────────────────
	// Two `size()` heads per Work with a source or thumbnail. This is the one surface
	// the database cannot answer, because these columns' sizes are carried nowhere.
	const mediaRows = await db
		.select({ creatorId: works.creatorId, sourceKey: works.sourceKey, thumbnail: works.thumbnail })
		.from(works)
		.where(sql`${works.creatorId} IS NOT NULL`);
	for (const row of mediaRows) {
		if (row.creatorId == null) continue;
		const purposes = account(row.creatorId).purposes;
		const source = await sizeOfKey(row.sourceKey);
		if (source != null) add(purposes, "catalog", source);
		const thumb = await sizeOfKey(row.thumbnail);
		if (thumb != null) add(purposes, "catalog", thumb);
	}

	// ── Cloud saves, by the player ───────────────────────────────────────────────
	const saveRows = await db
		.select({
			userId: workSaves.userId,
			total: sql<string>`COALESCE(SUM(${workSaves.byteSize}), 0)`,
		})
		.from(workSaves)
		.groupBy(workSaves.userId);
	for (const row of saveRows) {
		add(account(row.userId).purposes, "cloud-saves", Number(row.total));
	}

	// ── Upsert, one row per account with any bytes at all ────────────────────────
	// An account with zero bytes across every kind writes no row: an empty reading is
	// indistinguishable from "not yet metered", and a row of zeros per idle account is
	// noise the reading surface would have to filter. The `kept-files` kind therefore
	// rides in every written row's split at zero until its surface lands, which is the
	// visible-in-the-vocabulary posture `emptyPurposes` chose.
	let written = 0;
	for (const [userId, entry] of byUser) {
		const total = STORAGE_USE_KINDS.reduce((sum, k) => sum + entry.purposes[k], 0);
		if (total === 0) continue;
		await db
			.insert(storageUsage)
			.values({
				userId,
				billingCycle: cycle,
				bytes: total,
				purposes: { ...entry.purposes },
				// The upsert carries this run's stamp: one row per (user, cycle, no) —
				// sampled_at names when the current figure was taken, and the cycle's
				// history is what billing needs rather than what a second table keeps.
				sampledAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [storageUsage.userId, storageUsage.billingCycle],
				set: {
					bytes: sql`excluded.bytes`,
					purposes: sql`excluded.purposes`,
					sampledAt: sql`excluded.sampled_at`,
				},
			});
		written += 1;
	}
	return written;
}

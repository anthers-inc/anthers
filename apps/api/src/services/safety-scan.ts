/**
 * The media safety scan — the only thing that turns a detection vendor's answer into an
 * Anthers determination, following the one-writer pattern `services/moderation.ts` and
 * `services/quarantine.ts` establish.
 *
 * 🚨 **The mapping in this file is a transcription of policy, not a design choice.**
 * § 7.3 of 60.13 (Child Safety Reporting Policy) is the authority, and it says what
 * triggers a report is **the classification a match carries, not the fact that something
 * matched**. The failure this prevents is specific and was nearly shipped: Shield's
 * *Harmful-Abusive Material* classification IS a confirmed match against known material,
 * while § 2 of their terms defines it as material that "may not meet the legal definition
 * of CSAM or be classified as illegal in all countries". Reporting on it would mean
 * reporting material the vendor itself says may be lawful — the *Lawshe v. Verizon* (2025)
 * exposure that § 7.3 exists to avoid, pointed the wrong way.
 *
 * ⚠️ **Our determination is ours.** § 7.6: a vendor's data is an input and never a
 * substitute. `Determination` below is Anthers' vocabulary; the vendor's own word travels
 * separately as `VendorMatch` and is kept out of the operator queue and the moderation
 * log, because § 6(b)/(c) of the Shield terms make agent use of it a prohibited use.
 */

import { db } from "@anthers/db/client";
import type { VendorMatch } from "@anthers/db/schema";
import { mediaScans, works } from "@anthers/db/schema";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
	type ShieldClassification,
	type ShieldCredentials,
	ShieldError,
	scanPdqHashes,
	shieldCredentials,
} from "../lib/arachnid-shield";
import { MIN_PDQ_QUALITY, type PdqHash, pdqHashImage } from "../lib/pdq";
import { urlToKey } from "./media-purge.js";
import { quarantineWork } from "./quarantine.js";
import { storage } from "./storage/index.js";

/** The vendor identifier recorded on every `VendorMatch` this service writes. */
export const VENDOR = "arachnid-shield";

/**
 * What **Anthers** concluded, in Anthers' words.
 *
 * - `clean` — nothing known matched. The overwhelmingly common answer.
 * - `apparent-csam` — a match classified as child sexual abuse material. Quarantine, and a
 *   reporting trigger under § 7.3, handled by a human via the 60.14 runbook.
 * - `harmful-abusive` — a match the vendor says may not be illegal. **Quarantine, and
 *   explicitly NOT a reporting trigger.** A content decision about whether the work stays
 *   up, which is precisely what § 7.3 calls it.
 * - `unscannable` — no usable fingerprint could be computed. Not a verdict about the
 *   content; a statement that the question was never asked.
 */
export type Determination = "clean" | "apparent-csam" | "harmful-abusive" | "unscannable";

export interface ScanOutcome {
	determination: Determination;
	/** Present only when a vendor actually answered. Never shown to an operator or agent. */
	vendorMatch: VendorMatch | null;
	/** True only for `apparent-csam`. Read this rather than re-deriving it from the enum. */
	reportable: boolean;
	/** True when the content must stop being served, for either kind of match. */
	quarantine: boolean;
}

/**
 * Turn one vendor classification into an Anthers determination.
 *
 * Every one of Shield's four values is handled explicitly. 🚨 **`test` is a match in the
 * vendor's vocabulary and a non-event in ours** — it exists so an integration can be
 * exercised without real material, so treating "not `no-known-match`" as a hit would
 * quarantine somebody's upload on a fixture.
 */
export function determinationFor(classification: ShieldClassification): {
	determination: Determination;
	reportable: boolean;
	quarantine: boolean;
} {
	switch (classification) {
		case "csam":
			return { determination: "apparent-csam", reportable: true, quarantine: true };
		case "harmful-abusive-material":
			// Quarantined but never reported — see the file header and § 7.3.
			return { determination: "harmful-abusive", reportable: false, quarantine: true };
		case "test":
		case "no-known-match":
			return { determination: "clean", reportable: false, quarantine: false };
	}
}

const CLEAN: ScanOutcome = {
	determination: "clean",
	vendorMatch: null,
	reportable: false,
	quarantine: false,
};

const UNSCANNABLE: ScanOutcome = {
	determination: "unscannable",
	vendorMatch: null,
	reportable: false,
	quarantine: false,
};

/**
 * Scan one already-computed PDQ hash.
 *
 * ⚠️ **A low-quality hash is never sent.** PDQ reports its own confidence, and a
 * featureless image produces a fingerprint with no signal in it. Matching on noise against
 * a corpus of real material produces false positives, and a false positive here
 * quarantines somebody's work and puts a report in front of a named human. § 2258A(f)
 * means there is no duty to search at all, so declining costs nothing that was owed.
 *
 * ⚠️ **Throws when the vendor cannot be reached.** A scan that did not happen must not be
 * recorded as a scan that found nothing — the caller has to be able to leave the work
 * owed and try again. `null` credentials are the one non-throwing absence, because "no
 * detection vendor is configured" is a deployment state rather than a failure.
 */
export async function scanPdqHash(
	pdq: PdqHash,
	options: { credentials?: ShieldCredentials | null; now?: () => Date; baseUrl?: string } = {},
): Promise<ScanOutcome> {
	if (pdq.quality < MIN_PDQ_QUALITY) return UNSCANNABLE;

	const credentials = options.credentials !== undefined ? options.credentials : shieldCredentials();
	if (!credentials) return UNSCANNABLE;

	const answers = await scanPdqHashes([pdq.hash], credentials, { baseUrl: options.baseUrl });
	const answer = answers.get(pdq.hash);
	// Asked about one hash and told about none. That is not "nothing matched" — it is an
	// unanswered question, and treating it as clean is how a scan silently stops working.
	if (!answer) throw new ShieldError("Shield did not answer for the submitted hash");

	const { determination, reportable, quarantine } = determinationFor(answer.classification);
	if (determination === "clean") return CLEAN;

	const now = options.now?.() ?? new Date();
	return {
		determination,
		reportable,
		quarantine,
		vendorMatch: {
			vendor: VENDOR,
			classification: answer.classification,
			matchType: answer.matchType ?? "none",
			receivedAt: now.toISOString(),
		},
	};
}

/**
 * Scan one stored object and record what came back.
 *
 * ⚠️ **The row is written whatever the answer is, including `unscannable`.** A scan that
 * happened and found nothing and a scan that could not happen are both facts worth having,
 * and collapsing them is how "we scan uploads" quietly becomes untrue. What must never
 * happen is a row appearing for a scan that did not complete — so a vendor failure throws
 * out of here, leaving the object unscanned and the job to be retried.
 *
 * 🚨 **A match quarantines through `quarantineWork` and nothing else.** That service is the
 * single writer for taking content out of reach, and it is what places the preservation
 * holds § 2258A(h) requires. Reporting stays manual either way: § 7.3 makes a `csam`
 * classification a trigger for a human following the 60.14 runbook, never an automatic
 * report, because a wrongly-automated report carries its own liability.
 */
export async function scanStoredImage(
	storageKey: string,
	options: {
		workId?: number | null;
		credentials?: ShieldCredentials | null;
		baseUrl?: string;
		now?: () => Date;
	} = {},
): Promise<ScanOutcome> {
	const bytes = await storage.read(storageKey);
	// A key the database names and storage does not have. Recorded as unscannable rather
	// than thrown, because retrying forever will not make a deleted object reappear.
	const pdq = bytes ? await pdqHashImage(bytes) : null;

	const outcome = pdq
		? await scanPdqHash(pdq, {
				credentials: options.credentials,
				baseUrl: options.baseUrl,
				now: options.now,
			})
		: UNSCANNABLE;

	await recordScan(storageKey, options.workId ?? null, pdq, outcome);

	if (outcome.quarantine && options.workId) {
		await quarantineWork({
			workId: options.workId,
			source: "scan",
			// Our word, not theirs. The vendor's own answer rides `vendorMatch`.
			classification: outcome.determination,
			vendorMatch: outcome.vendorMatch,
			note: `safety scan: ${storageKey}`,
		});
	}
	return outcome;
}

// ─── The release gate ────────────────────────────────────────────────────────

type WorkRow = typeof works.$inferSelect;

/**
 * How long a creator waits for a queued scan before release gives way and proceeds.
 *
 * 🚨 **The give-way is the design, not a weakening of it.** Gating release on a completed
 * scan with no time limit means a detection vendor's outage stops every creator on Anthers
 * from releasing anything — and 18 U.S.C. § 2258A(f) imposes no duty to search at all, so
 * that would be trading a publishing platform's core function for an obligation nobody
 * owes. What the gate is actually worth is the ordinary case: the queue is seconds behind,
 * and closing a seconds-wide window in which an unscanned image is public is cheap.
 *
 * ⚠️ **Giving way is safe because quarantine reaches a released Work.** `quarantineWork`
 * writes `works.quarantine_status`, which `resolveAccessSync` checks before every other
 * rule — including for people who have paid. So a scan that lands after release still takes
 * the material out of reach; what release-before-scan costs is the window, not the remedy.
 *
 * Two minutes rather than two seconds because the scan is a queued job behind a worker that
 * may be busy, and rather than twenty because past a couple of minutes a creator has
 * stopped reading "still checking" and started reading "broken".
 */
export const SCAN_RELEASE_GRACE_MS = 2 * 60 * 1000;

/**
 * The stored objects of a Work that a detection scan can read today.
 *
 * ⚠️ **This is the one definition, and both callers have to share it.** The set the release
 * gate waits on and the set the enqueue path sends are the same set by construction; two
 * copies would drift the moment video keyframes or archive members are added, and the
 * failure mode of that drift is a gate that waits for a scan nobody queued.
 *
 * Only images, because PDQ is an image hash. A video's *thumbnail* is in scope — it is an
 * extracted frame and therefore new image bytes — while its frames are not yet. The
 * coverage map lives in wiki 40.12 and deliberately not on the public safety page.
 */
export function scannableKeys(work: Pick<WorkRow, "type" | "sourceKey" | "thumbnail">): string[] {
	const keys = new Set<string>();
	if (work.type === "image" && work.sourceKey) keys.add(work.sourceKey);
	// Thumbnails may be stored as a full URL on older rows; `urlToKey` normalizes both.
	if (work.thumbnail) {
		const key = urlToKey(work.thumbnail);
		if (key) keys.add(key);
	}
	return [...keys];
}

/**
 * Stamp a Work as owing scans, and say which objects those are.
 *
 * The caller sends the jobs; this writes the record, on the one-writer rule that keeps
 * `services/quarantine.ts` the only writer of `quarantine_status`. Returning an empty array
 * means the Work owes nothing and nothing should be enqueued — and leaves `scan_queued_at`
 * untouched, so a Work that never had a scannable object never acquires a clock.
 *
 * ⚠️ **Re-stamping on every enqueue is deliberate.** Replacing a thumbnail is new bytes from
 * the same uploader owing a fresh answer, so the grace window restarts with it.
 */
export async function beginScans(work: WorkRow, now: Date = new Date()): Promise<string[]> {
	const keys = scannableKeys(work);
	if (keys.length === 0) return [];
	await db.update(works).set({ scanQueuedAt: now }).where(eq(works.id, work.id));
	return keys;
}

export interface ScanReleaseGate {
	/** Objects this Work owes a scan for that have no answer yet. */
	pending: string[];
	/** True when release must wait: something is pending and the window has not run out. */
	blocked: boolean;
	/** When the wait gives way. Null when nothing is pending. */
	waitUntil: Date | null;
}

/**
 * Whether this Work may be released yet, as far as detection is concerned.
 *
 * 🚨 **A row is an answer, whatever it says, and `unscannable` is not `clean`.** Both let
 * release proceed and they mean opposite things: `clean` is *we asked and nothing known
 * matched*, while `unscannable` is *the question was never askable* — a featureless image
 * PDQ cannot fingerprint, an object storage no longer holds, or a deployment with no
 * detection vendor configured. Neither is a reason to hold somebody's work, because § 2258A(f)
 * owes no search; but collapsing them would let "we scan uploads" quietly become untrue
 * while every gate still passed. The distinction is preserved where it is legible — in the
 * row — and this function deliberately does not re-derive a verdict from it.
 *
 * A match never reaches here: `quarantineWork` has already flipped `quarantine_status`, and
 * a quarantined Work 404s out of the edit route before any of this runs.
 */
export async function scanReleaseGate(
	work: WorkRow,
	now: Date = new Date(),
): Promise<ScanReleaseGate> {
	const keys = scannableKeys(work);
	if (keys.length === 0) return { pending: [], blocked: false, waitUntil: null };

	const answered = await db
		.select({ storageKey: mediaScans.storageKey })
		.from(mediaScans)
		.where(inArray(mediaScans.storageKey, keys));
	const seen = new Set(answered.map((row) => row.storageKey));
	const pending = keys.filter((key) => !seen.has(key));
	if (pending.length === 0) return { pending: [], blocked: false, waitUntil: null };

	// No clock means the objects were attached before this gate existed, or by a path that
	// never enqueued anything. Either way there is nothing to wait for, and holding a
	// release on a scan that was never queued would be an outage of our own making.
	if (!work.scanQueuedAt) return { pending, blocked: false, waitUntil: null };

	const waitUntil = new Date(work.scanQueuedAt.getTime() + SCAN_RELEASE_GRACE_MS);
	return { pending, blocked: now < waitUntil, waitUntil };
}

/**
 * Works whose scans are still owed — a clock was started and at least one object never got
 * an answer back.
 *
 * ⭐ **This is what makes "still owed" true rather than a figure of speech.** The give-way
 * above lets a Work out before its answer arrives, and `scan-media` gives up after its retry
 * budget, so without a sweep re-asking, an object caught by a vendor outage would simply
 * never be scanned again and the gate would be a formality. It is the same shape as the
 * five-minute `escalate-reports` retry, at a slower cadence because nothing here is waiting
 * on a person.
 */
export async function worksOwedScans(limit = 200): Promise<Array<{ id: number; keys: string[] }>> {
	const candidates = await db
		.select({
			id: works.id,
			type: works.type,
			sourceKey: works.sourceKey,
			thumbnail: works.thumbnail,
		})
		.from(works)
		.where(
			and(
				isNotNull(works.scanQueuedAt),
				// A coarse filter, and deliberately over-inclusive: it compares the stored
				// strings, so a thumbnail held as a full URL and a source key belonging to a
				// video both survive it. `scannableKeys` below is what decides, and doing the
				// cheap half in SQL is what keeps a backlog of one from reading every Work
				// that ever carried an image into application memory.
				or(
					sql`${works.sourceKey} <> '' AND NOT EXISTS (
						SELECT 1 FROM ${mediaScans} ms WHERE ms.storage_key = ${works.sourceKey})`,
					sql`${works.thumbnail} <> '' AND NOT EXISTS (
						SELECT 1 FROM ${mediaScans} ms WHERE ms.storage_key = ${works.thumbnail})`,
				),
			),
		)
		.limit(limit);

	const owed: Array<{ id: number; keys: string[] }> = [];
	for (const work of candidates) {
		const keys = scannableKeys(work);
		if (keys.length === 0) continue;
		const answered = await db
			.select({ storageKey: mediaScans.storageKey })
			.from(mediaScans)
			.where(inArray(mediaScans.storageKey, keys));
		const seen = new Set(answered.map((row) => row.storageKey));
		const pending = keys.filter((key) => !seen.has(key));
		if (pending.length > 0) owed.push({ id: work.id, keys: pending });
	}
	return owed;
}

/** The only writer of `media_scans`. A re-scan replaces the row rather than stacking. */
export async function recordScan(
	storageKey: string,
	workId: number | null,
	pdq: PdqHash | null,
	outcome: ScanOutcome,
): Promise<void> {
	const row = {
		storageKey,
		workId,
		pdqHash: pdq?.hash ?? null,
		pdqQuality: pdq?.quality ?? null,
		determination: outcome.determination,
		vendorMatch: outcome.vendorMatch,
		scannedAt: new Date(),
	};
	await db
		.insert(mediaScans)
		.values(row)
		.onConflictDoUpdate({ target: mediaScans.storageKey, set: row });
}

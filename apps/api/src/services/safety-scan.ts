/**
 * The media safety scan — the only thing that turns a detection vendor's answer into an
 * Anthers determination, following the one-writer pattern `services/moderation.ts` and
 * `services/quarantine.ts` establish.
 *
 * 🚨 **The mapping in this file is a transcription of policy, not a design choice.**
 * § 7.3 of the Child Safety Reporting Policy (Child Safety Reporting Policy) is the authority, and it says what
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

import { rm } from "node:fs/promises";
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
import { hashVideoFrames, probeVideo, type SampledFrame } from "../lib/video-frames.js";
import { urlToKey } from "./media-purge.js";
import { type QuarantineObjectKind, quarantineObject, quarantineWork } from "./quarantine.js";
import { storage } from "./storage/index.js";

/** The vendor identifier recorded on every `VendorMatch` this service writes. */
export const VENDOR = "arachnid-shield";

/**
 * What **Anthers** concluded, in Anthers' words.
 *
 * - `clean` — nothing known matched. The overwhelmingly common answer.
 * - `apparent-csam` — a match classified as child sexual abuse material. Quarantine, and a
 *   reporting trigger under § 7.3, handled by a human via the Child Safety Incident Runbook runbook.
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
 * A scan that could not complete because the vendor did not answer, carrying the
 * fingerprint we had already computed.
 *
 * 🚨 **The hash is the whole reason this type exists**, and discarding it made an outage
 * indistinguishable from an unhashable image. `unscannable` has three causes and only two
 * of them are permanent: an object we could not fingerprint at all (`pdq_hash` null), one
 * whose fingerprint carried no signal (`pdq_quality` below {@link MIN_PDQ_QUALITY}), and one
 * we had a perfectly good fingerprint for and simply never got an answer about. **Only the
 * third is worth re-asking**, and the two existing columns separate all three — provided the
 * hash survives the failure. It did not, until 2026-08-30.
 */
export class ScanUnansweredError extends Error {
	constructor(
		readonly pdq: PdqHash | null,
		override readonly cause: unknown,
	) {
		super("The detection vendor did not answer");
		this.name = "ScanUnansweredError";
	}
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
 * 🚨 **A match quarantines through `services/quarantine.ts` and nothing else**, by whichever
 * of its two doors the subject calls for — see {@link quarantineMatch}. That service is the
 * single writer for taking content out of reach, and it is what places the preservation
 * holds § 2258A(h) requires. Reporting stays manual either way: § 7.3 makes a `csam`
 * classification a trigger for a human following the Child Safety Incident Runbook runbook, never an automatic
 * report, because a wrongly-automated report carries its own liability.
 */
export async function scanStoredImage(
	storageKey: string,
	options: ScanSubject & {
		credentials?: ShieldCredentials | null;
		baseUrl?: string;
		now?: () => Date;
	} = {},
): Promise<ScanOutcome> {
	const bytes = await storage.read(storageKey);
	// A key the database names and storage does not have. Recorded as unscannable rather
	// than thrown, because retrying forever will not make a deleted object reappear.
	const pdq = bytes ? await pdqHashImage(bytes) : null;

	let outcome: ScanOutcome;
	if (pdq) {
		try {
			outcome = await scanPdqHash(pdq, {
				credentials: options.credentials,
				baseUrl: options.baseUrl,
				now: options.now,
			});
		} catch (cause) {
			// 🚨 **Still thrown, and still recording nothing** — `worksOwedScans` finds an
			// owed object by the ABSENCE of a row, so writing one here would take the object
			// out of the sweep that exists to re-ask it. What changes is only that the
			// fingerprint travels with the failure, so a caller that has no retry can record
			// *what* went unanswered instead of discarding it.
			throw new ScanUnansweredError(pdq, cause);
		}
	} else {
		outcome = UNSCANNABLE;
	}

	await recordScan(storageKey, options.workId ?? null, pdq, outcome);

	if (outcome.quarantine) {
		await quarantineMatch(storageKey, outcome, options, `safety scan: ${storageKey}`);
	}
	return outcome;
}

/**
 * What the scanned object belongs to, which decides which quarantine door a match takes.
 *
 * 🚨 **Exactly one of these is expected, and neither being present is the bug this type
 * exists to make visible.** A match on an object with no subject at all has nowhere to be
 * recorded and nobody to hold, so the finding is discarded — which is precisely what
 * happened to every badge, avatar and cover before {@link quarantineObject} existed, on a
 * branch that read as a guard.
 */
export interface ScanSubject {
	/** The Work it belongs to, when it belongs to one. */
	workId?: number | null;
	/** Who uploaded it, for an object that belongs to no Work. */
	uploaderId?: number | null;
	/** Which kind of Work-less object this is. Its presence is what selects that door. */
	objectKind?: QuarantineObjectKind | null;
}

/**
 * Scan an object an upload handler is holding open, and never fail the upload because a
 * detection vendor is having a bad day.
 *
 * ⭐ **The give-way is the same one the release gate makes, for the same reason.** § 2258A(f)
 * imposes no duty to search at all, so refusing somebody's avatar because a third party is
 * unreachable trades a working platform for an obligation nobody owes. `scanStoredImage`
 * throws on a vendor failure because its other caller is a *job* that must be able to leave
 * the object owed and retry; an HTTP handler has no retry, so the failure is absorbed here
 * and recorded as what it actually was.
 *
 * 🚨 **`unscannable` is written rather than nothing, and that distinction is the whole
 * point.** A row saying *the question could not be answered* is what keeps "uploaded images
 * are checked" honest; no row at all would leave a vendor outage indistinguishable from a
 * clean scan in our own records. What must never appear is a `clean` row for a scan that
 * did not happen, and this writes no such thing.
 *
 * ⭐ **The fingerprint is kept, which is what makes the row re-askable later.** A row saying
 * `unscannable` with a usable hash on it can only mean *we asked nobody and here is exactly
 * what we would have asked about*; the same row with no hash means we could never have
 * asked. {@link ScanUnansweredError} carries it out of the failure so the distinction
 * survives, and re-asking costs a vendor call rather than another read and another hash.
 *
 * ⚠️ **Nothing sweeps these afterwards yet.** `worksOwedScans` enumerates Works and finds
 * them by the absence of a row, so a Work-less object — which now has a row — is outside it
 * in both directions. Closing that is its own task; what this function guarantees is that
 * the sweep, when it exists, has something unambiguous to select on.
 *
 * 🚨 **A caller passing a `workId` here would take that object out of `worksOwedScans`**,
 * because writing any row is what removes a key from a sweep keyed on absence. No caller
 * does today — both upload doors pass an `objectKind` and no Work — and the Work-less sweep
 * arm is what makes it safe when one does.
 */
export async function scanInlineUpload(
	storageKey: string,
	subject: ScanSubject,
): Promise<ScanOutcome> {
	try {
		return await scanStoredImage(storageKey, subject);
	} catch (err) {
		const pdq = err instanceof ScanUnansweredError ? err.pdq : null;
		await recordScan(storageKey, subject.workId ?? null, pdq, UNSCANNABLE);
		return UNSCANNABLE;
	}
}

/**
 * Send one match to whichever writer owns its subject.
 *
 * ⭐ **This is the fix for the badge-art asymmetry, and it lives here rather than in a
 * route on purpose.** The scanner is the one place that knows a match happened, so closing
 * the gap here covers every caller that has no Work behind it — the badge endpoint, the
 * direct-upload route, and whatever ingest door is added next — rather than each of them
 * remembering to. § 2258A attaches on actual knowledge however it arrives; a scan we ran
 * and recorded is knowledge, and where the file was going is not a reason to keep it.
 *
 * ⚠️ **A match with no subject at all is logged loudly rather than swallowed.** It means a
 * caller scanned something and told us nothing about whose it was, and the material stays
 * servable — so it has to be findable in the worker log rather than being a silent `if`.
 */
async function quarantineMatch(
	storageKey: string,
	outcome: ScanOutcome,
	subject: ScanSubject,
	note: string,
): Promise<void> {
	if (subject.workId) {
		await quarantineWork({
			workId: subject.workId,
			source: "scan",
			// Our word, not theirs. The vendor's own answer rides `vendorMatch`.
			classification: outcome.determination,
			vendorMatch: outcome.vendorMatch,
			note,
		});
		return;
	}
	if (subject.objectKind) {
		await quarantineObject({
			storageKey,
			uploaderId: subject.uploaderId ?? null,
			objectKind: subject.objectKind,
			source: "scan",
			classification: outcome.determination,
			vendorMatch: outcome.vendorMatch,
			note,
		});
		return;
	}
	// 🚨 The vendor's classification is deliberately absent from this line, on the same rule
	// `jobs/scan-media.ts` states: a worker log is read by agents, and Match Data may not be.
	console.error(
		`[safety-scan] ${storageKey}: ${outcome.determination} with no Work and no object kind — NOT quarantined`,
	);
}

/**
 * Scan a stored **video** by sampling it into frames.
 *
 * 🚨 **The worst frame decides the video, and that asymmetry is the whole point.** One
 * matching frame in ninety minutes of otherwise unremarkable footage is the case this
 * exists for, so the outcomes are folded by severity rather than by majority or by first
 * answer. `apparent-csam` beats `harmful-abusive` beats `clean`.
 *
 * ⭐ **Every sampled frame gets its own `media_scans` row, keyed `<sourceKey>#t=<seconds>`,
 * beside one summary row at the source key itself.** The per-frame hashes are ours rather
 * than the vendor's, so keeping them is free of every Match Data restriction — and they are
 * what lets a corpus update be re-checked later without decoding the video again, which for
 * video is the expensive half. The summary row is what the release gate and the owed sweep
 * watch, because they enumerate keys before anything has been decoded and cannot know how
 * many frames there will be.
 *
 * ⚠️ **A vendor failure throws and records nothing**, on the same rule the image path
 * follows: a scan that did not happen must not leave a row saying nothing matched.
 */
export async function scanStoredVideo(
	storageKey: string,
	options: ScanSubject & {
		credentials?: ShieldCredentials | null;
		baseUrl?: string;
		now?: () => Date;
	} = {},
): Promise<ScanOutcome> {
	const workId = options.workId ?? null;

	let frames: SampledFrame[] = [];
	let localPath: string | null = null;
	try {
		localPath = await storage.downloadToTemp(storageKey);
		const probe = await probeVideo(localPath);
		frames = probe
			? await hashVideoFrames(localPath, {
					width: probe.width,
					height: probe.height,
					durationSeconds: probe.durationSeconds,
				})
			: [];
	} catch {
		// A key storage no longer has, a container ffmpeg will not open, a file that is not
		// a video at all. Unscannable rather than thrown: retrying will not change any of
		// them, and the row is what says the question was asked and could not be answered.
		frames = [];
	} finally {
		if (localPath) await rm(localPath).catch(() => {});
	}

	if (frames.length === 0) {
		await recordScan(storageKey, workId, null, UNSCANNABLE);
		return UNSCANNABLE;
	}

	const outcomes = await scanPdqHashBatch(
		frames.map((f) => f.hash),
		options,
	);

	const rows = frames.map((frame) => ({
		storageKey: `${storageKey}#t=${frame.atSeconds}`,
		pdq: frame.hash,
		outcome: outcomes.get(frame.hash.hash) ?? UNSCANNABLE,
	}));

	const worst = worstOutcome(rows.map((r) => r.outcome));
	// Frames first, then the summary. A crash between the two leaves the video still owed,
	// which the sweep re-asks — the other order would mark it answered with nothing behind it.
	await recordScans(rows.map((r) => ({ ...r, workId })));
	await recordScan(storageKey, workId, null, worst);

	if (worst.quarantine) {
		await quarantineMatch(storageKey, worst, options, `safety scan: ${storageKey} (video frame)`);
	}
	return worst;
}

/**
 * Fold many frame outcomes into one answer for the video.
 *
 * 🚨 **The worst frame decides, and nothing about this is a majority.** One matching frame
 * in ninety minutes of otherwise unremarkable footage is precisely the case video coverage
 * exists for, so a single `apparent-csam` among a hundred and ninety-nine `clean` answers
 * makes the video `apparent-csam`.
 *
 * ⭐ **`unscannable` ranks below `clean`, which is the ordering worth stating.** A frame
 * nobody could fingerprint is an unasked question, and a video where *some* frames were
 * asked and came back clean has been scanned — so one unhashable fade-to-black must not
 * drag the whole video down to "never examined". A video where **every** frame was
 * unscannable has genuinely not been examined, and folding an empty-of-answers list
 * naturally lands there.
 */
export function worstOutcome(outcomes: ScanOutcome[]): ScanOutcome {
	const severity = (o: ScanOutcome): number =>
		({ "apparent-csam": 3, "harmful-abusive": 2, clean: 1, unscannable: 0 })[o.determination];
	return outcomes.reduce(
		(acc, o) => (severity(o) > severity(acc) ? o : acc),
		UNSCANNABLE as ScanOutcome,
	);
}

/**
 * Ask about many hashes in one request, and answer per hash.
 *
 * ⚠️ **A hash the vendor did not answer for is absent from the result**, and the caller
 * must read that as *unanswered* rather than *nothing matched*. `scanPdqHash` throws in
 * that situation because it asked about exactly one thing; here a single missing frame out
 * of two hundred is not worth failing a whole video over, so it is recorded as
 * `unscannable` — visible in the row, and re-askable.
 *
 * Hashes below `MIN_PDQ_QUALITY` are never sent, so a featureless frame — a fade to black,
 * a title card — cannot contribute a match to anything.
 */
async function scanPdqHashBatch(
	hashes: PdqHash[],
	options: { credentials?: ShieldCredentials | null; now?: () => Date; baseUrl?: string } = {},
): Promise<Map<string, ScanOutcome>> {
	const out = new Map<string, ScanOutcome>();
	const credentials = options.credentials !== undefined ? options.credentials : shieldCredentials();
	if (!credentials) return out;

	const askable = hashes.filter((h) => h.quality >= MIN_PDQ_QUALITY);
	if (askable.length === 0) return out;

	const answers = await scanPdqHashes([...new Set(askable.map((h) => h.hash))], credentials, {
		baseUrl: options.baseUrl,
	});
	const now = options.now?.() ?? new Date();
	for (const [hex, answer] of answers) {
		const { determination, reportable, quarantine } = determinationFor(answer.classification);
		out.set(
			hex,
			determination === "clean"
				? CLEAN
				: {
						determination,
						reportable,
						quarantine,
						vendorMatch: {
							vendor: VENDOR,
							classification: answer.classification,
							matchType: answer.matchType ?? "none",
							receivedAt: now.toISOString(),
						},
					},
		);
	}
	return out;
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
 * ⭐ **Each key carries how it must be read**, rather than leaving the caller to work it out
 * from the Work's type. A video source and an image share a key namespace and need
 * completely different handling — one is hashed directly, the other is decoded into frames
 * — and reconstructing that at each of the three call sites is how one of them eventually
 * sends a video to the image path and records the whole file as unscannable.
 *
 * Audio is still uncovered, and so is anything inside an archive: PDQ has nothing to say
 * about either. The coverage map is deliberately not public and deliberately not on the public
 * safety page, because a temporary gap published is an evasion map with a shelf life.
 */
export type ScannableKind = "image" | "video";

export interface ScannableObject {
	key: string;
	kind: ScannableKind;
}

export function scannableKeys(
	work: Pick<WorkRow, "type" | "sourceKey" | "thumbnail">,
): ScannableObject[] {
	const out = new Map<string, ScannableKind>();
	if (work.type === "image" && work.sourceKey) out.set(work.sourceKey, "image");
	if (work.type === "video" && work.sourceKey) out.set(work.sourceKey, "video");
	// Thumbnails may be stored as a full URL on older rows; `urlToKey` normalizes both.
	// A video's thumbnail is an image and is scanned as one — it is new bytes either way.
	if (work.thumbnail) {
		const key = urlToKey(work.thumbnail);
		if (key && !out.has(key)) out.set(key, "image");
	}
	return [...out].map(([key, kind]) => ({ key, kind }));
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
export async function beginScans(
	work: WorkRow,
	now: Date = new Date(),
): Promise<ScannableObject[]> {
	const objects = scannableKeys(work);
	if (objects.length === 0) return [];
	await db.update(works).set({ scanQueuedAt: now }).where(eq(works.id, work.id));
	return objects;
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
	const keys = scannableKeys(work).map((o) => o.key);
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
export async function worksOwedScans(
	limit = 200,
): Promise<Array<{ id: number; objects: ScannableObject[] }>> {
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

	const owed: Array<{ id: number; objects: ScannableObject[] }> = [];
	for (const work of candidates) {
		const objects = scannableKeys(work);
		if (objects.length === 0) continue;
		const answered = await db
			.select({ storageKey: mediaScans.storageKey })
			.from(mediaScans)
			.where(
				inArray(
					mediaScans.storageKey,
					objects.map((o) => o.key),
				),
			);
		const seen = new Set(answered.map((row) => row.storageKey));
		const pending = objects.filter((o) => !seen.has(o.key));
		if (pending.length > 0) owed.push({ id: work.id, objects: pending });
	}
	return owed;
}

/**
 * Record many scans at once — the video path, which writes a row per sampled frame.
 *
 * Same replace-rather-than-stack rule as `recordScan`, in one statement because two hundred
 * round trips for one video is two hundred chances to be interrupted halfway.
 */
export async function recordScans(
	entries: Array<{
		storageKey: string;
		workId: number | null;
		pdq: PdqHash | null;
		outcome: ScanOutcome;
	}>,
): Promise<void> {
	if (entries.length === 0) return;
	const scannedAt = new Date();
	const rows = entries.map((e) => ({
		storageKey: e.storageKey,
		workId: e.workId,
		pdqHash: e.pdq?.hash ?? null,
		pdqQuality: e.pdq?.quality ?? null,
		determination: e.outcome.determination,
		vendorMatch: e.outcome.vendorMatch,
		scannedAt,
	}));
	await db
		.insert(mediaScans)
		.values(rows)
		.onConflictDoUpdate({
			target: mediaScans.storageKey,
			set: {
				workId: sql`excluded.work_id`,
				pdqHash: sql`excluded.pdq_hash`,
				pdqQuality: sql`excluded.pdq_quality`,
				determination: sql`excluded.determination`,
				vendorMatch: sql`excluded.vendor_match`,
				scannedAt: sql`excluded.scanned_at`,
			},
		});
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

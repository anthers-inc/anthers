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
import { mediaScans } from "@anthers/db/schema";
import {
	type ShieldClassification,
	type ShieldCredentials,
	ShieldError,
	scanPdqHashes,
	shieldCredentials,
} from "../lib/arachnid-shield";
import { MIN_PDQ_QUALITY, type PdqHash, pdqHashImage } from "../lib/pdq";
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

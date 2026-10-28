// SPDX-License-Identifier: Apache-2.0
/**
 * The withdrawn-Work sweep — which media Anthers is *not* keeping.
 *
 * 🚨 **Since preservation became a program (Parker, 2026-10-25), this job's whole question
 * is whether the Work has a preserved version.** A Work anybody has saved to their Library
 * is kept indefinitely: its media is never removed, whatever its creator does, and nothing
 * expires. A Work nobody saved has no buyer to protect — a purchase saves itself to the
 * Library, so "nobody saved it" means "nobody bought it" — and its bytes go when it is
 * withdrawn.
 *
 * That replaced three ordered claims (still published / a keeper / ninety days). The
 * keeping election, the last-chance warning and the whole clock are gone: there is no
 * window to expire out of, so there is nothing to warn about. `WITHDRAWN_RESCUE_DAYS`
 * went with them.
 *
 * **Three things override preservation, and only three.** A copyright takedown, a
 * child-safety quarantine, and a legal hold — the first two take the bytes away because
 * keeping them is what the act forbids, and the third defers everything, including the
 * first two, because a hold is the one authority that outranks a sweep. A refund is not
 * among them: a refund ends a purchase, and preservation was never the purchase's.
 *
 * **The overrides are read on every work, never inferred from one.** The query's candidate
 * set is "withdrawn, stamped, bytes still present, and either unpreserved or overridden";
 * the hold check needs a call per Work, so it runs in the loop.
 *
 * 🚨 **Removal is `purgeWorkMedia`, the enumeration that already exists** — one place
 * decides what a Work's media IS, shared with delete and account-erasure. The Work's row
 * (its purchases, the Library entries, the buyers' cloud saves — a purchase outlives
 * everything) is left standing: the record survives the bytes, and `mediaPurgedAt` is what
 * says so, which is also what makes a second run cost nothing.
 */

import { db } from "@anthers/db/client";
import { workAssets, works, workTranscodingJobs } from "@anthers/db/schema";
import { and, eq, isNotNull, isNull, not, or } from "drizzle-orm";
import { isUnderHold } from "../services/legal-hold.js";
import { purgeWorkMedia } from "../services/media-purge.js";
import { hasPreservedVersion } from "../services/preservation.js";

/** What one sweep run did, so the worker logs a true figure. */
export interface SweepResult {
	/** Works whose media was removed this run. */
	sweptCount: number;
	/** Works the sweep spared because the program holds them. */
	keptCount: number;
}

/** The states that take a preserved Work's bytes away anyway. */
const OVERRIDES = or(
	eq(works.takedownStatus, "taken_down"),
	eq(works.quarantineStatus, "quarantined"),
);

/**
 * **The Work has no preserved version** — the negation of the one definition in
 * `services/preservation.ts`, shared with account deletion so the two paths cannot
 * disagree about which Works Anthers keeps.
 *
 * ⭐ Preservation marks a version (`works.preserved` while it is current,
 * `work_media_versions.preserved` once a replace retires it), so "is this Work kept" is a
 * question about its versions rather than about the row: the current version's flag, or
 * any archived one's. In practice a replacement inherits the flag and the answer is the
 * current version alone, but the sweep asks the definition rather than the shortcut.
 */
const NO_PRESERVED_VERSION = not(hasPreservedVersion);

export async function runWithdrawnSweep(now = new Date()): Promise<SweepResult> {
	// The candidate set: withdrawn, stamped, bytes still present, and not held by the
	// program — or held but overridden. Written as one predicate so the common case (a
	// preserved Work that withdrew) never reaches the loop at all.
	const due = await db
		.select({ id: works.id })
		.from(works)
		.where(
			and(
				eq(works.visibility, "withdrawn"),
				isNotNull(works.withdrawnAt),
				isNull(works.mediaPurgedAt),
				or(NO_PRESERVED_VERSION, OVERRIDES),
			),
		);
	if (due.length === 0) return { sweptCount: 0, keptCount: 0 };

	let sweptCount = 0;
	let keptCount = 0;
	for (const work of due) {
		// A legal hold outranks the sweep and the overrides with it: a held Work's bytes
		// stay whatever state it is in, and a later run picks it up again once the hold
		// lifts.
		if (await isUnderHold("work", work.id)) {
			keptCount += 1;
			continue;
		}
		const [item] = await db.select().from(works).where(eq(works.id, work.id)).limit(1);
		if (!item) continue;
		const [assetRows, jobRows] = await Promise.all([
			db.select().from(workAssets).where(eq(workAssets.workId, work.id)),
			db.select().from(workTranscodingJobs).where(eq(workTranscodingJobs.workId, work.id)),
		]);
		await purgeWorkMedia(item, assetRows, jobRows);
		await db.update(works).set({ mediaPurgedAt: now }).where(eq(works.id, work.id));
		sweptCount += 1;
	}

	return { sweptCount, keptCount };
}

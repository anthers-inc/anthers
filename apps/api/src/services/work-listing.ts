// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeping a Work's public listing on the network in step with the Work.
 *
 * `atproto-repo.ts` decides what should happen to a listing and carries it out against any
 * repository; this module is what connects that to an actual Work, an actual creator, and the
 * column that remembers where the record went. It is the only writer of `works.atproto_uri`.
 *
 * 🚨 **It re-reads the Work rather than being told what changed, and that is the design.**
 * Publishability is decided by four things — released, withdrawn, taken down, quarantined —
 * written by four different services, and a version of this that took "what happened" as an
 * argument would need every one of those call sites to describe the transition correctly and
 * for ever. Reading the current state makes every call idempotent: running it twice is
 * harmless, running it late still converges, and a caller that fires it for the wrong reason
 * costs nothing. **The enqueue is a hint that something moved, never a description of what.**
 *
 * 🚨 **A listing that outlives the thing it advertises is the failure this is shaped around.**
 * A record is public the moment it lands and deleting it afterwards broadcasts only the
 * deletion, so the delete path matters more than the create path: a Work that stops being
 * publicly listed must have its record REMOVED rather than merely skipped. That decision is
 * `planWorkRecord`'s and is tested without a network; what this adds is making sure the
 * decision is actually reached whenever the Work moves.
 *
 * ⚠️ **A creator with no identity Anthers hosts is the ordinary case.** Nothing is written,
 * nothing is logged as a problem, and nothing about publishing changes for them. Anthers turns
 * nobody away for lacking a handle, and this module is one of the places that could quietly
 * make one a requirement if it treated their absence as a failure.
 */
import { db } from "@anthers/db";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { syncWorkRecord, type WorkRecordPlan } from "./atproto-repo.js";
import { hostedWriterFor, type NoWriterReason } from "./hosted-repo-writer.js";

/** What syncing one Work's listing did. */
export type ListingSyncResult =
	/** The record was created, replaced, deleted, or correctly left alone. */
	| { status: "synced"; plan: WorkRecordPlan; uri: string | null }
	/** No listing is possible or needed, for a reason that is nobody's fault. */
	| { status: "skipped"; reason: NoWriterReason | "no_work" | "no_creator" }
	/** Something worth retrying went wrong. The job wrapper decides what to do about it. */
	| { status: "failed"; error: string };

/** Where a Work's public page lives, which the record points at. */
function baseUrl(): string {
	return process.env.FRONTEND_URL?.trim() || "https://anthers.org";
}

/**
 * Bring one Work's listing into line with the Work.
 *
 * ⚠️ **The row is read inside this call rather than passed in**, for the reason in the module
 * note: a stale snapshot is exactly how a withdrawn Work keeps its listing. The caller supplies
 * an id and nothing else.
 */
export async function syncWorkListing(
	workId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<ListingSyncResult> {
	const [work] = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			type: works.type,
			title: works.title,
			description: works.description,
			slug: works.slug,
			publicId: works.publicId,
			releasedAt: works.releasedAt,
			visibility: works.visibility,
			takedownStatus: works.takedownStatus,
			quarantineStatus: works.quarantineStatus,
			// Needed by `unpublishableReason` through `AccessibleWork`. Selected rather than cast
			// past: the compiler checking this shape is what stops a missing column from becoming
			// a record that silently lies about the Work.
			maturity: works.maturity,
			streamEnabled: works.streamEnabled,
			downloadEnabled: works.downloadEnabled,
			seedAccess: works.seedAccess,
			atprotoUri: works.atprotoUri,
		})
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return { status: "skipped", reason: "no_work" };

	// A Work whose creator deleted their account was withdrawn rather than destroyed, so its
	// buyers keep it — and there is no repository to write into. The withdrawal already means
	// no listing should exist; a record left behind is cleaned up by whichever sync ran while
	// the creator was still there.
	if (work.creatorId === null) return { status: "skipped", reason: "no_creator" };

	const opened = await hostedWriterFor(work.creatorId, opts);
	if (!opened.writer) return { status: "skipped", reason: opened.reason };

	try {
		const outcome = await syncWorkRecord(opened.writer, work, {
			baseUrl: baseUrl(),
			existingUri: work.atprotoUri,
		});

		// ⚠️ **Written only when it changed, and cleared with an explicit null.** The column is
		// unique, so writing the same URI back is harmless but pointless; what matters is that a
		// delete clears it, because a stale URI would make the next sync try to replace a record
		// that is gone and create an orphan.
		if (outcome.uri !== work.atprotoUri) {
			await db.update(works).set({ atprotoUri: outcome.uri }).where(eq(works.id, workId));
		}
		return { status: "synced", plan: outcome.plan, uri: outcome.uri };
	} catch (err) {
		// 🚨 The stored URI is deliberately left as it was. If the write failed we do not know
		// what landed, and forgetting where a record might be is how a duplicate listing gets
		// created on the retry.
		const error = err instanceof Error ? err.message : String(err);
		console.error(`[work-listing] ${workId}: ${error}`);
		return { status: "failed", error };
	}
}

/**
 * Ask for a Work's listing to be brought back into line, soon.
 *
 * ⭐ **Call this whenever a Work's publishability MIGHT have moved, without working out
 * whether it did.** The job re-reads and decides, so a spurious enqueue costs one database
 * read and a duplicate costs nothing — which is deliberately cheaper than asking every call
 * site to reason about transitions it does not otherwise care about. Under-calling is the
 * expensive mistake here, not over-calling.
 *
 * ⚠️ **Never throws.** Every caller is in the middle of something a creator or an operator
 * asked for — releasing, withdrawing, taking down, quarantining — and none of those may fail
 * because a queue was briefly unavailable. A listing that missed its enqueue is caught by the
 * reconciling sweep; a release that failed because of one is a creator's afternoon.
 */
export async function queueWorkListingSync(workId: number): Promise<void> {
	try {
		const { queue, QUEUES, JOB_OPTIONS } = await import("../jobs/queue.js");
		await queue.send(QUEUES.SYNC_WORK_LISTING, { workId }, JOB_OPTIONS[QUEUES.SYNC_WORK_LISTING]);
	} catch (err) {
		console.error(
			`[work-listing] could not enqueue a sync for ${workId}: ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

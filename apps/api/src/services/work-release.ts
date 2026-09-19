// SPDX-License-Identifier: Apache-2.0
/**
 * Whether a Work may be released, and if not, why — the one place the release conditions live.
 *
 * 🚨 **Two paths release a Work, and a condition written into only one of them is a condition
 * the other walks straight past.** `PATCH /works/:id` releases when a creator asks, and
 * `jobs/release-scheduled.ts` releases on a clock with nobody asking. Both call
 * {@link releaseRefusal}, so adding a readiness condition means adding it here and nowhere else.
 *
 * ⭐ **Every refusal says whether it resolves on its own.** A file still uploading, media still
 * processing and a scan not yet answered are things a creator waits for; payout setup, the
 * rating, an empty piece of writing and a failed encode are things only the creator can fix. The route treats both the
 * same, because somebody is at the screen to read the answer. The scheduled sweep does not: it
 * keeps waiting on the first kind and gives the schedule up on the second, because a schedule
 * left standing on a condition the creator must fix would release a stale decision the moment
 * they happened to fix it.
 *
 * The rating is written before any of this is asked, by the route, so a refusal never costs a
 * creator the declaration they made in the same request. `PATCH /works/:id` carries that reasoning.
 */

import { db } from "@anthers/db/client";
import { transcodingJobs, type works } from "@anthers/db/schema";
import { isEmptyWriting, processingFor, workNeedsFile } from "@anthers/shared/content";
import {
	isRatingComplete,
	type MaturityRating,
	maturityLabel,
	releaseRatingRefusal,
} from "@anthers/shared/content-rating";
import { desc, inArray } from "drizzle-orm";
import { publishRefusal } from "./publish-refusal.js";
import { scanReleaseGate } from "./safety-scan.js";

type WorkRow = typeof works.$inferSelect;

/** Why a Work cannot be released yet, ready to send as a response or to put in a notice. */
export interface ReleaseRefusal {
	status: 403 | 409;
	body: { error: string; code: string } & Record<string, unknown>;
	/**
	 * `waiting` resolves without the creator doing anything — the file arriving, processing
	 * finishing, the scan answering. `creator` stays until the creator acts.
	 */
	resolves: "waiting" | "creator";
}

/**
 * Given Work ids, the ones whose latest transcoding job has not completed — still pending or
 * processing, or failed. A Work with no transcoding job never appears.
 *
 * This gates **release**, not publishing a post. Media readiness is a property of the media, and
 * the media belongs to the Work, so a post that merely links a Work has nothing to wait for.
 */
export async function unreadyWorks(
	workIds: number[],
): Promise<Array<{ workId: number; status: string }>> {
	if (workIds.length === 0) return [];
	const jobs = await db
		.select({
			workId: transcodingJobs.workId,
			status: transcodingJobs.status,
			createdAt: transcodingJobs.createdAt,
		})
		.from(transcodingJobs)
		.where(inArray(transcodingJobs.workId, workIds))
		.orderBy(desc(transcodingJobs.createdAt));
	const latest = new Map<number, string>();
	for (const j of jobs) if (!latest.has(j.workId)) latest.set(j.workId, j.status);
	const unready: Array<{ workId: number; status: string }> = [];
	for (const [workId, status] of latest)
		if (status !== "completed") unready.push({ workId, status });
	return unready;
}

/**
 * The first condition this Work fails on its way to being released, or null when it may go.
 * Reads the Work as stored, so a rating declared in the same request must already be written.
 */
export async function releaseRefusal(
	work: WorkRow,
	creator: { id: number; isCreator: boolean | null },
): Promise<ReleaseRefusal | null> {
	// 🚨 **The first condition, and the only one that is about the CREATOR rather than the Work.**
	// Releasing takes a fully set-up creator — creator mode, a permission Anthers can write their
	// listing with, and completed payout setup — and `publishRefusal` carries the reasons: the
	// listing is what makes the release reach the network at all, and payout setup is what makes
	// every creator here a verified adult and every released Work payable from the Time Pool.
	// First because it is the most fundamental, and all three are the creator's to fix.
	const standing = await publishRefusal(creator, "release");
	if (standing) return { ...standing, resolves: "creator" };

	// 🚨 **The file has to have arrived before its processing can be waited on.** The Studio
	// creates a Work the moment its file is picked and uploads into it afterwards, so a video with
	// no source is an upload in flight or one that never finished — and `unreadyWorks` reads only
	// transcoding jobs, which a Work with no file never has, so without this it would read as ready
	// and release as a page with nothing on it.
	if (workNeedsFile(work.type) && !work.sourceKey) {
		return {
			status: 409,
			body: {
				error: "Can't release yet — this Work's file hasn't finished uploading.",
				code: "media_missing",
			},
			resolves: "waiting",
		};
	}

	// The same for a piece of writing, which is its body the way a video is its file. Unlike a
	// file it is not on its way anywhere, so this is the creator's to fix rather than to wait for.
	if (work.type === "text" && isEmptyWriting(work.bodyHtml)) {
		return {
			status: 409,
			body: {
				error: "Can't release yet — this piece of writing is empty.",
				code: "text_missing",
			},
			resolves: "creator",
		};
	}

	// A Work whose file is processed asynchronously waits for the processing to finish.
	if (processingFor(work.type)) {
		const unready = await unreadyWorks([work.id]);
		if (unready.length > 0) {
			// ⚠️ A failed encode is unready too, and is not something to wait for: nothing will
			// finish it. It keeps the code a client already understands and says what happened.
			const failed = unready.some((u) => u.status === "failed");
			return {
				status: 409,
				body: {
					error: failed
						? "Processing this Work's media failed, so it can't be released."
						: "Can't release yet — the media is still processing.",
					code: "media_not_ready",
					unready,
				},
				resolves: failed ? "creator" : "waiting",
			};
		}
	}

	// The rating, and the only condition a creator can satisfy instantly. A Work is born `unrated`
	// and release is what makes it somebody else's business, so this is the moment to have asked.
	//
	// 🚨 **It asks two questions rather than one, and the second is not the same question later.**
	// Whether a rating has been *declared* is about the creator; whether the declared rung is one
	// Anthers currently *accepts* is about Anthers, and a Work can fail the second while answering
	// the first perfectly. The wiki's *Rating Standard* § Classifying a Work Is Not the Same as
	// Accepting It is why they are separate: a Work at a closed rung is rated correctly and refused,
	// rather than pushed into under-declaring one rung down.
	const rating = work.maturity as MaturityRating;
	const ratingRefusal = releaseRatingRefusal(rating);
	// 🚨 **Rated means every row answered, not a rating held** (Parker, 2026-09-18: *"you should
	// always have to rate them, no exceptions"*). A Work rated before the matrix existed, or given
	// a rating straight into the database, holds a value its rows cannot stand behind, so it is
	// refused as undeclared, which it is, with the same code as an unrated one because the fix is
	// the same one.
	if (ratingRefusal === "undeclared" || !isRatingComplete(work.maturityRows)) {
		return {
			status: 409,
			body: {
				error: "Answer every row of this Work's rating before releasing it.",
				code: "maturity_undeclared",
			},
			resolves: "creator",
		};
	}
	if (ratingRefusal === "closed") {
		const rung = maturityLabel(rating);
		return {
			status: 409,
			body: {
				// Names the rung, and says the rating is right rather than wrong. A creator who reads
				// this as an error to retry will lower the rating until it goes away, which is the one
				// outcome this refusal exists to prevent.
				error: `Anthers isn't accepting ${rung} work at the moment, so this Work can't be released. The rating is right and has been saved — you'll be able to release when ${rung} reopens.`,
				code: "maturity_rung_closed",
				rung: rating,
			},
			resolves: "creator",
		};
	}

	// Detection is a readiness condition of the same kind as processing: publishing is not gated on
	// encoding but release is gated on readiness, and an image whose scan has not come back is not
	// ready. It is checked here rather than on the queued job because release is the moment the
	// object becomes reachable by somebody other than its uploader.
	//
	// 🚨 **It gives way rather than blocking, and that is deliberate.** The window is two minutes
	// from when the scans were queued; past it the creator releases and the scan stays owed,
	// because a detection vendor's outage must not stop everyone on Anthers from publishing.
	// `services/safety-scan.ts` carries the full reasoning, including why quarantine reaching a
	// released Work is what makes the trade honest.
	const gate = await scanReleaseGate(work);
	if (gate.blocked) {
		return {
			status: 409,
			body: {
				error: "Almost — we're still checking this Work's images. Try again in a moment.",
				code: "scan_pending",
				// A count rather than the keys. A storage key is not the creator's business, and
				// neither is which of their objects we are still asking about.
				pending: gate.pending.length,
				retryAfter: gate.waitUntil?.toISOString() ?? null,
			},
			resolves: "waiting",
		};
	}

	return null;
}

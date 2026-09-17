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
 * rating and a failed encode are things only the creator can fix. The route treats both the
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
import { workNeedsFile } from "@anthers/shared/content";
import {
	type MaturityRating,
	maturityLabel,
	releaseRatingRefusal,
} from "@anthers/shared/content-rating";
import { desc, inArray } from "drizzle-orm";
import { publishRefusal } from "./payouts.js";
import { scanReleaseGate } from "./safety-scan.js";

type WorkRow = typeof works.$inferSelect;

/** Work types whose media is processed asynchronously before the Work can be released. */
const PROCESSED_WORK_TYPES = new Set(["video", "audio", "ebook"]);

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
	// Releasing takes a fully set-up creator — creator mode and completed payout setup — and
	// `publishRefusal` carries the reasons: it is what makes every creator here a verified adult,
	// since Stripe checks identity and Anthers deliberately checks nothing, and it means no
	// released Work is payout-ineligible, which matters because ungated work earns from the Time
	// Pool by the time people spend with it. First because it is the cheapest to evaluate and the
	// most fundamental.
	const payouts = await publishRefusal(creator, "release");
	if (payouts) return { ...payouts, resolves: "creator" };

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

	if (PROCESSED_WORK_TYPES.has(work.type)) {
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
	if (ratingRefusal === "undeclared") {
		return {
			status: 409,
			body: {
				error: "Say how this Work is rated before releasing it.",
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

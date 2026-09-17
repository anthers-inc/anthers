// SPDX-License-Identifier: Apache-2.0
/**
 * Release-scheduled sweep — releases every private Work whose scheduled release time has come
 * and which is ready to go.
 *
 * The golden path Parker described (2026-09-11) is to make the media, upload it and create the
 * Work, let it finish processing and scanning, and schedule the release. So a schedule is a time
 * **and** the conditions: this runs every minute and releases a due Work only once
 * `releaseRefusal` has nothing to say about it. A post's sweep, `publish-scheduled.ts`, publishes
 * on the clock alone, because a post has no media of its own to be ready; a Work is the one thing
 * on Anthers with conditions attached, so the shape is copied and the sweep is not.
 *
 * 🚨 **What happens to a due Work that cannot go depends on who can change that.**
 *
 * - **It waits** when the refusal resolves on its own — the file still uploading, the media still
 *   processing, the scan not yet answered. The schedule stays, and the Work goes out on the first
 *   minute after it is ready. A release that waited on processing is still the release the
 *   creator asked for.
 * - **The schedule is cleared and the creator is told** when only they can fix it — payout setup,
 *   a rating at a rung Anthers is not accepting, a failed encode. A schedule left in place would
 *   release a stale decision the moment they fixed it, perhaps weeks later, and a refusal nobody
 *   hears about is a release that silently did not happen. The notice is `essential`, because it
 *   is about their work rather than activity around it.
 *
 * A Work whose creator's account is gone has its schedule cleared with nobody to tell.
 *
 * ⚠️ **This is the only path that releases a Work without anybody making a request**, so it is
 * the one listing sync that cannot be inferred from a route — the same reason `publish-scheduled`
 * asks for its post's record itself.
 */

import { db } from "@anthers/db";
import { users, works } from "@anthers/db/schema";
import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { notify } from "../services/notifications.js";
import { queueWorkListingSync } from "../services/work-listing.js";
import { releaseRefusal } from "../services/work-release.js";

export interface ReleaseScheduledResult {
	released: number;
	/** Schedules given up because only the creator can clear what stopped them. */
	cleared: number;
	/** Due Works still waiting on their file, processing or scan. */
	waiting: number;
}

/** Release every due scheduled Work that is ready, and settle the ones that cannot go. */
export async function releaseScheduled(now: Date = new Date()): Promise<ReleaseScheduledResult> {
	const result: ReleaseScheduledResult = { released: 0, cleared: 0, waiting: 0 };
	const due = await db
		.select({ work: works, isCreator: users.isCreator })
		.from(works)
		.leftJoin(users, eq(works.creatorId, users.id))
		.where(
			and(
				isNotNull(works.scheduledReleaseAt),
				lte(works.scheduledReleaseAt, now),
				eq(works.visibility, "private"),
				// A quarantined Work is under a preservation hold, and nothing about it moves.
				ne(works.quarantineStatus, "quarantined"),
			),
		);

	for (const { work, isCreator } of due) {
		const scheduledFor = work.scheduledReleaseAt as Date;

		if (work.creatorId === null) {
			await clearSchedule(work.id, scheduledFor, now);
			result.cleared += 1;
			continue;
		}

		const refusal = await releaseRefusal(work, { id: work.creatorId, isCreator });
		if (refusal?.resolves === "waiting") {
			result.waiting += 1;
			continue;
		}

		if (refusal) {
			// Only if the schedule is still the one this sweep read, so a creator who rescheduled
			// in the meantime is neither cleared nor told about a release they already moved.
			if (!(await clearSchedule(work.id, scheduledFor, now))) continue;
			result.cleared += 1;
			console.log(
				`[release-scheduled] Cleared the schedule on Work ${work.id}: ${refusal.body.code}`,
			);
			await notify({
				userId: work.creatorId,
				category: "essential",
				kind: "scheduled_release_refused",
				title: `“${work.title || "Your Work"}” wasn't released as scheduled`,
				body: `${refusal.body.error} The schedule has been cleared, so nothing goes out until you release or schedule it again.`,
				linkPath: `/studio/works/${work.publicId}/edit`,
				// Per schedule rather than per Work: rescheduling and being refused again is news.
				dedupeKey: `scheduled-release-refused:${work.id}:${scheduledFor.toISOString()}`,
			});
			continue;
		}

		const [released] = await db
			.update(works)
			.set({
				visibility: "released",
				// Stamped on the first release only, exactly as the route stamps it.
				releasedAt: work.releasedAt ?? now,
				scheduledReleaseAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(works.id, work.id),
					eq(works.visibility, "private"),
					eq(works.scheduledReleaseAt, scheduledFor),
				),
			)
			.returning({ id: works.id });
		if (!released) continue;
		result.released += 1;
		await queueWorkListingSync(work.id);
		console.log(`[release-scheduled] Released Work ${work.id} (${work.slug})`);
	}

	return result;
}

/** Clear a schedule if it is still the one read. True when it was cleared. */
async function clearSchedule(workId: number, scheduledFor: Date, now: Date): Promise<boolean> {
	const cleared = await db
		.update(works)
		.set({ scheduledReleaseAt: null, updatedAt: now })
		.where(and(eq(works.id, workId), eq(works.scheduledReleaseAt, scheduledFor)))
		.returning({ id: works.id });
	return cleared.length > 0;
}

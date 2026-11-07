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
 * asks for its post's record itself. The same goes for the credit-offered notification: credits
 * saved while the Work was private have told nobody, and this release is their first public
 * moment.
 */

import { db } from "@anthers/db";
import { users, works } from "@anthers/db/schema";
import { and, eq, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import { notifyCreditedAccounts } from "../services/credit-acceptance.js";
import { syncAccountRoles } from "../services/discord.js";
import { notify } from "../services/notifications.js";
import { queueWorkListingSync } from "../services/work-listing.js";
import { preReleaseRefusal, releaseRefusal } from "../services/work-release.js";

export interface ReleaseScheduledResult {
	released: number;
	/** Schedules given up because only the creator can clear what stopped them. */
	cleared: number;
	/** Due Works still waiting on their file, processing or scan. */
	waiting: number;
	/** Pre-release pages whose listing was queued by this run. */
	preReleased: number;
}

/**
 * Queue the public listing for every Work whose pre-release date has arrived.
 *
 * ⭐ **The page is public without this; the listing is what this adds.** `isPreRelease`
 * derives the page state from the date, so a reader can already reach it. This sweep writes
 * the network record at the moment the page opens, which is the half of pre-release that
 * reaches an audience beyond Anthers.
 *
 * The media is deliberately not a condition (`preReleaseRefusal` says why); the creator's
 * standing, the rating, the credits and a title are. A refusal leaves the date in place and
 * tells the creator once — the page simply stays private until they fix it, rather than the
 * schedule being thrown away.
 */
async function publishDuePreReleases(now: Date): Promise<number> {
	const retryBefore = new Date(now.getTime() - 15 * 60_000);
	const due = await db
		.select({ work: works, creatorMode: users.creatorMode })
		.from(works)
		.leftJoin(users, eq(works.creatorId, users.id))
		.where(
			and(
				isNotNull(works.preReleaseAt),
				lte(works.preReleaseAt, now),
				eq(works.visibility, "private"),
				isNull(works.releasedAt),
				ne(works.quarantineStatus, "quarantined"),
				// The record's existence is the success signal. A failed sync is retried on
				// the throttle rather than on every tick, so a broken vendor cannot turn the
				// minute sweep into a queue full of duplicates.
				isNull(works.atprotoUri),
				or(isNull(works.preReleaseQueuedAt), lt(works.preReleaseQueuedAt, retryBefore)),
			),
		);

	let published = 0;
	for (const { work, creatorMode } of due) {
		const preReleaseAt = work.preReleaseAt as Date;
		if (work.creatorId === null) {
			await db
				.update(works)
				.set({ preReleaseAt: null, preReleaseQueuedAt: null, updatedAt: now })
				.where(eq(works.id, work.id));
			continue;
		}
		const refusal = await preReleaseRefusal(work, { id: work.creatorId, creatorMode });
		if (refusal) {
			console.log(
				`[release-scheduled] Pre-release of Work ${work.id} is not ready: ${refusal.body.code}`,
			);
			await notify({
				userId: work.creatorId,
				category: "essential",
				kind: "pre_release_refused",
				title: `“${work.title || "Your Work"}” hasn't opened its pre-release page`,
				body: `${refusal.body.error} The page stays private until this is fixed; the pre-release date is still set.`,
				linkPath: `/studio/works/${work.publicId}/edit`,
				// Per pre-release date rather than per Work: moving the date and being refused
				// again is news; the minute sweep retrying is not.
				dedupeKey: `pre-release-refused:${work.id}:${preReleaseAt.toISOString()}`,
			});
			continue;
		}
		const [queued] = await db
			.update(works)
			.set({ preReleaseQueuedAt: now, updatedAt: now })
			.where(and(eq(works.id, work.id), eq(works.preReleaseAt, preReleaseAt)))
			.returning({ id: works.id });
		if (!queued) continue;
		await queueWorkListingSync(work.id);
		published += 1;
	}
	return published;
}

/** Release every due scheduled Work that is ready, and settle the ones that cannot go. */
export async function releaseScheduled(now: Date = new Date()): Promise<ReleaseScheduledResult> {
	const result: ReleaseScheduledResult = { released: 0, cleared: 0, waiting: 0, preReleased: 0 };
	// The same minute sweep opens pre-release pages, because both are clock-driven public
	// transitions on a Work and a second timer would be a second thing to keep in step.
	result.preReleased = await publishDuePreReleases(now);
	const due = await db
		.select({ work: works, creatorMode: users.creatorMode })
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

	for (const { work, creatorMode } of due) {
		const scheduledFor = work.scheduledReleaseAt as Date;

		if (work.creatorId === null) {
			await clearSchedule(work.id, scheduledFor, now);
			result.cleared += 1;
			continue;
		}

		const refusal = await releaseRefusal(work, { id: work.creatorId, creatorMode });
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
		// The release the nobody-attended path makes public is the release the credited are
		// told about — credits saved while private notify here and nowhere else. Re-read the
		// row: `work` above is the pre-release read, and the notification's title and link
		// should carry what a released Work actually says.
		const [current] = await db.select().from(works).where(eq(works.id, work.id)).limit(1);
		if (current) await notifyCreditedAccounts(current, current.creatorId ?? work.creatorId);
		// The sweep is the second door a Work reaches the public by, so it owes the same
		// Discord grant the route does — on a first release only, which the pre-release row
		// already answers.
		if (!work.releasedAt && work.creatorId) {
			try {
				await syncAccountRoles(work.creatorId);
			} catch (error) {
				console.error("[discord] role sync after a scheduled release failed", error);
			}
		}
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

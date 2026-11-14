// SPDX-License-Identifier: Apache-2.0
/**
 * Move a Work's publisher role, and the network record that lives in the publisher's
 * repository, in the one order that cannot leave a second public listing behind.
 *
 * 🚨 **The old record is removed with the OLD publisher's writer, before `works.creatorId`
 * changes.** `syncWorkListing` deletes a record by the URI on the row, using the row's
 * current creator — so after the move it would ask the new publisher's repository to delete
 * a record that lives in the old one, which fails and leaves the old listing public. The
 * handover therefore removes the published record (and the creator-space records) first,
 * clears the four URI columns, then moves the row, and lets the ordinary listing sync create
 * everything again as the new publisher.
 *
 * Storage does not move: Work media is under `works/{workId}/`, which is the Work's own
 * namespace. That is the reason the handover is a row and a record rather than a copy.
 *
 * ⚠️ **The network step is best-effort and the row move is not.** A publisher without a
 * live publishing grant cannot have their record deleted; the move still happens, the
 * failure is logged, and the next sync with the new publisher creates the new record. The
 * old one is a stale public listing rather than a broken Work, which is the recoverable
 * direction; refusing the move would trap the Work on an account that cannot publish.
 */
import { db } from "@anthers/db/client";
import { workCollaborators, works } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { workBaseUrl } from "./atproto-records.js";
import { syncWorkRecord, WORK_COLLECTION } from "./atproto-repo.js";
import { removeCreatorSpace } from "./creator-space.js";
import { writerForAccount } from "./repo-writer.js";
import { queueWorkListingSync } from "./work-listing.js";

/**
 * Delete a Work's published record with its publisher's own writer.
 *
 * The caller uses this before the row is deleted or moved. Best-effort and logged: a
 * publisher without a live grant cannot have the record removed, and that is a stale
 * public listing rather than a reason to refuse the Work's own delete.
 */
export async function removeWorkListing(work: typeof works.$inferSelect): Promise<void> {
	if (!work.atprotoUri || work.creatorId == null) return;
	try {
		const opened = await writerForAccount(work.creatorId, { collections: [WORK_COLLECTION] });
		if (!opened.writer) return;
		await syncWorkRecord(
			opened.writer,
			{ ...work, visibility: "private", preReleaseAt: null, scheduledReleaseAt: null },
			{ baseUrl: workBaseUrl(), existingUri: work.atprotoUri },
		);
	} catch (error) {
		console.error(`[work-publisher] could not remove the listing for Work ${work.id}:`, error);
	}
}

/**
 * Move the publisher from `fromCreatorId` to `toCreatorId`.
 *
 * `keepOldPublisher` is the difference between a handover (the old publisher stays an
 * accepted owner) and a departure (they leave entirely). The target's accepted row always
 * goes, because the anchor now carries that fact; the old publisher's row is written only
 * when they stay.
 */
export async function moveWorkPublisher(
	workId: number,
	fromCreatorId: number,
	toCreatorId: number,
	opts: { keepOldPublisher: boolean },
): Promise<void> {
	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	if (!work) throw new Error(`Work ${workId} not found`);
	if (work.creatorId !== fromCreatorId) {
		throw new Error(`Work ${workId} is not published by creator ${fromCreatorId}`);
	}

	// 1. Remove the old listing with the old publisher's own writer.
	await removeWorkListing(work);

	// 2. The creator-space records are written as the old publisher too. Remove them before
	// the identity moves; the sync after the move recreates them in the new repository.
	await removeCreatorSpace(work).catch((error) => {
		console.error(
			`[work-publisher] could not remove the old creator space for Work ${workId}:`,
			error,
		);
	});

	// 3. The row move, and the two owner-set halves in one transaction.
	await db.transaction(async (tx) => {
		await tx
			.update(works)
			.set({
				creatorId: toCreatorId,
				atprotoUri: null,
				draftUri: null,
				gatedSpaceUri: null,
				manifestUri: null,
				updatedAt: new Date(),
			})
			.where(eq(works.id, workId));
		await tx
			.delete(workCollaborators)
			.where(
				and(eq(workCollaborators.workId, workId), eq(workCollaborators.creatorId, toCreatorId)),
			);
		if (opts.keepOldPublisher) {
			await tx
				.insert(workCollaborators)
				.values({
					workId,
					creatorId: fromCreatorId,
					status: "accepted",
					invitedById: toCreatorId,
					respondedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: [workCollaborators.workId, workCollaborators.creatorId],
					set: { status: "accepted", respondedAt: new Date() },
				});
		}
	});

	// 4. The ordinary sync writes the new record and creator-space as the new publisher.
	await queueWorkListingSync(workId);
}

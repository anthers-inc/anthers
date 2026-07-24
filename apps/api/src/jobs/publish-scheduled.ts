// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Publish-scheduled sweep — auto-publishes drafts whose scheduled publish time has arrived.
 *
 * A scheduled post is a draft (`isPublished = false`) with `scheduledFor` set; the creator
 * can edit or clear that date without deleting the draft. This sweep runs every minute via
 * the worker cron: any due draft is published — but only if its referenced media is ready,
 * the same hard-block gate as a manual publish. A post whose media is still transcoding is
 * left scheduled and picked up on a later sweep once the transcode completes.
 */
import { db } from "@anthers/db";
import { postContents, posts, transcodingJobs } from "@anthers/db/schema";
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";

/** Content-item IDs whose latest transcoding job hasn't reached "completed". */
async function unreadyItemSet(itemIds: number[]): Promise<Set<number>> {
	if (itemIds.length === 0) return new Set();
	const jobs = await db
		.select({
			itemId: transcodingJobs.contentItemId,
			status: transcodingJobs.status,
			createdAt: transcodingJobs.createdAt,
		})
		.from(transcodingJobs)
		.where(inArray(transcodingJobs.contentItemId, itemIds))
		.orderBy(desc(transcodingJobs.createdAt));
	const latest = new Map<number, string>();
	for (const j of jobs) if (!latest.has(j.itemId)) latest.set(j.itemId, j.status);
	const unready = new Set<number>();
	for (const [itemId, status] of latest) if (status !== "completed") unready.add(itemId);
	return unready;
}

/** Publish every due scheduled draft whose media is ready. Returns how many were published. */
export async function publishScheduled(now: Date = new Date()): Promise<number> {
	const due = await db
		.select({ id: posts.id, slug: posts.slug })
		.from(posts)
		.where(
			and(
				eq(posts.isPublished, false),
				isNotNull(posts.scheduledFor),
				lte(posts.scheduledFor, now),
			),
		);
	if (due.length === 0) return 0;

	let published = 0;
	for (const post of due) {
		const refs = await db
			.select({ itemId: postContents.contentItemId })
			.from(postContents)
			.where(and(eq(postContents.postId, post.id), eq(postContents.kind, "content")));
		const itemIds = [...new Set(refs.map((r) => r.itemId).filter((x): x is number => x != null))];
		const unready = await unreadyItemSet(itemIds);
		if (unready.size > 0) {
			console.log(
				`[publish-scheduled] Deferring post ${post.id} — ${unready.size} referenced item(s) still processing`,
			);
			continue;
		}
		await db
			.update(posts)
			.set({ isPublished: true, scheduledFor: null, updatedAt: now })
			.where(eq(posts.id, post.id));
		published += 1;
		console.log(`[publish-scheduled] Published post ${post.id} (${post.slug})`);
	}
	return published;
}

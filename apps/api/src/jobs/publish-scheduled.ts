// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Publish-scheduled sweep — auto-publishes drafts whose scheduled publish time has arrived.
 *
 * A scheduled post is a draft (`isPublished = false`) with `scheduledFor` set; the creator
 * can edit or clear that date without deleting the draft. This sweep runs every minute via
 * the worker cron and publishes every due draft.
 *
 * It used to defer a post whose referenced media was still transcoding, mirroring the
 * hard-block on manual publish. That check is gone from both: readiness is a property of
 * the media, the media belongs to a **Work**, and a post only *links* Works — so there was
 * never anything for the post itself to wait for. The readiness gate now sits on releasing
 * a Work, which is where the media actually is. A post may go live announcing a Work that
 * is still encoding, exactly as it may link one the reader cannot open.
 */
import { db } from "@anthers/db";
import { posts } from "@anthers/db/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";

/** Publish every due scheduled draft. Returns how many were published. */
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
		await db
			.update(posts)
			.set({
				isPublished: true,
				// The whole reason `publishedAt` exists: this sweep used to publish without
				// recording when, leaving the post sorted by the day its draft row was written.
				publishedAt: now,
				scheduledFor: null,
				updatedAt: now,
			})
			.where(eq(posts.id, post.id));
		published += 1;
		console.log(`[publish-scheduled] Published post ${post.id} (${post.slug})`);
	}
	return published;
}

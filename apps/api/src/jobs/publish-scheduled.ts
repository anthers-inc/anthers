// SPDX-License-Identifier: Apache-2.0
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
 * is still encoding, exactly as it may link one the user cannot open.
 *
 * 🚨 **Only a fully set-up creator's draft goes live** — creator mode, a permission Anthers can
 * write their records with, and completed payout setup, the rule `publishRefusal` holds for
 * every publish. This is the one path that
 * publishes with nobody making a request, so the route's check cannot cover it: a creator can
 * schedule while set up and lose it before the date. A draft whose author is no longer set up
 * — or whose account is gone, leaving `creator_id` null — has its schedule cleared rather than
 * kept, because a schedule left in place would publish a stale draft the moment the author was
 * set up again.
 *
 * ⚠️ **Clearing a schedule is told to the author, not just logged.** A scheduled post is a
 * decision somebody made about their own writing, and a refusal nobody hears about is a post
 * that silently never went out. `release-scheduled.ts` carries the same reasoning for Works and
 * sends the same notice; this sweep is the post half of it.
 */
import { db } from "@anthers/db";
import { posts, users } from "@anthers/db/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { notify } from "../services/notifications.js";
import { publishRefusal } from "../services/publish-refusal.js";
import { queueRecordSync } from "../services/record-sync.js";

/** Publish every due scheduled draft. Returns how many were published. */
export async function publishScheduled(now: Date = new Date()): Promise<number> {
	const due = await db
		.select({
			id: posts.id,
			slug: posts.slug,
			title: posts.title,
			scheduledFor: posts.scheduledFor,
			creatorId: posts.creatorId,
			creatorMode: users.creatorMode,
		})
		.from(posts)
		.leftJoin(users, eq(posts.creatorId, users.id))
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
		const refusal =
			post.creatorId === null
				? null
				: await publishRefusal({ id: post.creatorId, creatorMode: post.creatorMode }, "publish");
		if (post.creatorId === null || refusal) {
			await db
				.update(posts)
				.set({ scheduledFor: null, updatedAt: now })
				.where(eq(posts.id, post.id));
			console.log(
				`[publish-scheduled] Cleared the schedule on post ${post.id}: ` +
					`${refusal?.body.code ?? "no author"}`,
			);
			// A post whose author is gone has nobody to tell. A creator whose setup lapsed is
			// told what refused them and where the fix is, so the draft is not silently dropped.
			if (post.creatorId !== null && refusal && post.scheduledFor) {
				await notify({
					userId: post.creatorId,
					category: "essential",
					kind: "scheduled_publish_refused",
					title: `“${post.title || "Your post"}” wasn't published as scheduled`,
					body: `${refusal.body.error} The schedule has been cleared, so nothing goes out until you publish or schedule it again.`,
					linkPath: `/studio/posts/${post.slug}/edit`,
					// Per schedule rather than per post: rescheduling and being refused again is news.
					dedupeKey: `scheduled-publish-refused:${post.id}:${post.scheduledFor.toISOString()}`,
				});
			}
			continue;
		}
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
		// ⚠️ **The only path that publishes a post without anybody making a request**, so it is
		// the one enqueue that cannot be inferred from a route. A scheduled post whose record was
		// never asked for would sit published on Anthers and absent from the network until its
		// creator happened to edit it.
		await queueRecordSync("post", post.id);
		console.log(`[publish-scheduled] Published post ${post.id} (${post.slug})`);
	}
	return published;
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Activity emitters — the `notify` calls for the social surface: replies, comments, reviews
 * and follows.
 *
 * 🚨 **A notification is a place two users meet**, and every emitter here says the check
 * it ran rather than trusting its caller to have run it. The comment and reply paths are
 * already guarded at the write boundary (`replyRefusal` in `routes/content.ts` refuses a
 * reply from a blocked pair, and a fresh comment's author is its own writer), so those
 * emitters assert the invariant with a comment rather than a second query; the follower
 * emitter re-checks `isBlocked` itself, because the follow route's own guard has a
 * different job (refusing the follow to the ACTOR, 404) and the notification goes to the
 * person being followed.
 *
 * ⭐ **Every social kind is also `notify`'s per-group delivery map customer**
 * (`services/notifications.ts`): `category: "activity"` and the kind names the group
 * whose app/email/both mode applies. None of that lives here.
 *
 * ⚠️ **The emitters await; the routes catch.** A posted reply awaiting its notification is
 * two milliseconds of insert — and "fire-and-forget" would let a process edge between the
 * response and the insert drop the row entirely (credit-acceptance's comment is the
 * precedent: the awaits are so a request cannot outlive its notifications). The failure
 * shape is the route's `.catch(() => {})`: the comment stands, the announcement may have
 * failed, and a posted comment must never 500 because a notification hiccuped.
 *
 * The copy lives beside its own emitter, where the decision it encodes sits visible. A
 * second copy table would be that table drifting from the code that decides it.
 */

import type { posts, works } from "@anthers/db/schema";
import { isBlocked } from "./blocks.js";
import { notify } from "./notifications.js";

/** The URL-shape inputs. Built inline, matching the API's no-web-shared rule — see credit-acceptance.ts. */
interface PostRef {
	slug: string;
	publicId: number;
}

/**
 * Somebody replied to your comment.
 *
 * The caller has already refused every reply a blocked pair could write (`replyRefusal`
 * walks the ancestry and demands no block against ANY comment's author), so the block
 * check the module note demands is already held — re-running it here would be a second
 * query agreeing with the route's refusal, at a cost per reply for no answer it cannot
 * already trust. Self-replies are skipped here, not at the route: the route permits
 * replying to your own comment (a note-in-the-thread is a legitimate reply), and a
 * notification announcing your own words back to you is noise and nothing else.
 */
export async function notifyReply(input: {
	/** The reply's author. */
	replierId: number;
	/** The comment the reply answers. */
	parentId: number;
	/** The parent's author, already read by the caller's ancestry walk. */
	parentAuthorId: number;
	/** The post everything sits under, for the link. */
	post: PostRef;
}): Promise<void> {
	if (input.parentAuthorId === input.replierId) return;
	await notify({
		userId: input.parentAuthorId,
		category: "activity",
		kind: "comment_reply",
		title: "Somebody replied to your comment",
		body: "See the reply under your comment.",
		linkPath: `/posts/${input.post.slug}-${input.post.publicId}#comment-${input.parentId}`,
		dedupeKey: `comment-reply:${input.replierId}:${input.parentId}`,
	});
}

// ─── Not used yet, ordered here so the next kind is a copy not a design ─────────

/**
 * Somebody commented on your post.
 *
 * The author of the post is `null` when their account was deleted (the tombstone rule),
 * which stops the emit: there is nobody to tell.
 */
export async function notifyPostComment(input: {
	/** The comment's author. */
	commenterId: number;
	/** The post's own row, as the route already holds it. */
	post: typeof posts.$inferSelect;
}): Promise<void> {
	// A tombstoned post's creatorId is null (set null on account deletion) — nobody to tell.
	const creatorId = input.post.creatorId;
	if (creatorId == null || creatorId === input.commenterId) return;
	if (await isBlocked(input.commenterId, creatorId)) return;
	await notify({
		userId: creatorId,
		category: "activity",
		kind: "post_comment",
		title: "New comment on your post",
		body: input.post.title ? `On “${input.post.title}”.` : "",
		linkPath: `/posts/${input.post.slug}-${input.post.publicId}#comments`,
		dedupeKey: `post-comment:${input.commenterId}:${input.post.id}`,
	});
}

/**
 * Somebody reviewed a Work of yours.
 *
 * ⭐ **The emit rides the INSERT branch only.** A re-review (the edit path lands on the
 * same `onConflictDoUpdate` upsert) must not re-notify — the creator was told the first
 * time, and a second email about the same review's edit is the noise the dedupe key
 * exists to stop. The route decides which branch it took and passes `isNew`.
 */
export async function notifyReview(input: {
	/** The reviewer. */
	reviewerId: number;
	/** The Work's creator — resolved here, since the route holds only the Work row. */
	work: typeof works.$inferSelect;
	/** True when this was the first review by this person on this Work, not an edit. */
	isNew: boolean;
}): Promise<void> {
	if (!input.isNew) return;
	// A withdrawn creator's Work carries a null creatorId — nobody to tell.
	const creatorId = input.work.creatorId;
	if (creatorId == null || creatorId === input.reviewerId) return;
	if (await isBlocked(input.reviewerId, creatorId)) return;
	// The Work row already carries title and publicId; its slug follows the same
	// slug-publicId URL shape a post's does.
	const work = input.work;
	await notify({
		userId: creatorId,
		category: "activity",
		kind: "work_review",
		title: "New review of your Work",
		body: work.title ? `On “${work.title}”.` : "",
		linkPath: `/works/${work.slug}-${work.publicId}#reviews`,
		dedupeKey: `work-review:${input.reviewerId}:${work.id}`,
	});
}

/**
 * Somebody followed you.
 *
 * 🚨 **The unfollow does NOT emit** — "you lost a follower" is exactly the notification
 * nobody asked for — and neither does the refollow of an existing pair (the route's
 * insert is `onConflictDoNothing`, so the dedupe key on the FOLLOW ID is what keeps the
 * second attempt silent anyway; the caller passes the id it read back, which a refollow
 * shares with the original, so even a delete-then-refollow cycle within the row's life
 * cannot re-mail — a refollow writes a NEW row, which does re-notify, and that is honest:
 * the person did something, again).
 */
export async function notifyFollow(input: {
	/** The person who followed. */
	followerId: number;
	/** The account followed. */
	followedId: number;
	/** The follower's handle, for the copy — read by the route already. */
	followerHandle: string;
}): Promise<void> {
	if (input.followerId === input.followedId) return;
	if (await isBlocked(input.followerId, input.followedId)) return;
	const name = input.followerHandle;
	await notify({
		userId: input.followedId,
		category: "activity",
		kind: "new_follower",
		title: "You have a new follower",
		body: name ? `${name} now follows you.` : "",
		linkPath: name ? `/${name}` : "",
		dedupeKey: `new-follower:${input.followerId}:${input.followedId}`,
	});
}

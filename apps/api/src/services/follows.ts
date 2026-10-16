// SPDX-License-Identifier: Apache-2.0
/**
 * The one writer of the `follows` table.
 *
 * A follow arrives through two doors and must carry the same ceremony through both: the
 * explicit `POST /users/:handle/follow`, and the automatic consequence of an act the
 * account already chose — **subscribing to a creator's Badge follows the creator**
 * (Parker, 2026-10-11), which is the mirror of purchasing a Work saving it
 * (`saveOnPurchase` in `services/library.ts`). The Badge holding is written by the
 * webhook's `applyDirectedSupport`, which calls into here, so the ceremony (block
 * refusal, repository permission, record sync, the new-follower notification) has one
 * automatic door and cannot diverge between it and the explicit route.
 *
 * 🚨 **Every refused case is silent to the automatic doors.** Money and access are the
 * pick's own consequence; the follow rides along when it can. A pair with a block
 * between them, and an account whose repository permission has lapsed, simply gain no
 * follow — the pick still succeeds, because the pick is what the account did. The
 * explicit route maps the statuses itself: it is the one caller that *tells* the
 * person why.
 *
 * ⭐ **A subscription cancellation never unfollows.** The purchase→save precedent is
 * that saving survives the act that caused it, and the same holds here: unfollowing is
 * always and only the account's own explicit act (`POST /users/:handle/unfollow`),
 * never refused, never automatic. A lapsed card silently severing a creator
 * relationship is the surprise this refuses to manufacture. `subscribe-follow.test.ts`
 * carries the absence as a test, not just as this comment.
 *
 * Suspension is deliberately not a case: a suspension keeps the follow and ends the
 * feed, filtered at the read (`routes/accounts.ts`'s `/me/feed`), the same way an
 * explicit follow behaves.
 */

import { db } from "@anthers/db/client";
import { follows, users } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { notifyFollow } from "./activity-notify.js";
import { type InteractionPermissionRefusal, interactionPermissionRefusal } from "./atproto.js";
import { isBlocked } from "./blocks.js";
import { queueRecordSync } from "./record-sync.js";

export type FollowOutcome =
	| { ok: true; created: boolean }
	| { ok: false; reason: "self" | "blocked" }
	| { ok: false; reason: "permission"; refusal: InteractionPermissionRefusal };

/**
 * Make sure this account follows that creator.
 *
 * Idempotent: a follow that already exists is a no-op that still verifies the record and
 * leaves the notification silent, exactly as the route behaved. A *new* follow queues
 * the record sync and notifies the creator; the emitter's block check and the
 * notification's own dedupe key sit behind it unchanged.
 */
export async function ensureFollow(followerId: number, creatorId: number): Promise<FollowOutcome> {
	if (followerId === creatorId) return { ok: false, reason: "self" };

	// A block refuses the follow in both directions. The explicit route answers 404 —
	// matching what the profile page said a moment earlier — and the automatic doors
	// treat it as simply not their business.
	if (await isBlocked(followerId, creatorId)) return { ok: false, reason: "blocked" };

	// A follow is a record in the follower's own repository. An account whose permission
	// has lapsed keeps what it can read and stops creating — "accepting one Anthers
	// cannot write" is the outcome `interactionPermissionRefusal` exists to prevent, and
	// an automatic follow has no banner to point at, so it stops here too.
	const unwritable = await interactionPermissionRefusal(followerId);
	if (unwritable) return { ok: false, reason: "permission", refusal: unwritable };

	const inserted = await db
		.insert(follows)
		.values({ followerId, creatorId })
		.onConflictDoNothing()
		.returning({ id: follows.id });

	// Read back rather than taken from the insert, which returns nothing on the idempotent
	// branch — a repeated follow is still a reason to make sure the record exists.
	const [follow] =
		inserted.length > 0
			? inserted
			: await db
					.select({ id: follows.id })
					.from(follows)
					.where(and(eq(follows.followerId, followerId), eq(follows.creatorId, creatorId)))
					.limit(1);
	if (follow) void queueRecordSync("follow", follow.id);

	if (inserted.length > 0) {
		const [follower] = await db
			.select({ handle: users.atprotoHandle })
			.from(users)
			.where(eq(users.id, followerId))
			.limit(1);
		// A NEW follow tells the person they were followed; a repeated one stays
		// silent — the dedupe key on the follow id would catch it anyway, but the
		// branch is free and says the intent. Best-effort, as the route had it.
		await notifyFollow({
			followerId,
			followedId: creatorId,
			followerHandle: follower?.handle ?? "",
		}).catch(() => {});
	}

	return { ok: true, created: inserted.length > 0 };
}

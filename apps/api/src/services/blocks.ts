// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Blocking — one user's decision that they and another user should not meet.
 *
 * **This is not moderation, and the separation is the point.** A block is a personal
 * boundary; a hide is an operator's judgment. Conflating them would give a private
 * decision a review queue, a reason code and an appeal — none of which a boundary
 * should ever have to survive. That is why this module exists beside
 * `services/moderation.ts` rather than inside it, why `user_blocks` sits next to
 * `follows` in the auth schema, and why nothing here writes to `moderation_actions`.
 *
 * Three properties hold together, and dropping any one of them makes the feature a
 * pretense:
 *
 * 1. **Enforcement is symmetric.** The row is directed so an unblock knows whose
 *    decision it was, but every read asks whether a row exists in *either*
 *    direction. A one-way block would protect the blocker's view while leaving
 *    their exposure intact, which is the wrong half for the contact risk this
 *    exists to answer.
 *
 * 2. **Blocking deletes the follow, both ways, in the same transaction.** A follow
 *    that outlives the block keeps delivering the blocker's releases to the person
 *    they just cut off.
 *
 * 3. **The block is never announced, and we do not claim it is concealed.** Nothing
 *    here returns "you have been blocked", and no endpoint reports who blocked whom.
 *    A blocked viewer gets the same 404 a nonexistent user gets, which is the least
 *    informative answer available. Complete concealment is not achievable — a
 *    determined blocked user can infer a block from the disappearance — and
 *    asserting it would be a protection claimed rather than held.
 *
 * What a block deliberately does NOT do is filter content. Works, posts and projects
 * by a blocked creator stay in the Catalog, in Discover and in browse. Hiding
 * someone's published work is a *mute* — a different feature — and doing it here
 * would let one user's private decision produce a listing removal, which is a
 * moderation-shaped outcome. The decisive case is that a purchase outlives
 * everything: a buyer who later blocks a creator still owns what they bought, so a
 * content-filtering block would need a Library carve-out, and the carve-out is the
 * proof that content was never the axis.
 */

import { db } from "@anthers/db/client";
import { follows, userBlocks, users } from "@anthers/db/schema";
import { and, eq, or, type SQL, sql } from "drizzle-orm";

/**
 * Is either user blocking the other?
 *
 * Reads both directions on purpose — see property 1 in the module note. Callers use
 * this for single-subject reads (a profile, a follow); list reads use
 * `blockedUserIds` or `notBlockedBy` so they stay one query.
 */
export async function isBlocked(a: number, b: number): Promise<boolean> {
	if (a === b) return false;
	const [row] = await db
		.select({ id: userBlocks.id })
		.from(userBlocks)
		.where(
			or(
				and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
				and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
			),
		)
		.limit(1);
	return !!row;
}

/**
 * Every user id `viewer` cannot meet — those they blocked and those who blocked them,
 * as one set.
 *
 * For list surfaces that already hold their rows in memory (the creator listing, the
 * comment thread). `notBlockedBy` is the SQL-side equivalent for queries that filter
 * before a LIMIT.
 */
export async function blockedUserIds(viewer: number | null): Promise<Set<number>> {
	if (viewer == null) return new Set();
	const rows = await db
		.select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
		.from(userBlocks)
		.where(or(eq(userBlocks.blockerId, viewer), eq(userBlocks.blockedId, viewer)));
	const out = new Set<number>();
	for (const r of rows) out.add(r.blockerId === viewer ? r.blockedId : r.blockerId);
	return out;
}

/**
 * A SQL predicate excluding rows whose `userColumn` names anyone `viewer` cannot meet.
 *
 * Returns `undefined` for a signed-out viewer so callers can drop it into an `and()`
 * without branching — there is no block relationship to enforce without an identity.
 * Written as a NOT EXISTS over both directions rather than a fetched id list so the
 * filter applies *before* any LIMIT: filtering a page after the fact silently returns
 * short pages, which is the same defect the moderation queue's orphan filter had.
 */
export function notBlockedBy(viewer: number | null, userColumn: SQL | unknown): SQL | undefined {
	if (viewer == null) return undefined;
	return sql`NOT EXISTS (
		SELECT 1 FROM user_blocks ub
		WHERE (ub.blocker_id = ${viewer} AND ub.blocked_id = ${userColumn})
		   OR (ub.blocked_id = ${viewer} AND ub.blocker_id = ${userColumn})
	)`;
}

/**
 * Block someone. Idempotent, and it takes the follows with it.
 *
 * Both writes are one transaction for the same reason `hideSubject`'s are: a block
 * that exists while the follow it was supposed to sever is still delivering content
 * is precisely the state this prevents.
 */
export async function blockUser(
	blockerId: number,
	blockedId: number,
): Promise<{ blocked: true } | { error: "self" }> {
	if (blockerId === blockedId) return { error: "self" };

	await db.transaction(async (tx) => {
		await tx.insert(userBlocks).values({ blockerId, blockedId }).onConflictDoNothing();

		// Both directions. Following is not symmetric, so there can be a row each way and
		// removing only the blocker's own would leave the blocked party subscribed.
		await tx
			.delete(follows)
			.where(
				or(
					and(eq(follows.followerId, blockerId), eq(follows.creatorId, blockedId)),
					and(eq(follows.followerId, blockedId), eq(follows.creatorId, blockerId)),
				),
			);
	});

	return { blocked: true };
}

/**
 * Lift a block. Only the blocker can — the row is directed for exactly this.
 *
 * The follows are NOT restored. They were a relationship the block ended, and
 * silently re-subscribing someone to an account they were cut off from would be the
 * app making a social decision on their behalf.
 */
export async function unblockUser(
	blockerId: number,
	blockedId: number,
): Promise<{ unblocked: boolean }> {
	const removed = await db
		.delete(userBlocks)
		.where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))
		.returning({ id: userBlocks.id });
	return { unblocked: removed.length > 0 };
}

/**
 * The blocker's own list, for a Settings surface.
 *
 * Deliberately one-directional — it answers "who have I blocked?", never "who has
 * blocked me?". The second question has no honest surface: answering it would be the
 * app stating a block, which is the one thing this feature refuses to do.
 */
export async function listBlocks(
	blockerId: number,
): Promise<{ id: number; username: string | null; displayName: string | null; createdAt: Date }[]> {
	return db
		.select({
			id: users.id,
			username: users.username,
			displayName: users.displayName,
			createdAt: userBlocks.createdAt,
		})
		.from(userBlocks)
		.innerJoin(users, eq(userBlocks.blockedId, users.id))
		.where(eq(userBlocks.blockerId, blockerId))
		.orderBy(userBlocks.createdAt);
}

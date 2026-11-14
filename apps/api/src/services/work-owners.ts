// SPDX-License-Identifier: Apache-2.0
/**
 * Who owns a Work, and who is its publisher.
 *
 * A Work has two kinds of owner. `works.creatorId` is the **publisher** — the account the
 * Work's ATProto listing is written as, and the record's billing home — and
 * `work_collaborators` holds every other accepted owner. The owner set is the publisher
 * plus the accepted rows; the publisher is deliberately not duplicated into the join table,
 * so a solo Work has no rows at all and a handover moves one fact rather than two.
 *
 * 🚨 **Every authorization decision about a Work goes through this module.** The old
 * routes compared `works.creatorId` to the signed-in user, which is still correct for the
 * publisher and wrong for every collaborator. A route that keeps that comparison is a route
 * where the second owner cannot edit, upload, delete, or see the Work in their own Studio.
 *
 * The owner set is also what the money and display paths read: a Work's purchases split
 * across these ids, and every owner's profile and Studio lists it. The helpers return ids
 * in publisher-first order — the display and the split both want the publisher to lead.
 */
import { db } from "@anthers/db/client";
import { follows, users, workCollaborators, works } from "@anthers/db/schema";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";

/** One creator as the Work-ownership display needs them. */
export interface WorkOwner {
	id: number;
	handle: string;
	displayName: string | null;
	avatar: string | null;
	followerCount: number;
	isFollowing: boolean;
}

/** The publisher first, then the accepted collaborators. */
export async function workOwnerIds(workId: number): Promise<number[]> {
	const [publisher] = await db
		.select({ creatorId: works.creatorId })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!publisher?.creatorId) return [];

	const collaborators = await db
		.select({ creatorId: workCollaborators.creatorId })
		.from(workCollaborators)
		.where(and(eq(workCollaborators.workId, workId), eq(workCollaborators.status, "accepted")))
		.orderBy(workCollaborators.createdAt, workCollaborators.id);

	return [publisher.creatorId, ...collaborators.map((row) => row.creatorId)];
}

/** Batch form of {@link workOwnerIds}, for a profile grid or a library page. */
export async function workOwnerIdsForWorks(
	workIds: readonly number[],
): Promise<Map<number, number[]>> {
	const out = new Map<number, number[]>();
	if (workIds.length === 0) return out;

	const publishers = await db
		.select({ workId: works.id, creatorId: works.creatorId })
		.from(works)
		.where(inArray(works.id, [...workIds]));
	for (const row of publishers) {
		if (row.creatorId != null) out.set(row.workId, [row.creatorId]);
	}

	const collaborators = await db
		.select({ workId: workCollaborators.workId, creatorId: workCollaborators.creatorId })
		.from(workCollaborators)
		.where(
			and(
				inArray(workCollaborators.workId, [...workIds]),
				eq(workCollaborators.status, "accepted"),
			),
		)
		.orderBy(workCollaborators.createdAt, workCollaborators.id);

	for (const row of collaborators) {
		const owners = out.get(row.workId);
		if (owners) owners.push(row.creatorId);
	}
	return out;
}

/** True for the publisher and every accepted collaborator. */
export async function isWorkOwner(workId: number, userId: number): Promise<boolean> {
	const [publisher] = await db
		.select({ id: works.id })
		.from(works)
		.where(and(eq(works.id, workId), eq(works.creatorId, userId)))
		.limit(1);
	if (publisher) return true;

	const [collaborator] = await db
		.select({ id: workCollaborators.id })
		.from(workCollaborators)
		.where(
			and(
				eq(workCollaborators.workId, workId),
				eq(workCollaborators.creatorId, userId),
				eq(workCollaborators.status, "accepted"),
			),
		)
		.limit(1);
	return Boolean(collaborator);
}

/** True only for the publisher — the account a handover moves. */
export async function isWorkPublisher(workId: number, userId: number): Promise<boolean> {
	const [publisher] = await db
		.select({ id: works.id })
		.from(works)
		.where(and(eq(works.id, workId), eq(works.creatorId, userId)))
		.limit(1);
	return Boolean(publisher);
}

/**
 * The SQL condition for "this creator owns this Work" — the publisher or an accepted
 * collaborator. Use it in a `where` beside any other Work condition rather than loading
 * ids and filtering in memory.
 *
 * ⚠️ **A Work with no publisher (`works.creatorId` null, after an account deletion) is
 * owned by nobody here**, which is the state every deletion path already handles
 * explicitly. The collaborator half still returns its owners if such a row exists.
 */
export function workOwnedBy(creatorId: number): SQL {
	return sql`(${works.creatorId} = ${creatorId} OR EXISTS (SELECT 1 FROM ${workCollaborators} WHERE ${workCollaborators.workId} = ${works.id} AND ${workCollaborators.creatorId} = ${creatorId} AND ${workCollaborators.status} = 'accepted'))`;
}

/** The publisher-first owner list, with the display fields each surface needs. */
export async function workOwnerProfiles(
	workIds: readonly number[],
	viewerId: number | null,
): Promise<Map<number, WorkOwner[]>> {
	const byWork = await workOwnerIdsForWorks(workIds);
	const ids = [...new Set([...byWork.values()].flat())];
	const out = new Map<number, WorkOwner[]>();
	if (ids.length === 0) return out;

	const followerCount =
		sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = ${users.id})`.as(
			"follower_count",
		);
	const rows = await db
		.select({
			id: users.id,
			handle: users.atprotoHandle,
			displayName: users.displayName,
			avatar: users.avatar,
			followerCount,
		})
		.from(users)
		.where(inArray(users.id, ids));

	const followed = new Set<number>();
	if (viewerId != null) {
		const followRows = await db
			.select({ creatorId: follows.creatorId })
			.from(follows)
			.where(and(eq(follows.followerId, viewerId), inArray(follows.creatorId, ids)));
		for (const row of followRows) followed.add(row.creatorId);
	}

	const profiles = new Map(
		rows.map((row) => [
			row.id,
			{
				id: row.id,
				handle: row.handle,
				displayName: row.displayName,
				avatar: row.avatar || null,
				followerCount: Number(row.followerCount),
				isFollowing: followed.has(row.id),
			} satisfies WorkOwner,
		]),
	);

	for (const [workId, ownerIds] of byWork) {
		out.set(
			workId,
			ownerIds
				.map((id) => profiles.get(id))
				.filter((owner): owner is WorkOwner => owner !== undefined),
		);
	}
	return out;
}

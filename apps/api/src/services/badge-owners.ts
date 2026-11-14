// SPDX-License-Identifier: Apache-2.0
/**
 * Who owns a Badge, and who is its publisher.
 *
 * A Badge has two kinds of owner. `badges.creatorId` is the **publisher** — the account
 * the Badge's support line names and the home of its art — and `badge_collaborators` holds
 * every other accepted owner. The owner set is the publisher plus the accepted rows; the
 * publisher is deliberately not duplicated into the join table, because a solo Badge then
 * has no rows at all and a handover moves one fact rather than two.
 *
 * 🚨 **Every authorization decision about a Badge goes through this module.** The old
 * routes compared `badges.creatorId` to the signed-in user, which is still correct for the
 * publisher and wrong for every collaborator. A route that keeps that comparison is a
 * route where the second owner cannot edit, upload art, or see the ladder they co-own.
 *
 * The owner set is also what the support and access paths read: a held Badge's money
 * splits across these ids, and a Work gated at the Badge opens for a supporter of every
 * one of them. That is why the helpers return ids in publisher-first order — the display
 * and the split both want the publisher to lead, and the order is the one thing a caller
 * should not have to reconstruct.
 */
import { db } from "@anthers/db/client";
import { badgeCollaborators, badges, follows, userBadges, users } from "@anthers/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";

/** One creator as the collaborator display needs them. */
export interface BadgeOwner {
	id: number;
	handle: string;
	displayName: string | null;
	avatar: string | null;
	followerCount: number;
	isFollowing: boolean;
}

/** The publisher first, then the accepted collaborators. */
export async function badgeOwnerIds(badgeId: number): Promise<number[]> {
	const [publisher] = await db
		.select({ creatorId: badges.creatorId })
		.from(badges)
		.where(eq(badges.id, badgeId))
		.limit(1);
	if (!publisher) return [];

	const collaborators = await db
		.select({ creatorId: badgeCollaborators.creatorId })
		.from(badgeCollaborators)
		.where(and(eq(badgeCollaborators.badgeId, badgeId), eq(badgeCollaborators.status, "accepted")))
		.orderBy(badgeCollaborators.createdAt, badgeCollaborators.id);

	return [publisher.creatorId, ...collaborators.map((row) => row.creatorId)];
}

/** Batch form of {@link badgeOwnerIds}, for a ladder read or an invoice's badge lines. */
export async function badgeOwnerIdsForBadges(
	badgeIds: readonly number[],
): Promise<Map<number, number[]>> {
	const out = new Map<number, number[]>();
	if (badgeIds.length === 0) return out;

	const publishers = await db
		.select({ badgeId: badges.id, creatorId: badges.creatorId })
		.from(badges)
		.where(inArray(badges.id, [...badgeIds]));
	for (const row of publishers) out.set(row.badgeId, [row.creatorId]);

	const collaborators = await db
		.select({ badgeId: badgeCollaborators.badgeId, creatorId: badgeCollaborators.creatorId })
		.from(badgeCollaborators)
		.where(
			and(
				inArray(badgeCollaborators.badgeId, [...badgeIds]),
				eq(badgeCollaborators.status, "accepted"),
			),
		)
		.orderBy(badgeCollaborators.createdAt, badgeCollaborators.id);

	for (const row of collaborators) {
		const owners = out.get(row.badgeId);
		if (owners) owners.push(row.creatorId);
	}
	return out;
}

/** True for the publisher and every accepted collaborator. */
export async function isBadgeOwner(badgeId: number, userId: number): Promise<boolean> {
	const [publisher] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.id, badgeId), eq(badges.creatorId, userId)))
		.limit(1);
	if (publisher) return true;

	const [collaborator] = await db
		.select({ id: badgeCollaborators.id })
		.from(badgeCollaborators)
		.where(
			and(
				eq(badgeCollaborators.badgeId, badgeId),
				eq(badgeCollaborators.creatorId, userId),
				eq(badgeCollaborators.status, "accepted"),
			),
		)
		.limit(1);
	return Boolean(collaborator);
}

/** True only for the publisher — the account a handover moves. */
export async function isBadgePublisher(badgeId: number, userId: number): Promise<boolean> {
	const [publisher] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.id, badgeId), eq(badges.creatorId, userId)))
		.limit(1);
	return Boolean(publisher);
}

/**
 * The SQL condition for "this creator owns this Badge" — the publisher or an accepted
 * collaborator. Use it in a `where` beside any other Badge condition rather than loading
 * ids and filtering in memory.
 */
export function badgeOwnedBy(creatorId: number) {
	return or(
		eq(badges.creatorId, creatorId),
		sql`EXISTS (SELECT 1 FROM ${badgeCollaborators} WHERE ${badgeCollaborators.badgeId} = ${badges.id} AND ${badgeCollaborators.creatorId} = ${creatorId} AND ${badgeCollaborators.status} = 'accepted')`,
	);
}

/** The publisher-first owner list, with the display fields each surface needs. */
export async function badgeOwnerProfiles(
	badgeIds: readonly number[],
	viewerId: number | null,
): Promise<Map<number, BadgeOwner[]>> {
	const byBadge = await badgeOwnerIdsForBadges(badgeIds);
	const ids = [...new Set([...byBadge.values()].flat())];
	const out = new Map<number, BadgeOwner[]>();
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
			} satisfies BadgeOwner,
		]),
	);

	for (const [badgeId, ownerIds] of byBadge) {
		out.set(
			badgeId,
			ownerIds
				.map((id) => profiles.get(id))
				.filter((owner): owner is BadgeOwner => owner !== undefined),
		);
	}
	return out;
}

/**
 * What this user gives each **publisher** this cycle — the display half, not the access
 * half.
 *
 * 🚨 **This deliberately does not expand a shared Badge to its collaborators.** The
 * supporter's line names the publisher, and the co-owner's page shows the shared Badge in
 * its own section with the support it carries. Expanding here would make the co-owner's
 * "amount you give this creator" header claim the whole shared Badge as if the supporter
 * had pointed it at them. The access resolver expands the owner set instead, because a
 * held shared Badge does open every owner's gated Works.
 */
export async function heldAmountsByPublisher(
	userId: number,
	cycle: string,
): Promise<Record<number, string>> {
	const rows = await db
		.select({
			publisherId: badges.creatorId,
			given: sql<string>`MAX(${badges.threshold})`,
		})
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(and(eq(userBadges.userId, userId), eq(userBadges.billingCycle, cycle)))
		.groupBy(badges.creatorId);

	return Object.fromEntries(rows.map((row) => [row.publisherId, row.given]));
}

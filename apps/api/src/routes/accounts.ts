// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account routes — profiles, follows, feed, creator list.
 *
 * Endpoints:
 *   GET    /me                      — current user profile (full)
 *   PATCH  /me                      — update current user profile
 *   GET    /me/following            — list creators the current user follows
 *   GET    /me/feed                 — posts from followed creators
 *   GET    /creators                — list all creators
 *   GET    /users/:username         — public user profile
 *   POST   /users/:username/follow  — follow a creator
 *   POST   /users/:username/unfollow — unfollow a creator
 */

import { db } from "@anthers/db/client";
import { follows, posts, users } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateSession } from "../services/auth.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Public user profile shape (for lists and public profiles) */
function serializePublicUser(
	user: typeof users.$inferSelect,
	extra: { followerCount: number; projectCount: number; isFollowing: boolean },
) {
	return {
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		bio: user.bio,
		isCreator: user.isCreator,
		avatar: user.avatar,
		headerImage: user.headerImage,
		websiteUrl: user.websiteUrl,
		location: user.location,
		atprotoDid: user.atprotoDid,
		atprotoHandle: user.atprotoHandle,
		createdAt: user.createdAt,
		followerCount: extra.followerCount,
		projectCount: extra.projectCount,
		isFollowing: extra.isFollowing,
	};
}

/** Private user profile shape (for /me) */
function serializePrivateUser(user: typeof users.$inferSelect) {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		displayName: user.displayName,
		bio: user.bio,
		isCreator: user.isCreator,
		avatar: user.avatar,
		headerImage: user.headerImage,
		websiteUrl: user.websiteUrl,
		location: user.location,
		emailVerified: user.emailVerified,
		atprotoDid: user.atprotoDid,
		atprotoHandle: user.atprotoHandle,
		createdAt: user.createdAt,
	};
}

/** Get current user ID from cookie if authenticated, null otherwise */
async function getOptionalUserId(c: any): Promise<number | null> {
	const token = getCookie(c, "session");
	if (!token) return null;
	const result = await validateSession(token);
	return result?.user.id ?? null;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
	displayName: z.string().max(150).optional(),
	bio: z.string().max(5000).optional(),
	isCreator: z.boolean().optional(),
	avatar: z.string().max(500).optional(),
	headerImage: z.string().max(500).optional(),
	websiteUrl: z.string().max(500).optional(),
	location: z.string().max(100).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

const accountRoutes = new Hono()
	// ── Current User Profile ─────────────────────────────────────────────────
	.get("/me", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const [user] = await db.select().from(users).where(eq(users.id, sessionUser.id)).limit(1);

		if (!user) return c.json({ error: "User not found" }, 404);

		return c.json({ user: serializePrivateUser(user) });
	})

	.patch("/me", requireAuth, zValidator("json", updateProfileSchema), async (c) => {
		const sessionUser = c.get("user");
		const data = c.req.valid("json");

		// Filter out undefined values
		const updates: Record<string, any> = {};
		if (data.displayName !== undefined) updates.displayName = data.displayName;
		if (data.bio !== undefined) updates.bio = data.bio;
		if (data.isCreator !== undefined) updates.isCreator = data.isCreator;
		if (data.avatar !== undefined) updates.avatar = data.avatar;
		if (data.headerImage !== undefined) updates.headerImage = data.headerImage;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.location !== undefined) updates.location = data.location;

		if (Object.keys(updates).length === 0) {
			return c.json({ error: "No fields to update" }, 400);
		}

		const [updated] = await db
			.update(users)
			.set(updates)
			.where(eq(users.id, sessionUser.id))
			.returning();

		return c.json({ user: serializePrivateUser(updated) });
	})

	// ── Following List ───────────────────────────────────────────────────────
	.get("/me/following", requireAuth, async (c) => {
		const sessionUser = c.get("user");

		const followedUsers = await db
			.select({
				user: users,
				followerCount: sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = )`.as(
					"follower_count",
				),
				projectCount: sql<number>`(SELECT count(*)::int FROM projects WHERE creator_id = )`.as(
					"project_count",
				),
			})
			.from(users)
			.innerJoin(
				follows,
				and(eq(follows.creatorId, users.id), eq(follows.followerId, sessionUser.id)),
			);

		return c.json({
			users: followedUsers.map((row) =>
				serializePublicUser(row.user, {
					followerCount: Number(row.followerCount),
					projectCount: Number(row.projectCount),
					isFollowing: true, // by definition, you follow everyone in this list
				}),
			),
		});
	})

	// ── Feed ─────────────────────────────────────────────────────────────────
	.get("/me/feed", requireAuth, async (c) => {
		const sessionUser = c.get("user");

		// Get followed creator IDs
		const followedIds = await db
			.select({ creatorId: follows.creatorId })
			.from(follows)
			.where(eq(follows.followerId, sessionUser.id));

		const creatorIds = followedIds.map((f) => f.creatorId);

		if (creatorIds.length === 0) {
			return c.json({ posts: [] });
		}

		const feedPosts = await db
			.select({
				post: posts,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(posts)
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(and(inArray(posts.creatorId, creatorIds), eq(posts.isPublished, true)))
			.orderBy(desc(posts.createdAt))
			.limit(50);

		return c.json({
			posts: feedPosts.map((row) => ({
				...row.post,
				creator: {
					username: row.creatorUsername,
					displayName: row.creatorDisplayName,
					avatar: row.creatorAvatar,
				},
			})),
		});
	})

	// ── Creator List ─────────────────────────────────────────────────────────
	.get("/creators", async (c) => {
		const currentUserId = await getOptionalUserId(c);

		const creatorList = await db
			.select({
				user: users,
				followerCount: sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = )`.as(
					"follower_count",
				),
				projectCount: sql<number>`(SELECT count(*)::int FROM projects WHERE creator_id = )`.as(
					"project_count",
				),
				...(currentUserId
					? {
							isFollowing:
								sql<boolean>`EXISTS(SELECT 1 FROM follows WHERE follower_id = ${currentUserId} AND creator_id = ${users.id})`.as(
									"is_following",
								),
						}
					: {}),
			})
			.from(users)
			.where(eq(users.isCreator, true));

		return c.json({
			creators: creatorList.map((row) =>
				serializePublicUser(row.user, {
					followerCount: Number(row.followerCount),
					projectCount: Number(row.projectCount),
					isFollowing: currentUserId ? Boolean((row as any).isFollowing) : false,
				}),
			),
		});
	})

	// ── Public User Profile ──────────────────────────────────────────────────
	.get("/users/:username", async (c) => {
		const { username } = c.req.param();
		const currentUserId = await getOptionalUserId(c);

		const result = await db
			.select({
				user: users,
				followerCount: sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = )`.as(
					"follower_count",
				),
				projectCount: sql<number>`(SELECT count(*)::int FROM projects WHERE creator_id = )`.as(
					"project_count",
				),
				...(currentUserId
					? {
							isFollowing:
								sql<boolean>`EXISTS(SELECT 1 FROM follows WHERE follower_id = ${currentUserId} AND creator_id = ${users.id})`.as(
									"is_following",
								),
						}
					: {}),
			})
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (result.length === 0) {
			return c.json({ error: "User not found" }, 404);
		}

		const row = result[0];
		return c.json({
			user: serializePublicUser(row.user, {
				followerCount: Number(row.followerCount),
				projectCount: Number(row.projectCount),
				isFollowing: currentUserId ? Boolean((row as any).isFollowing) : false,
			}),
		});
	})

	// ── Follow ───────────────────────────────────────────────────────────────
	.post("/users/:username/follow", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const { username } = c.req.param();

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (!creator) {
			return c.json({ error: "User not found" }, 404);
		}

		if (creator.id === sessionUser.id) {
			return c.json({ error: "You cannot follow yourself" }, 400);
		}

		// Idempotent: insert if not exists
		await db
			.insert(follows)
			.values({ followerId: sessionUser.id, creatorId: creator.id })
			.onConflictDoNothing();

		// TODO: ATProto sync (sync_follow_to_atproto)

		return c.json({ detail: "Followed." }, 201);
	})

	// ── Unfollow ─────────────────────────────────────────────────────────────
	.post("/users/:username/unfollow", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const { username } = c.req.param();

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (!creator) {
			return c.json({ error: "User not found" }, 404);
		}

		const deleted = await db
			.delete(follows)
			.where(and(eq(follows.followerId, sessionUser.id), eq(follows.creatorId, creator.id)))
			.returning({ id: follows.id });

		// Check if any rows were deleted
		if (deleted.length === 0) {
			return c.json({ error: "You were not following this user" }, 404);
		}

		return c.body(null, 204);
	});

export { accountRoutes };

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account routes — profiles, follows, feed, creator list, blocks.
 *
 * Endpoints:
 *   GET    /me                      — current user profile (full)
 *   PATCH  /me                      — update current user profile
 *   GET    /me/following            — list creators the current user follows
 *   GET    /me/feed                 — posts AND releases from followed creators
 *   GET    /me/blocks               — who the current user has blocked
 *   GET    /creators                — list all creators
 *   GET    /users/:username         — public user profile
 *   POST   /users/:username/follow  — follow a creator
 *   POST   /users/:username/unfollow — unfollow a creator
 *   POST   /users/:username/block   — block a user
 *   POST   /users/:username/unblock — lift a block
 *
 * **Blocking lives here, not under `/moderation`.** A block is a relationship
 * primitive between two accounts — the same shape as a follow and its opposite — and
 * an operator's judgment about content is a different thing entirely. Routing them
 * separately is what keeps a personal boundary free of a review queue. The rules are
 * in `services/blocks.ts`.
 */

import { db } from "@anthers/db/client";
import { follows, posts, rightsRequests, users, works } from "@anthers/db/schema";
import {
	isRightsRequestKind,
	RIGHTS_DETAILS_MAX,
	RIGHTS_RESPONSE_DAYS,
} from "@anthers/shared/rights";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { type ClaimedUser, embedCreator, hasHandle } from "../lib/handles.js";
import { requireAuth } from "../middleware/auth.js";
import { buildAccountExport } from "../services/account-data.js";
import {
	cancelDeletion,
	DELETION_GRACE_DAYS,
	deletionPreview,
	requestDeletion,
} from "../services/account-deletion.js";
import { validateSession } from "../services/auth.js";
import { blockUser, isBlocked, listBlocks, notBlockedBy, unblockUser } from "../services/blocks.js";
import { listNotifications, markRead, notify, unreadCount } from "../services/notifications.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Public user profile shape (for lists and public profiles) */
function serializePublicUser(
	user: ClaimedUser,
	extra: {
		followerCount: number;
		projectCount: number;
		isFollowing: boolean;
		/** Work types this creator has actually released — absent where not queried. */
		mediums?: string[];
	},
) {
	return {
		...(extra.mediums ? { mediums: extra.mediums } : {}),
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
		themePreference: user.themePreference,
		atprotoDid: user.atprotoDid,
		atprotoHandle: user.atprotoHandle,
		createdAt: user.createdAt,
		// Surfaced on /me because the cancel path runs through signing back in: someone
		// who changes their mind has to be TOLD a deletion is pending the moment they
		// return, or the "oops" window is one they can only use if they remember it
		// unaided.
		deletionRequestedAt: user.deletionRequestedAt,
		notifyActivityEmail: user.notifyActivityEmail,
	};
}

/**
 * `users.id`, qualified — the outer column a correlated subquery has to name.
 *
 * 🚨 Interpolating `${users.id}` inside a `sql` template that sits in a SELECT list
 * renders it **unqualified**, as bare `"id"`. Inside a subquery over another table that
 * then binds to *that* table's `id` — `follows.id`, `posts.id` — so
 * `WHERE creator_id = ${users.id}` silently becomes `WHERE creator_id = follows.id`.
 * Postgres raises nothing, the shape of the result is right, and every count is wrong:
 * follower counts, project counts and `isFollowing` all read 0 for accounts that had
 * followers, posts and follows. Found 2026-08-11 while building /subscribe, which is the
 * first surface to render these numbers where being wrong is obvious.
 *
 * The lesson generalises past this file: **a correlated subquery in a select list must
 * qualify its outer reference**, and the failure mode is a plausible number rather than
 * an error. `routes/jams.ts`'s `entryCount` has the identical shape against
 * `jam_entries.id` and is left alone here only because it is nothing to do with this
 * change.
 */
const usersId = sql`${sql.identifier("users")}.${sql.identifier("id")}`;

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
	themePreference: z.enum(["light", "dark"]).optional(),
	notifyActivityEmail: z.boolean().optional(),
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

		// Enabling creator mode requires a verified email — creators can receive
		// funds, so we hold the same bar as spending money.
		if (data.isCreator === true && !sessionUser.emailVerified) {
			return c.json(
				{
					error: "Verify your email address before enabling creator mode.",
					code: "email_unverified",
				},
				403,
			);
		}

		// Filter out undefined values
		const updates: Record<string, any> = {};
		if (data.displayName !== undefined) updates.displayName = data.displayName;
		if (data.bio !== undefined) updates.bio = data.bio;
		if (data.isCreator !== undefined) updates.isCreator = data.isCreator;
		if (data.avatar !== undefined) updates.avatar = data.avatar;
		if (data.headerImage !== undefined) updates.headerImage = data.headerImage;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.location !== undefined) updates.location = data.location;
		if (data.themePreference !== undefined) updates.themePreference = data.themePreference;
		// `essential` mail has no switch by design — see services/notifications.ts.
		if (data.notifyActivityEmail !== undefined)
			updates.notifyActivityEmail = data.notifyActivityEmail;

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
				followerCount:
					sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = ${usersId})`.as(
						"follower_count",
					),
				projectCount:
					sql<number>`(SELECT count(*)::int FROM posts WHERE creator_id = ${usersId} AND is_published = true)`.as(
						"project_count",
					),
			})
			.from(users)
			.innerJoin(
				follows,
				and(eq(follows.creatorId, users.id), eq(follows.followerId, sessionUser.id)),
			)
			// Blocking deletes the follow in both directions, so this list is already clean
			// by construction. Filtered anyway: "it can't happen because of what another
			// function does" is the reasoning that leaves a leak behind when that other
			// function changes, and a block that leaks is worse than no block.
			.where(notBlockedBy(sessionUser.id, users.id));

		return c.json({
			// `flatMap` rather than `map`, so an account that has not claimed a handle is
			// dropped instead of rendered. It should not be reachable — you cannot follow
			// someone with no profile — but this list is built from a join, and "it can't
			// happen because of what another function does" is the reasoning the block
			// filter above already refuses to rely on.
			users: followedUsers.flatMap((row) =>
				hasHandle(row.user)
					? [
							serializePublicUser(row.user, {
								followerCount: Number(row.followerCount),
								projectCount: Number(row.projectCount),
								isFollowing: true, // by definition, you follow everyone in this list
							}),
						]
					: [],
			),
		});
	})

	// ── Feed ─────────────────────────────────────────────────────────────────
	.get("/me/feed", requireAuth, async (c) => {
		const sessionUser = c.get("user");

		// Get followed creator IDs. Blocked either way is excluded here rather than at each
		// of the two queries below — the feed's whole input is this id list, so one filter
		// at the source is also the one that can't be forgotten by a third feed query later.
		const followedIds = await db
			.select({ creatorId: follows.creatorId })
			.from(follows)
			.where(
				and(
					eq(follows.followerId, sessionUser.id),
					notBlockedBy(sessionUser.id, follows.creatorId),
				),
			);

		const creatorIds = followedIds.map((f) => f.creatorId);

		if (creatorIds.length === 0) {
			return c.json({ posts: [] });
		}

		// The feed shows BOTH what a creator said and what they released.
		//
		// This is what keeps releasing from costing a creator their reach. Without it, a
		// creator who only ever adds to their Catalog is invisible to their own followers
		// until they write an announcement — which would quietly re-couple the two things
		// the model just separated, by making a post the price of being seen. Filtered with
		// `?kind=posts` or `?kind=releases` for someone who wants one or the other.
		const kind = c.req.query("kind") ?? "all";

		const feedPosts =
			kind === "releases"
				? []
				: await db
						.select({
							post: posts,
							creatorUsername: users.username,
							creatorDisplayName: users.displayName,
							creatorAvatar: users.avatar,
						})
						.from(posts)
						.innerJoin(users, eq(posts.creatorId, users.id))
						.where(and(inArray(posts.creatorId, creatorIds), eq(posts.isPublished, true)))
						.orderBy(sql`COALESCE(${posts.publishedAt}, ${posts.createdAt}) DESC`)
						.limit(50);

		const feedWorks =
			kind === "posts"
				? []
				: await db
						.select({
							work: works,
							creatorUsername: users.username,
							creatorDisplayName: users.displayName,
							creatorAvatar: users.avatar,
						})
						.from(works)
						.innerJoin(users, eq(works.creatorId, users.id))
						.where(and(inArray(works.creatorId, creatorIds), eq(works.visibility, "released")))
						.orderBy(sql`COALESCE(${works.releasedAt}, ${works.createdAt}) DESC`)
						.limit(50);

		// Enumerate the fields rather than spreading the row. This used to be
		// `...row.post`, which shipped `body` and `bodyHtml` for every followed creator's
		// post regardless of gating. A post carries no gate of its own now, so there is no
		// per-entry access verdict here — but enumerating stays, because a feed has no
		// business shipping a whole row and the habit is what kept the leak out.
		//
		// The Works are enumerated for a stronger reason: a released Work is very often
		// gated, and this endpoint resolves no access at all. Nothing here may carry a
		// payload — no sourceKey, no embedUrl, no transcode URLs — only the card. Anyone
		// who wants the thing itself goes to the Work, where access is resolved live.
		const entries = [
			...feedPosts.map((row) => {
				const p = row.post;
				return {
					kind: "post" as const,
					// The feed sorts on one key across both kinds; a post's is its publication.
					at: (p.publishedAt ?? p.createdAt).toISOString(),
					id: p.id,
					publicId: p.publicId,
					slug: p.slug,
					creatorId: p.creatorId,
					title: p.title,
					showOnTimeline: p.showOnTimeline,
					isPinned: p.isPinned,
					tags: p.tags,
					isPublished: p.isPublished,
					publishedAt: p.publishedAt,
					scheduledFor: p.scheduledFor,
					viewCount: p.viewCount,
					createdAt: p.createdAt,
					updatedAt: p.updatedAt,
					creator: embedCreator({
						username: row.creatorUsername,
						displayName: row.creatorDisplayName,
						avatar: row.creatorAvatar,
					}),
				};
			}),
			...feedWorks.map((row) => {
				const w = row.work;
				return {
					kind: "release" as const,
					// A release sorts on when it went public, NOT on its Created date — the
					// feed is "what happened", and a back-dated 2015 game released today is
					// news today. The Catalog is where the Created date does the ordering.
					at: (w.releasedAt ?? w.createdAt).toISOString(),
					id: w.id,
					publicId: w.publicId,
					slug: w.slug,
					creatorId: w.creatorId,
					title: w.title,
					type: w.type,
					// Thumbnails are public by design — they are the preview a locked Work is
					// supposed to show.
					thumbnail: w.thumbnail,
					description: w.description,
					authoredAt: w.authoredAt,
					authoredPrecision: w.authoredPrecision,
					releasedAt: w.releasedAt,
					createdAt: w.createdAt,
					creator: embedCreator({
						username: row.creatorUsername,
						displayName: row.creatorDisplayName,
						avatar: row.creatorAvatar,
					}),
				};
			}),
		]
			.sort((a, b) => b.at.localeCompare(a.at))
			.slice(0, 50);

		return c.json({
			entries,
			// `posts` kept as the posts-only projection so an older client keeps working
			// rather than rendering an empty feed against a key it doesn't know.
			posts: entries.filter((e) => e.kind === "post"),
		});
	})

	// ── Creator List ─────────────────────────────────────────────────────────
	.get("/creators", async (c) => {
		const currentUserId = await getOptionalUserId(c);

		const creatorList = await db
			.select({
				user: users,
				followerCount:
					sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = ${usersId})`.as(
						"follower_count",
					),
				projectCount:
					sql<number>`(SELECT count(*)::int FROM posts WHERE creator_id = ${usersId} AND is_published = true)`.as(
						"project_count",
					),
				// What a creator actually makes, taken from what they have released rather
				// than from anything they declare — a self-described medium drifts the moment
				// the catalog does. Feeds the medium chips on /subscribe.
				mediums: sql<
					string[]
				>`COALESCE((SELECT array_agg(DISTINCT w.type) FROM works w WHERE w.creator_id = ${usersId} AND w.visibility = 'released'), ARRAY[]::text[])`.as(
					"mediums",
				),
				...(currentUserId
					? {
							isFollowing:
								sql<boolean>`EXISTS(SELECT 1 FROM follows WHERE follower_id = ${currentUserId} AND creator_id = ${usersId})`.as(
									"is_following",
								),
						}
					: {}),
			})
			.from(users)
			// Discover's people half. A blocked creator is absent from the listing entirely,
			// in both directions — this is the surface where two users are most likely to
			// run into each other without going looking.
			.where(and(eq(users.isCreator, true), notBlockedBy(currentUserId, users.id)));

		return c.json({
			creators: creatorList.flatMap((row) =>
				hasHandle(row.user)
					? [
							serializePublicUser(row.user, {
								followerCount: Number(row.followerCount),
								projectCount: Number(row.projectCount),
								isFollowing: currentUserId ? Boolean((row as any).isFollowing) : false,
								mediums: row.mediums ?? [],
							}),
						]
					: [],
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
				followerCount:
					sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = ${usersId})`.as(
						"follower_count",
					),
				projectCount:
					sql<number>`(SELECT count(*)::int FROM posts WHERE creator_id = ${usersId} AND is_published = true)`.as(
						"project_count",
					),
				...(currentUserId
					? {
							isFollowing:
								sql<boolean>`EXISTS(SELECT 1 FROM follows WHERE follower_id = ${currentUserId} AND creator_id = ${usersId})`.as(
									"is_following",
								),
						}
					: {}),
			})
			.from(users)
			// A blocked profile is not found — the same answer a username nobody has ever
			// registered gets. It is the least informative response available: no
			// blocked-state screen, no "this user has blocked you", nothing that states the
			// block. That is not the same as concealing it, and we don't claim it is; a
			// profile that used to load and now 404s is inferrable. What Anthers holds is
			// that it never *says* so, and offers no surface reporting who blocked whom.
			.where(and(eq(users.username, username), notBlockedBy(currentUserId, users.id)))
			.limit(1);

		if (result.length === 0) {
			return c.json({ error: "User not found" }, 404);
		}

		const row = result[0];
		// Unreachable through this route — the lookup matched on the handle, so a row with
		// none cannot come back — but the 404 is the correct answer to "show me the profile
		// of an account that has not claimed a name", and stating it is cheaper than
		// asserting the row's shape and being wrong later.
		if (!hasHandle(row.user)) {
			return c.json({ error: "User not found" }, 404);
		}
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

		// A block refuses the follow in both directions, and answers 404 rather than 403
		// so it matches what the profile said a moment earlier. A 403 here would be the
		// endpoint announcing the block the profile route just declined to.
		if (await isBlocked(sessionUser.id, creator.id)) {
			return c.json({ error: "User not found" }, 404);
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
	})

	// ── Data-rights requests ─────────────────────────────────────────────────
	// The non-self-serve half of 51.05's rights section. Export and deletion are
	// buttons; this is for rectification, objection and "tell me what you hold".
	// `dueAt` is stamped here so the 30-day commitment is fixed when it is made.

	.get("/me/rights-requests", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const rows = await db
			.select()
			.from(rightsRequests)
			.where(eq(rightsRequests.userId, sessionUser.id))
			.orderBy(desc(rightsRequests.createdAt));
		return c.json({ requests: rows, responseDays: RIGHTS_RESPONSE_DAYS });
	})

	.post(
		"/me/rights-requests",
		requireAuth,
		zValidator(
			"json",
			z.object({
				kind: z.string().refine(isRightsRequestKind, "Unknown request kind"),
				details: z.string().max(RIGHTS_DETAILS_MAX).optional(),
			}),
		),
		async (c) => {
			const sessionUser = c.get("user");
			const { kind, details } = c.req.valid("json");
			const dueAt = new Date(Date.now() + RIGHTS_RESPONSE_DAYS * 24 * 60 * 60 * 1000);

			const [row] = await db
				.insert(rightsRequests)
				.values({
					userId: sessionUser.id,
					// Snapshot: the account may be deleted before this is answered, and an
					// unanswerable request is worse than a slow one.
					email: sessionUser.email,
					kind,
					details: (details ?? "").trim(),
					dueAt,
				})
				.returning();

			// Confirmed in writing, with the deadline in it. A rights request that
			// vanishes into a queue with no acknowledgement is the thing people file
			// complaints about, and the record here is also our evidence of the clock.
			await notify({
				userId: sessionUser.id,
				category: "essential",
				kind: "rights_request_received",
				title: "We've got your request",
				body: `We'll reply by ${dueAt.toISOString().slice(0, 10)}. If what you wanted was a copy of your data or to delete your account, both of those are immediate — you don't have to wait for us.`,
				linkPath: "/settings",
				dedupeKey: `rights-request:${row.id}`,
			});

			return c.json({ request: row, dueAt: dueAt.toISOString() }, 201);
		},
	)

	// ── Notifications ────────────────────────────────────────────────────────
	// The in-app half. Email is the floor and this is the addition — see
	// `services/notifications.ts` on why it is that way round rather than the reverse.

	.get("/me/notifications", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const [items, unread] = await Promise.all([
			listNotifications(sessionUser.id),
			unreadCount(sessionUser.id),
		]);
		return c.json({ notifications: items, unread });
	})

	.post(
		"/me/notifications/read",
		requireAuth,
		zValidator("json", z.object({ ids: z.array(z.number().int().positive()).optional() })),
		async (c) => {
			const sessionUser = c.get("user");
			// Scoped to the owner inside the service, not here — "mark read" taking a bare
			// id list is exactly the shape that reads somebody else's rows if the filter
			// lives at the route.
			return c.json(await markRead(sessionUser.id, c.req.valid("json").ids));
		},
	)

	// ── Deletion ─────────────────────────────────────────────────────────────
	// Scheduled and cancellable, per Parker's 2026-08-07 shape: informed consent, an
	// "oops" window, no hoarding. Rules and per-table outcomes live in
	// `services/account-deletion.js`.

	// What deleting would actually do to THIS account, in real counts. The
	// confirmation screen renders these — a generic "your content will be deleted" is
	// a sentence people click past, and consent that isn't informed isn't consent.
	.get("/me/deletion", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const [row] = await db
			.select({ deletionRequestedAt: users.deletionRequestedAt })
			.from(users)
			.where(eq(users.id, sessionUser.id))
			.limit(1);
		return c.json({
			scheduledFor: row?.deletionRequestedAt ?? null,
			graceDays: DELETION_GRACE_DAYS,
			preview: await deletionPreview(sessionUser.id),
		});
	})

	.delete("/me", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const { scheduledFor } = await requestDeletion(sessionUser.id);
		// The session that made the request is gone with the rest of them, so clear the
		// cookie too rather than leaving the browser holding a token the server has
		// already forgotten.
		deleteCookie(c, "session", { path: "/" });
		return c.json({ scheduledFor, graceDays: DELETION_GRACE_DAYS });
	})

	.post("/me/deletion/cancel", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const { cancelled } = await cancelDeletion(sessionUser.id);
		if (!cancelled) return c.json({ error: "No deletion was scheduled." }, 404);
		return c.json({ cancelled: true });
	})

	// ── Blocks ───────────────────────────────────────────────────────────────
	// A personal boundary, not a moderation action. Nothing here writes to
	// `moderation_actions`, nothing enters the operator queue, and no one reviews it.
	// Rules and reasoning: `services/blocks.ts`.

	.get("/me/blocks", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		return c.json({ blocks: await listBlocks(sessionUser.id) });
	})

	// ── Export ───────────────────────────────────────────────────────────────
	// 51.05's "get a copy of your information and your content, in an openly
	// readable format", and Article I(c)'s commitment to *access*. Rules about what
	// is and isn't in it — especially the credentials and other people's data that
	// deliberately are not — live in `services/account-data.ts`.
	.get("/me/export", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const data = await buildAccountExport(sessionUser.id);
		if (!data) return c.json({ error: "User not found" }, 404);

		// Served as a download rather than an inline body: this is the one document
		// containing everything about a person, and a browser rendering it in a tab is
		// a thing that ends up in shared screenshots and back-button history.
		const stamp = new Date().toISOString().slice(0, 10);
		c.header("Content-Type", "application/json; charset=utf-8");
		c.header(
			"Content-Disposition",
			`attachment; filename="anthers-export-${sessionUser.username}-${stamp}.json"`,
		);
		// Never cached: it is personal data, and a shared or proxy cache holding it is
		// the failure this header exists for.
		c.header("Cache-Control", "no-store");
		return c.body(JSON.stringify(data, null, 2));
	})

	.post("/users/:username/block", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const { username } = c.req.param();

		const [target] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (!target) return c.json({ error: "User not found" }, 404);

		const result = await blockUser(sessionUser.id, target.id);
		if ("error" in result) return c.json({ error: "You cannot block yourself" }, 400);

		return c.json({ blocked: true }, 201);
	})

	.post("/users/:username/unblock", requireAuth, async (c) => {
		const sessionUser = c.get("user");
		const { username } = c.req.param();

		// Resolved WITHOUT the block filter — deliberately. Every other lookup of a
		// username goes through `notBlockedBy`, which would make the blocked user
		// invisible to the one person who needs to name them: their blocker. Unblocking
		// is the one operation where the block must not hide its own subject.
		const [target] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);

		if (!target) return c.json({ error: "User not found" }, 404);

		const { unblocked } = await unblockUser(sessionUser.id, target.id);
		if (!unblocked) return c.json({ error: "You had not blocked this user" }, 404);

		return c.body(null, 204);
	});

export { accountRoutes };

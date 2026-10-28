// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: the reader's Library and reading positions.
 *
 * Saving is curation rather than entitlement — the rows here are what a reader kept, and
 * access to anything in it still resolves on its own gates (see `services/library.ts`).
 *
 * Split out of `routes/content.ts` on 2026-10-28; docblocks moved with their code.
 */

import { db } from "@anthers/db/client";
import { posts, projects, userLibraryItems, users, works } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { embedCreator } from "../../lib/handles.js";
import { displayPostTitles } from "../../lib/post-title-mentions.js";
import { requireAuth } from "../../middleware/auth.js";
import { invalidBody } from "../../middleware/validate.js";
import {
	type AccessibleWork,
	buildAccessContext,
	resolveAccessSync,
} from "../../services/access.js";
import { interactionPermissionRefusal } from "../../services/atproto.js";
import { adultVisibility } from "../../services/content-preferences.js";
import { acceptCredit, rejectCredit } from "../../services/credit-acceptance.js";
import {
	LIBRARY_LIMIT,
	permanentWorkIds,
	removeItem,
	savePost,
	saveProject,
	saveWork,
	setHidden,
} from "../../services/library.js";
import { parentalVisibility } from "../../services/parental-controls.js";
import { postContentExcerpt } from "../../services/post-markdown.js";
import { releaseCounts, releasesByWorkId } from "../../services/project-releases.js";
import {
	queueLibraryEntry,
	queueLibraryRemoval,
	queuePosition,
} from "../../services/reader-state-migration.js";
import { findPosition, listPositions, upsertPosition } from "../../services/reading-positions.js";
import {
	allowanceSpent,
	deliveryCtx,
	findWorkRow,
	loadWorkBundles,
	queueReaderWrite,
	resolveProjectThumbnails,
	resolveWorkThumbnail,
	serializeWorkForUser,
	workAccessFor,
} from "../content.js";
import { parseNumericId } from "./access.js";
import { positionPointerSchema } from "./schemas.js";

const libraryRoutes = new Hono()
	.get("/library", requireAuth, async (c) => {
		const user = c.get("user");
		const includeHidden = c.req.query("hidden") === "1";

		const conditions: SQL[] = [eq(userLibraryItems.userId, user.id)];
		if (!includeHidden) conditions.push(eq(userLibraryItems.hidden, false));

		// Newest first to choose which entries fit, one extra to learn whether any did not, then
		// back into saved order for the Library.
		const newest = await db
			.select()
			.from(userLibraryItems)
			.where(and(...conditions))
			.orderBy(desc(userLibraryItems.sortOrder))
			.limit(LIBRARY_LIMIT + 1);
		const truncated = newest.length > LIBRARY_LIMIT;
		const rows = newest.slice(0, LIBRARY_LIMIT).reverse();

		const workIds = rows.map((r) => r.workId).filter((id): id is number => id != null);
		const projectIds = rows.map((r) => r.projectId).filter((id): id is number => id != null);
		const postIds = rows.map((r) => r.postId).filter((id): id is number => id != null);

		// 🚨 A Library is a listing like any other, so a Work the user may not see is absent from
		// it rather than present and locked — including one they saved or bought before it was
		// corrected into Adult, or before a guardian blocked it. The entry itself survives in
		// `user_library_items` and comes back if they opt in or the block lifts.
		const [{ hidden: adultHidden }, { hidden: parentalHidden }] = await Promise.all([
			adultVisibility(user.id),
			parentalVisibility(user.id),
		]);
		const workRows = workIds.length
			? await db
					.select()
					.from(works)
					.where(and(inArray(works.id, workIds), adultHidden, parentalHidden))
			: [];
		const projectRows = projectIds.length
			? await db
					.select({
						id: projects.id,
						slug: projects.slug,
						title: projects.title,
						thumbnail: projects.thumbnail,
						thumbnailWorkId: projects.thumbnailWorkId,
						creatorId: projects.creatorId,
						creatorHandle: users.atprotoHandle,
						creatorDisplayName: users.displayName,
					})
					.from(projects)
					.leftJoin(users, eq(projects.creatorId, users.id))
					.where(inArray(projects.id, projectIds))
			: [];
		// A saved post is a Library entry like any other, and its card reads like a post card
		// (title, excerpt, the creator). Published state rides along so the Library can say
		// when a saved post has gone back to draft rather than rendering a dead link.
		const postRows = postIds.length
			? await db
					.select({
						id: posts.id,
						publicId: posts.publicId,
						slug: posts.slug,
						title: posts.title,
						body: posts.body,
						tags: posts.tags,
						isPublished: posts.isPublished,
						creatorHandle: users.atprotoHandle,
						creatorDisplayName: users.displayName,
						creatorAvatar: users.avatar,
					})
					.from(posts)
					.leftJoin(users, eq(posts.creatorId, users.id))
					.where(inArray(posts.id, postIds))
			: [];

		/*
		 * The published Projects each saved Work belongs to — the membership the music lens
		 * groups a saved track under. A track is a track, not a record, and a person who
		 * saved one from a Project should find that Project in their collection rather than
		 * a loose row with no way into the rest of it.
		 *
		 * The query lives in `services/project-releases.ts`, shared with the Network feed's
		 * release entries. It is deliberately metadata only — cover, artist, title and the
		 * released-member counts — because the track list itself is fetched when somebody
		 * opens or plays the release.
		 */
		const { byWork: releasesByWork, counts: membershipCounts } = await releasesByWorkId(workIds, {
			adultHidden,
			parentalHidden,
		});
		// A saved Project's own card advertises its released members, whether or not one of
		// them is also in the Library. `musicCount` is what makes a Project a record rather
		// than a folder — the same rule `isAlbum` applies on a Project page — and `audio`
		// does not count as music, so a series of podcast episodes draws no release card.
		const countsByProject = new Map([
			...membershipCounts,
			...(await releaseCounts(projectIds, { adultHidden, parentalHidden })),
		]);

		const { assetsByWork, jobByWork, pagesByWork, sectionsByWork, buildsByWork } =
			await loadWorkBundles(workIds);
		const [ctx, spent, permanent] = await Promise.all([
			buildAccessContext(user.id, { workIds }),
			allowanceSpent(user.id),
			permanentWorkIds(user.id),
		]);
		await Promise.all(workRows.map(resolveWorkThumbnail));

		const workById = new Map(workRows.map((w) => [w.id, w]));
		const projectById = new Map(projectRows.map((p) => [p.id, p]));
		const postById = new Map(postRows.map((p) => [p.id, p]));
		// A saved Project whose thumbnail is one of its Works reads that thumbnail here too — as the
		// Library's reader may see it, not as its owner can.
		const projectThumbnails = await resolveProjectThumbnails(projectRows, {
			userId: user.id,
			seeAll: false,
		});
		// The names behind the saved posts' title mentions, one lookup for the Library.
		const savedPostDisplayTitles = await displayPostTitles(
			postRows.map((p) => p.title),
			user.id,
		);
		const savedPostTitleById = new Map(
			postRows.map((p, index) => [p.id, savedPostDisplayTitles[index] ?? p.title]),
		);

		// The channel-guide fields, for the work arm only: a creator's display name,
		// handle and avatar, so a lens that organizes the Library **by its creators** can
		// label channels without an N+1 of profile fetches on a Library-sized page. The
		// project arm has carried the same two fields since the album lens; a Work's own
		// serialization withholds them because nothing until now needed them wholesale.
		// Deliberately additive and route-local — a Work's public serialization is a
		// contract consumed everywhere, and this is the one listing that wants them.
		const creatorIds = [
			...new Set(workRows.map((w) => w.creatorId).filter((id): id is number => id != null)),
		];
		const creatorRows = creatorIds.length
			? await db
					.select({
						id: users.id,
						creatorHandle: users.atprotoHandle,
						creatorDisplayName: users.displayName,
						creatorAvatar: users.avatar,
					})
					.from(users)
					.where(inArray(users.id, creatorIds))
			: [];
		const creatorById = new Map(creatorRows.map((u) => [u.id, u]));

		return c.json({
			items: (
				await Promise.all(
					rows.map(async (row) => {
						const base = {
							id: row.id,
							hidden: row.hidden,
							sortOrder: row.sortOrder,
							savedAt: row.savedAt,
						};
						if (row.workId != null) {
							const w = workById.get(row.workId);
							if (!w) return null;
							const creator = w.creatorId != null ? creatorById.get(w.creatorId) : undefined;
							return {
								...base,
								kind: "work" as const,
								// Derived from `purchases` on every read, never stamped on the row —
								// so a refund releases the entry with nothing to keep in step.
								purchased: permanent.has(w.id),
								work: {
									...(await serializeWorkForUser(
										w,
										assetsByWork.get(w.id) ?? [],
										jobByWork.get(w.id) ?? null,
										resolveAccessSync(w as AccessibleWork, ctx),
										deliveryCtx(),
										spent,
										user.id,
										pagesByWork.get(w.id) ?? 0,
										sectionsByWork.get(w.id) ?? 0,
										(buildsByWork.get(w.id) ?? []).some((b) => b.isPrimary),
										(buildsByWork.get(w.id) ?? []).find((b) => b.isPrimary)?.requiresIsolation ??
											false,
									)),
									creatorHandle: creator?.creatorHandle ?? null,
									creatorDisplayName: creator?.creatorDisplayName ?? null,
									creatorAvatar: creator?.creatorAvatar ?? null,
									// The published Projects this Work belongs to, for a lens that
									// groups saved tracks into the release they came from. Empty
									// for a Work that stands on its own.
									releases: releasesByWork.get(w.id) ?? [],
								},
							};
						}
						if (row.postId != null) {
							const saved = postById.get(row.postId);
							if (!saved) return null;
							return {
								...base,
								kind: "post" as const,
								purchased: false,
								post: {
									id: saved.id,
									publicId: saved.publicId,
									slug: saved.slug,
									title: saved.title,
									displayTitle: savedPostTitleById.get(saved.id) ?? saved.title,
									excerpt: postContentExcerpt(saved.body),
									tags: saved.tags ?? [],
									isPublished: saved.isPublished === true,
									// A tombstoned creator leaves no name to show; the entry
									// still reads at its own URL, so the card says nothing
									// rather than inventing an author.
									creator: saved.creatorHandle
										? embedCreator({
												handle: saved.creatorHandle,
												displayName: saved.creatorDisplayName,
												avatar: saved.creatorAvatar,
											})
										: null,
								},
							};
						}
						const p = row.projectId != null ? projectById.get(row.projectId) : null;
						if (!p) return null;
						// A Project is a grouping, not a payload: it has no gates of its own and
						// nothing to withhold. Its members resolve their own access when opened.
						const counts = countsByProject.get(p.id);
						return {
							...base,
							kind: "project" as const,
							purchased: false,
							project: {
								...p,
								thumbnail: projectThumbnails.get(p.id) ?? p.thumbnail,
								trackCount: counts?.workCount ?? 0,
								// How many of those members are music. The music lens draws a
								// release card from this rather than from `trackCount`: a saved
								// Project that also holds a game still has a soundtrack worth
								// playing, and its card should advertise the tracks it has.
								musicCount: counts?.musicCount ?? 0,
								// The include-spoken dial widens a release to its audio members,
								// so the card can count the tracks the detail will show.
								audioCount: counts?.audioCount ?? 0,
							},
						};
					}),
				)
			).filter((x) => x != null),
			truncated,
			limit: LIBRARY_LIMIT,
		});
	})

	/** Save a Work, a Project or a Post. Idempotent, and un-hides one that was tidied away. */
	.post(
		"/library",
		requireAuth,
		zValidator(
			"json",
			z
				.object({
					workId: z.number().int().positive().optional(),
					projectId: z.number().int().positive().optional(),
					postId: z.number().int().positive().optional(),
				})
				// Exactly one — checked here rather than by a database constraint so the
				// error is a sentence instead of a 500.
				.refine((d) => [d.workId, d.projectId, d.postId].filter((v) => v != null).length === 1, {
					message: "Save one thing: a Work, a Project or a Post",
				}),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

			const result =
				data.workId != null
					? await saveWork(user.id, data.workId)
					: data.projectId != null
						? await saveProject(user.id, data.projectId)
						: await savePost(user.id, data.postId as number);

			if (!result.ok) {
				return c.json(
					{
						error:
							result.reason === "not_released" ? "That isn't released yet." : "That doesn't exist.",
					},
					404,
				);
			}
			queueReaderWrite(() => queueLibraryEntry(user.id, result.id));
			return c.json({ id: result.id }, 201);
		},
	)

	/**
	 * Tidy an entry out of the Library, or bring it back.
	 *
	 * Separate from DELETE on purpose: for a purchased Work this is the *only* control,
	 * and conflating the two would put "remove" on a button that must never remove.
	 */
	.patch(
		"/library/:id",
		requireAuth,
		zValidator("json", z.object({ hidden: z.boolean() })),
		async (c) => {
			const user = c.get("user");
			const id = parseNumericId(c.req.param("id"));
			if (id == null) return c.json({ error: "Not found" }, 404);
			const ok = await setHidden(user.id, id, c.req.valid("json").hidden);
			if (ok) queueReaderWrite(() => queueLibraryEntry(user.id, id));
			return ok ? c.json({ success: true }) : c.json({ error: "Not found" }, 404);
		},
	)

	/**
	 * Un-save.
	 *
	 * 🚨 **Refuses a purchased Work**, with `409` and the alternative named. Somebody who
	 * tidies a purchase out of their Library and cannot work out how to get it back has
	 * effectively lost the thing they paid for, so the control they get is *hide*, which
	 * is reversible and loses nothing.
	 */
	.delete("/library/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = parseNumericId(c.req.param("id"));
		if (id == null) return c.json({ error: "Not found" }, 404);

		const result = await removeItem(user.id, id);
		if (result.ok) {
			queueReaderWrite(() => queueLibraryRemoval(user.id, result.subject));
			return c.body(null, 204);
		}
		if (result.reason === "purchased") {
			return c.json(
				{
					error: "You bought this, so it stays in your Library. You can hide it instead.",
					reason: "purchased",
				},
				409,
			);
		}
		return c.json({ error: "Not found" }, 404);
	})

	// ── Reading positions ────────────────────────────────────────────────────────
	//
	// Where the caller got to in each Work — the Bookshelf rail's data and the
	// readers' cross-device resume, one row per account and Work. The access and
	// privacy reasoning is on the table itself (`user_reading_positions` in
	// `packages/db/src/schema/content.ts`) and in `services/reading-positions.ts`,
	// the one writer. Two doors, both the user's own rows:
	//
	// 🚨 **Only the caller's rows, ever.** No route here takes a user id or a share
	// link. The positions are the user's private consumption state, and they are
	// readable by exactly one person — the same rule that keeps a creator's
	// analytics estate away from them. The pointer's own validator sits at module
	// scope beside the other schemas.

	/**
	 * The caller's positions across every Work, newest-touched first.
	 *
	 * The list is the whole store, not a page of it: a user's positions number in the
	 * dozens (one per book-like Work they ever opened), and the rail filters, orders and
	 * joins them against the Library client-side.
	 */
	.get("/reading-positions", requireAuth, async (c) => {
		const user = c.get("user");
		const positions = await listPositions(user.id);
		return c.json({
			positions: positions.map((row) => ({
				workId: row.workId,
				progress: row.progress,
				position: row.position,
				updatedAt: row.updatedAt,
			})),
		});
	})

	/**
	 * Upsert the caller's position for one Work — the newest-write-wins write the
	 * readers make behind their local writes.
	 *
	 * The route carries the access check (the same shape `workSaves`' routes use): you
	 * record a position only in a Work you can reach, so a signed-in account cannot
	 * seed noise rows about Work it has no door to.
	 *
	 * ⚠️ No rate limiter joins these routes, deliberately: writes are upserts keyed on
	 * the caller's own (user, Work) pair — a user cannot mint more rows than they can
	 * reach Work for — and the client throttles pushes to one per few seconds. The
	 * limiter exists for doors a stranger can knock on; this one is inside the house.
	 */
	.put(
		"/reading-positions/:workId",
		requireAuth,
		zValidator(
			"json",
			z.object({ progress: z.number().finite(), position: positionPointerSchema }),
			invalidBody,
		),
		async (c) => {
			const user = c.get("user");
			// The param is whatever findWorkRow resolves — a bare id, a publicId, or the
			// slug-publicId form — because the route only needs the row, and the readers'
			// own callers name Works both ways.
			const work = await findWorkRow(c.req.param("workId") ?? "");
			if (!work) return c.json({ error: "Work not found" }, 404);

			const access = await workAccessFor(c, work);
			if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

			const { progress, position } = c.req.valid("json");
			const result = await upsertPosition(user.id, work.id, progress, position);
			if (!result.ok) {
				return c.json(
					{
						error:
							result.reason === "not_released" ? "That isn't released yet." : "That doesn't exist.",
					},
					404,
				);
			}

			queueReaderWrite(() => queuePosition(user.id, work.id));
			const row = await findPosition(user.id, work.id);
			return c.json({
				workId: row!.workId,
				progress: row!.progress,
				position: row!.position,
				updatedAt: row!.updatedAt,
			});
		},
	)

	/**
	 * Accept credit for a Work. The caller must be the credited person (any signed-in
	 * account). The acceptance record is written into the caller's own repository.
	 *
	 * ⚠️ The body goes through a validator rather than a raw `c.req.json()` read: the
	 * typed client derives what it may send from the route's schema, so a raw read leaves
	 * the front-end with a `$post` that refuses a `json` argument at compile time and the
	 * UI hand-rolling a fetch to work around its own client.
	 */
	.post(
		"/works/:id/credits/accept",
		requireAuth,
		zValidator("json", z.object({ role: z.string().min(1) }), invalidBody),
		async (c) => {
			const user = c.get("user");
			const workId = parseNumericId(c.req.param("id") ?? "");
			if (workId == null) return c.json({ error: "Work not found" }, 404);

			const role = c.req.valid("json").role;
			if (!role.trim()) return c.json({ error: "A role is required.", code: "role_required" }, 400);

			const [work] = await db
				.select({ atprotoUri: works.atprotoUri })
				.from(works)
				.where(eq(works.id, workId))
				.limit(1);
			if (!work?.atprotoUri) {
				return c.json(
					{ error: "This Work has no public listing to accept credit for.", code: "no_listing" },
					404,
				);
			}

			const [account] = await db
				.select({ did: users.atprotoDid })
				.from(users)
				.where(eq(users.id, user.id))
				.limit(1);
			if (!account?.did) {
				return c.json(
					{ error: "This account has no identity to accept credit with.", code: "no_identity" },
					400,
				);
			}

			// 🚨 **Refused before anything is recorded**, like every other user-record path (a
			// comment, a review, a vote, a follow). The acceptance IS a record in the caller's own
			// repository, so an identity Anthers cannot write for has not accepted anything yet —
			// recording the row first and failing after left a row saying accepted beside a record
			// that never existed, and the retry answered `already_accepted` for ever.
			const unwritable = await interactionPermissionRefusal(user.id);
			if (unwritable) return c.json(unwritable.body, unwritable.status);

			const result = await acceptCredit({
				callerUserId: user.id,
				callerDid: account.did,
				workId,
				workUri: work.atprotoUri,
				role,
			});

			if (!result.ok) {
				const message =
					result.code === "not_credited"
						? "You are not credited on this Work with that role."
						: result.code === "already_accepted"
							? "You already accepted this credit."
							: result.code === "rejected"
								? "You rejected this credit, so you cannot accept it."
								: result.code === "no_identity"
									? "This account has no identity to accept credit with."
									: "Anthers needs your permission to write the acceptance record in your repository.";
				return c.json({ error: message, code: result.code }, 400);
			}

			return c.json({ accepted: true, atprotoUri: result.atprotoUri });
		},
	)

	/**
	 * Reject credit for a Work. The caller must be the credited person (any signed-in
	 * account). Rejection removes the credit from the Work and blocks re-adding it.
	 *
	 * ⚠️ Validator rather than a raw `c.req.json()` read, for the same reason as the accept
	 * route beside this: the typed client sends what the route's schema says it may.
	 */
	.post(
		"/works/:id/credits/reject",
		requireAuth,
		zValidator("json", z.object({ role: z.string().min(1) }), invalidBody),
		async (c) => {
			const user = c.get("user");
			const workId = parseNumericId(c.req.param("id") ?? "");
			if (workId == null) return c.json({ error: "Work not found" }, 404);

			const role = c.req.valid("json").role;
			if (!role.trim()) return c.json({ error: "A role is required.", code: "role_required" }, 400);

			const [account] = await db
				.select({ did: users.atprotoDid })
				.from(users)
				.where(eq(users.id, user.id))
				.limit(1);
			if (!account?.did) {
				return c.json(
					{ error: "This account has no identity to reject credit with.", code: "no_identity" },
					400,
				);
			}

			const result = await rejectCredit({
				callerUserId: user.id,
				callerDid: account.did,
				workId,
				role,
			});

			if (!result.ok) {
				const message =
					result.code === "not_credited"
						? "You are not credited on this Work with that role."
						: "You already rejected this credit.";
				return c.json({ error: message, code: result.code }, 400);
			}

			return c.json({ rejected: true });
		},
	);

export { libraryRoutes };

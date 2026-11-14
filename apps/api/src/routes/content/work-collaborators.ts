// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's other owners: invitations, acceptance, leaving, and the publisher handover.
 *
 * The shape is the Badge's collaboration surface, applied to the harder object. The Work
 * stays one row; `works.creatorId` is the publisher, and `work_collaborators` holds the
 * accepted co-owners. Every owner edits, each removes only themselves, earnings split
 * evenly, and the publisher role moves by a two-step consent.
 *
 * 🚨 **A pending invitation is not ownership.** The Work stays on the publisher's profile
 * and in their Studio until the invitee accepts; acceptance is a database fact, not an
 * ATProto record, because ownership and money are org-side.
 */
import { db } from "@anthers/db/client";
import {
	purchases,
	users,
	workAssets,
	workCollaborators,
	workPublisherHandovers,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { notSuspendedAccount } from "../../services/account-visibility.js";
import { notBlockedBy } from "../../services/blocks.js";
import { removeCreatorSpace } from "../../services/creator-space.js";
import { purgeWorkMedia } from "../../services/media-purge.js";
import { notify } from "../../services/notifications.js";
import { isWorkOwner, isWorkPublisher } from "../../services/work-owners.js";
import { moveWorkPublisher, removeWorkListing } from "../../services/work-publisher.js";

/** The URL a Work lives at, for a notification that should land on the object. */
function workPath(work: { slug: string; publicId: number }): string {
	return `/works/${work.slug}-${work.publicId}`;
}

/** The display fields every collaborator row returns. */
const personFields = {
	id: users.id,
	did: users.atprotoDid,
	handle: users.atprotoHandle,
	displayName: users.displayName,
	avatar: users.avatar,
};

export const workCollaboratorRoutes = new Hono()
	// ── Invitations ───────────────────────────────────────────────────────────

	.post(
		"/works/:id/collaborators",
		requireAuth,
		zValidator("json", z.object({ did: z.string().min(1).max(2048) }).strict()),
		async (c) => {
			const user = c.get("user");
			const workId = Number(c.req.param("id"));
			const { did } = c.req.valid("json");

			if (!(await isWorkOwner(workId, user.id))) {
				return c.json({ error: "Work not found" }, 404);
			}
			const [work] = await db
				.select({
					id: works.id,
					slug: works.slug,
					publicId: works.publicId,
					title: works.title,
				})
				.from(works)
				.where(eq(works.id, workId))
				.limit(1);
			if (!work) return c.json({ error: "Work not found" }, 404);

			const [target] = await db
				.select({
					id: users.id,
					handle: users.atprotoHandle,
					displayName: users.displayName,
					creatorMode: users.creatorMode,
				})
				.from(users)
				.where(
					and(
						eq(users.atprotoDid, did),
						notSuspendedAccount(users.id),
						notBlockedBy(user.id, users.id),
					),
				)
				.limit(1);
			if (!target) return c.json({ error: "That account cannot be invited." }, 404);
			if (target.id === user.id) return c.json({ error: "You already own this Work." }, 400);
			if (!target.creatorMode) {
				return c.json({ error: "That account is not a creator yet." }, 400);
			}

			const [existing] = await db
				.select()
				.from(workCollaborators)
				.where(
					and(eq(workCollaborators.workId, workId), eq(workCollaborators.creatorId, target.id)),
				)
				.limit(1);
			if (existing?.status === "accepted") {
				return c.json({ error: "That creator already owns this Work." }, 409);
			}
			if (existing?.status === "pending") {
				return c.json({ error: "That creator has already been invited." }, 409);
			}

			const [row] = existing
				? await db
						.update(workCollaborators)
						.set({
							status: "pending",
							invitedById: user.id,
							respondedAt: null,
							createdAt: new Date(),
						})
						.where(eq(workCollaborators.id, existing.id))
						.returning()
				: await db
						.insert(workCollaborators)
						.values({
							workId,
							creatorId: target.id,
							invitedById: user.id,
							status: "pending",
						})
						.returning();

			await notify({
				userId: target.id,
				category: "activity",
				kind: "work_collab_invite",
				title: `${user.displayName || user.handle} invited you to co-own ${work.title || "a Work"}`,
				body: "Both of you can edit it, each of you can leave, and its earnings are split evenly.",
				linkPath: "/studio/settings?tab=collabs",
				dedupeKey: `work-collab-invite:${workId}:${target.id}:${row.createdAt.getTime()}`,
			});

			return c.json(
				{
					collaborator: {
						id: row.id,
						creatorId: target.id,
						status: row.status,
						handle: target.handle,
						displayName: target.displayName,
					},
				},
				201,
			);
		},
	)

	.get("/works/:id/collaborators", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));

		if (!(await isWorkOwner(workId, user.id))) {
			return c.json({ error: "Work not found" }, 404);
		}
		const [work] = await db
			.select({
				creatorId: works.creatorId,
				title: works.title,
				slug: works.slug,
				publicId: works.publicId,
			})
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		if (!work || work.creatorId == null) return c.json({ error: "Work not found" }, 404);

		const [publisher] = await db
			.select(personFields)
			.from(users)
			.where(eq(users.id, work.creatorId))
			.limit(1);
		const collaborators = await db
			.select({
				rowId: workCollaborators.id,
				creatorId: workCollaborators.creatorId,
				status: workCollaborators.status,
				createdAt: workCollaborators.createdAt,
				did: users.atprotoDid,
				handle: users.atprotoHandle,
				displayName: users.displayName,
				avatar: users.avatar,
			})
			.from(workCollaborators)
			.innerJoin(users, eq(users.id, workCollaborators.creatorId))
			.where(eq(workCollaborators.workId, workId))
			.orderBy(workCollaborators.createdAt, workCollaborators.id);

		const [handover] = await db
			.select({
				id: workPublisherHandovers.id,
				toCreatorId: workPublisherHandovers.toCreatorId,
				createdAt: workPublisherHandovers.createdAt,
				handle: users.atprotoHandle,
				displayName: users.displayName,
			})
			.from(workPublisherHandovers)
			.innerJoin(users, eq(users.id, workPublisherHandovers.toCreatorId))
			.where(
				and(
					eq(workPublisherHandovers.workId, workId),
					eq(workPublisherHandovers.status, "pending"),
				),
			)
			.limit(1);

		return c.json({
			work,
			publisher: publisher
				? {
						id: publisher.id,
						did: publisher.did,
						handle: publisher.handle,
						displayName: publisher.displayName,
						avatar: publisher.avatar || null,
					}
				: null,
			collaborators: collaborators.map((row) => ({
				id: row.rowId,
				creatorId: row.creatorId,
				status: row.status,
				createdAt: row.createdAt,
				did: row.did,
				handle: row.handle,
				displayName: row.displayName,
				avatar: row.avatar || null,
			})),
			pendingHandover: handover ?? null,
		});
	})

	.post("/works/:id/collaborators/accept", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));

		const [row] = await db
			.select({ id: workCollaborators.id, invitedById: workCollaborators.invitedById })
			.from(workCollaborators)
			.where(
				and(
					eq(workCollaborators.workId, workId),
					eq(workCollaborators.creatorId, user.id),
					eq(workCollaborators.status, "pending"),
				),
			)
			.limit(1);
		if (!row) return c.json({ error: "Invitation not found" }, 404);

		await db
			.update(workCollaborators)
			.set({ status: "accepted", respondedAt: new Date() })
			.where(eq(workCollaborators.id, row.id));

		const [work] = await db
			.select({ title: works.title, slug: works.slug, publicId: works.publicId })
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		if (row.invitedById && work) {
			await notify({
				userId: row.invitedById,
				category: "activity",
				kind: "work_collab_accepted",
				title: `${user.displayName || user.handle} accepted your Work collaboration`,
				body: "The Work now appears in both of your Studios and on both profiles, and its earnings are split evenly.",
				linkPath: workPath(work),
				dedupeKey: `work-collab-accepted:${row.id}`,
			});
		}

		return c.json({ accepted: true });
	})

	.post("/works/:id/collaborators/decline", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));

		const [row] = await db
			.select({ id: workCollaborators.id, invitedById: workCollaborators.invitedById })
			.from(workCollaborators)
			.where(
				and(
					eq(workCollaborators.workId, workId),
					eq(workCollaborators.creatorId, user.id),
					eq(workCollaborators.status, "pending"),
				),
			)
			.limit(1);
		if (!row) return c.json({ error: "Invitation not found" }, 404);

		await db
			.update(workCollaborators)
			.set({ status: "declined", respondedAt: new Date() })
			.where(eq(workCollaborators.id, row.id));

		if (row.invitedById) {
			await notify({
				userId: row.invitedById,
				category: "activity",
				kind: "work_collab_declined",
				title: `${user.displayName || user.handle} declined the Work collaboration`,
				body: "The Work stays with its current owners. You can send another invitation later.",
				linkPath: "/studio/settings?tab=collabs",
				dedupeKey: `work-collab-declined:${row.id}:${Date.now()}`,
			});
		}

		return c.json({ declined: true });
	})

	/**
	 * Remove a collaborator, or leave.
	 *
	 * A pending invitation is withdrawn or declined; an accepted row can be removed only by
	 * the creator it names. The publisher leaving hands the role to the oldest accepted
	 * collaborator, or deletes the Work when nobody is left and the existing purchase and
	 * preservation refusals permit it.
	 */
	.delete("/works/:id/collaborators/:creatorId", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		const creatorId = Number(c.req.param("creatorId"));

		const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);
		if (!(await isWorkOwner(workId, user.id))) return c.json({ error: "Work not found" }, 404);

		const [row] = await db
			.select()
			.from(workCollaborators)
			.where(and(eq(workCollaborators.workId, workId), eq(workCollaborators.creatorId, creatorId)))
			.limit(1);
		// The publisher has no collaborator row — the anchor is the row — but leaving is
		// still theirs to do. Every other creator must have a row to remove.
		const leavingPublisher = work.creatorId === creatorId && creatorId === user.id;
		if (!row && !leavingPublisher) return c.json({ error: "Collaborator not found" }, 404);

		if (row?.status === "pending") {
			await db
				.update(workCollaborators)
				.set({ status: "declined", respondedAt: new Date() })
				.where(eq(workCollaborators.id, row.id));
			return c.body(null, 204);
		}

		if (creatorId !== user.id) {
			return c.json({ error: "Each creator can only remove themselves." }, 403);
		}

		if (work.creatorId !== user.id) {
			if (!row) return c.json({ error: "Collaborator not found" }, 404);
			await db.delete(workCollaborators).where(eq(workCollaborators.id, row.id));
			return c.body(null, 204);
		}

		// The publisher is leaving. Hand the role to the oldest accepted collaborator.
		const [next] = await db
			.select({ id: workCollaborators.id, creatorId: workCollaborators.creatorId })
			.from(workCollaborators)
			.where(
				and(
					eq(workCollaborators.workId, workId),
					eq(workCollaborators.status, "accepted"),
					ne(workCollaborators.creatorId, user.id),
				),
			)
			.orderBy(workCollaborators.createdAt, workCollaborators.id)
			.limit(1);

		if (next) {
			await moveWorkPublisher(workId, user.id, next.creatorId, { keepOldPublisher: false });
			return c.body(null, 204);
		}

		// This was the last owner. The existing delete rules decide whether the Work may go:
		// a sold Work is withdrawn rather than destroyed, and a preserved Work is a reader's
		// Library entry. Both are the Studio delete's business, not a collaboration leave's.
		const [sold] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(purchases)
			.where(and(eq(purchases.workId, workId), eq(purchases.status, "completed")));
		const soldCount = Number(sold?.count ?? 0);
		if (soldCount > 0) {
			return c.json(
				{
					error:
						soldCount === 1
							? "This Work has a buyer. Hand it over, or delete it from the Studio to withdraw it."
							: `This Work has ${soldCount} buyers. Hand it over, or delete it from the Studio to withdraw it.`,
					code: "work_has_buyers",
				},
				409,
			);
		}
		if (work.preserved) {
			return c.json(
				{
					error: "This Work is in a reader's Library. Delete it from the Studio to withdraw it.",
					code: "work_preserved",
				},
				409,
			);
		}

		await removeWorkListing(work);
		const [assetRows, jobRows] = await Promise.all([
			db.select().from(workAssets).where(eq(workAssets.workId, workId)),
			db.select().from(workTranscodingJobs).where(eq(workTranscodingJobs.workId, workId)),
		]);
		await purgeWorkMedia(work, assetRows, jobRows);
		await removeCreatorSpace(work).catch((error) => {
			console.error(`[work-collaborators] creator-space cleanup failed for Work ${workId}:`, error);
		});
		await db.delete(works).where(eq(works.id, workId));
		return c.body(null, 204);
	})

	// ── Publisher handover ─────────────────────────────────────────────────────

	.post(
		"/works/:id/publisher",
		requireAuth,
		zValidator("json", z.object({ creatorId: z.number().int().positive() }).strict()),
		async (c) => {
			const user = c.get("user");
			const workId = Number(c.req.param("id"));
			const { creatorId } = c.req.valid("json");

			if (!(await isWorkPublisher(workId, user.id))) {
				return c.json({ error: "Work not found" }, 404);
			}
			if (creatorId === user.id) {
				return c.json({ error: "You are already the publisher." }, 400);
			}
			const [row] = await db
				.select({ id: workCollaborators.id })
				.from(workCollaborators)
				.where(
					and(
						eq(workCollaborators.workId, workId),
						eq(workCollaborators.creatorId, creatorId),
						eq(workCollaborators.status, "accepted"),
					),
				)
				.limit(1);
			if (!row) {
				return c.json({ error: "That creator is not an accepted owner of this Work." }, 400);
			}
			const [open] = await db
				.select({ id: workPublisherHandovers.id })
				.from(workPublisherHandovers)
				.where(
					and(
						eq(workPublisherHandovers.workId, workId),
						eq(workPublisherHandovers.status, "pending"),
					),
				)
				.limit(1);
			if (open) return c.json({ error: "A publisher change is already waiting." }, 409);

			const [work] = await db
				.select({ title: works.title, slug: works.slug, publicId: works.publicId })
				.from(works)
				.where(eq(works.id, workId))
				.limit(1);
			if (!work) return c.json({ error: "Work not found" }, 404);

			const [handover] = await db
				.insert(workPublisherHandovers)
				.values({
					workId,
					fromCreatorId: user.id,
					toCreatorId: creatorId,
					status: "pending",
				})
				.returning();

			await notify({
				userId: creatorId,
				category: "activity",
				kind: "work_publisher_handover",
				title: `${user.displayName || user.handle} wants to make you the publisher of ${work.title || "a Work"}`,
				body: "The publisher holds the Work's listing home. Your share, editing rights and the split do not change.",
				linkPath: "/studio/settings?tab=collabs",
				dedupeKey: `work-publisher-handover:${handover.id}`,
			});

			return c.json(
				{
					handover: {
						id: handover.id,
						toCreatorId: creatorId,
						status: handover.status,
					},
				},
				201,
			);
		},
	)

	.post("/works/:id/publisher/accept", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));

		const [handover] = await db
			.select()
			.from(workPublisherHandovers)
			.where(
				and(
					eq(workPublisherHandovers.workId, workId),
					eq(workPublisherHandovers.toCreatorId, user.id),
					eq(workPublisherHandovers.status, "pending"),
				),
			)
			.limit(1);
		if (!handover) return c.json({ error: "Publisher change not found" }, 404);

		const [targetRow] = await db
			.select({ id: workCollaborators.id })
			.from(workCollaborators)
			.where(
				and(
					eq(workCollaborators.workId, workId),
					eq(workCollaborators.creatorId, user.id),
					eq(workCollaborators.status, "accepted"),
				),
			)
			.limit(1);
		if (!targetRow) {
			return c.json({ error: "You are not an accepted owner of this Work." }, 400);
		}

		const [work] = await db
			.select({ title: works.title, slug: works.slug, publicId: works.publicId })
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		await moveWorkPublisher(workId, handover.fromCreatorId, user.id, {
			keepOldPublisher: true,
		});
		await db
			.update(workPublisherHandovers)
			.set({ status: "accepted", respondedAt: new Date() })
			.where(eq(workPublisherHandovers.id, handover.id));

		await notify({
			userId: handover.fromCreatorId,
			category: "activity",
			kind: "work_publisher_handover_accepted",
			title: `${user.displayName || user.handle} accepted the publisher role for ${work.title || "a Work"}`,
			body: "The Work's listing home has moved. Ownership, editing and the split are unchanged.",
			linkPath: workPath(work),
			dedupeKey: `work-publisher-handover-accepted:${handover.id}`,
		});

		return c.json({ publisher: { id: user.id } });
	})

	.post("/works/:id/publisher/decline", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));

		const [handover] = await db
			.select()
			.from(workPublisherHandovers)
			.where(
				and(
					eq(workPublisherHandovers.workId, workId),
					eq(workPublisherHandovers.toCreatorId, user.id),
					eq(workPublisherHandovers.status, "pending"),
				),
			)
			.limit(1);
		if (!handover) return c.json({ error: "Publisher change not found" }, 404);

		await db
			.update(workPublisherHandovers)
			.set({ status: "declined", respondedAt: new Date() })
			.where(eq(workPublisherHandovers.id, handover.id));
		await notify({
			userId: handover.fromCreatorId,
			category: "activity",
			kind: "work_publisher_handover_declined",
			title: `${user.displayName || user.handle} declined the publisher role`,
			body: "The Work stays as it is. Ownership, editing and the split are unchanged.",
			linkPath: "/studio/settings?tab=collabs",
			dedupeKey: `work-publisher-handover-declined:${handover.id}`,
		});
		return c.json({ declined: true });
	})

	.delete("/works/:id/publisher", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("id"));
		if (!(await isWorkPublisher(workId, user.id))) {
			return c.json({ error: "Work not found" }, 404);
		}
		await db
			.update(workPublisherHandovers)
			.set({ status: "canceled", respondedAt: new Date() })
			.where(
				and(
					eq(workPublisherHandovers.workId, workId),
					eq(workPublisherHandovers.status, "pending"),
				),
			);
		return c.body(null, 204);
	})

	// ── The invitee's list ─────────────────────────────────────────────────────

	.get("/work-collaborations", requireAuth, async (c) => {
		const user = c.get("user");
		const invites = await db
			.select({
				id: workCollaborators.id,
				createdAt: workCollaborators.createdAt,
				workId: works.id,
				slug: works.slug,
				publicId: works.publicId,
				title: works.title,
				thumbnail: works.thumbnail,
				type: works.type,
				inviterHandle: users.atprotoHandle,
				inviterDisplayName: users.displayName,
			})
			.from(workCollaborators)
			.innerJoin(works, eq(works.id, workCollaborators.workId))
			.innerJoin(users, eq(users.id, workCollaborators.invitedById))
			.where(and(eq(workCollaborators.creatorId, user.id), eq(workCollaborators.status, "pending")))
			.orderBy(workCollaborators.createdAt, workCollaborators.id);

		const handovers = await db
			.select({
				id: workPublisherHandovers.id,
				createdAt: workPublisherHandovers.createdAt,
				workId: works.id,
				slug: works.slug,
				publicId: works.publicId,
				title: works.title,
				thumbnail: works.thumbnail,
				type: works.type,
				fromHandle: users.atprotoHandle,
				fromDisplayName: users.displayName,
			})
			.from(workPublisherHandovers)
			.innerJoin(works, eq(works.id, workPublisherHandovers.workId))
			.innerJoin(users, eq(users.id, workPublisherHandovers.fromCreatorId))
			.where(
				and(
					eq(workPublisherHandovers.toCreatorId, user.id),
					eq(workPublisherHandovers.status, "pending"),
				),
			)
			.orderBy(workPublisherHandovers.createdAt, workPublisherHandovers.id);

		return c.json({
			invites: invites.map((row) => ({
				id: row.id,
				createdAt: row.createdAt,
				work: {
					id: row.workId,
					slug: row.slug,
					publicId: row.publicId,
					title: row.title,
					thumbnail: row.thumbnail,
					type: row.type,
				},
				inviter: { handle: row.inviterHandle, displayName: row.inviterDisplayName },
			})),
			handovers: handovers.map((row) => ({
				id: row.id,
				createdAt: row.createdAt,
				work: {
					id: row.workId,
					slug: row.slug,
					publicId: row.publicId,
					title: row.title,
					thumbnail: row.thumbnail,
					type: row.type,
				},
				from: { handle: row.fromHandle, displayName: row.fromDisplayName },
			})),
		});
	});

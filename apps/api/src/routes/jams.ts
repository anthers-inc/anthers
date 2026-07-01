// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Game Jam routes — CRUD, entries, votes, results.
 */

import { db } from "@anthers/db/client";
import { gameJams, jamEntries, jamVotes, projects, users } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireCreator } from "../middleware/auth.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createJamSchema = z.object({
	title: z.string().min(1).max(255),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/),
	description: z.string().max(50000).optional().default(""),
	theme: z.string().max(255).optional().default(""),
	coverImage: z.string().max(500).optional().default(""),
	startAt: z.string().datetime(),
	endAt: z.string().datetime(),
	votingEndAt: z.string().datetime(),
	maxTeamSize: z.number().int().min(0).optional().default(0),
	allowLateSubmissions: z.boolean().optional().default(false),
});

const updateJamSchema = createJamSchema.partial();

// ─── Routes ──────────────────────────────────────────────────────────────────

const jamRoutes = new Hono()
	// ── List / Create ────────────────────────────────────────────────────────
	.get("/", async (c) => {
		const status = c.req.query("status");
		const now = new Date();

		const conditions: any[] = [];

		if (status === "upcoming") {
			conditions.push(gt(gameJams.startAt, now));
		} else if (status === "active") {
			conditions.push(lte(gameJams.startAt, now));
			conditions.push(gte(gameJams.endAt, now));
		} else if (status === "voting") {
			conditions.push(lt(gameJams.endAt, now));
			conditions.push(gte(gameJams.votingEndAt, now));
		} else if (status === "ended") {
			conditions.push(lt(gameJams.votingEndAt, now));
		}

		const result = await db
			.select({
				jam: gameJams,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				entryCount: sql<number>`(SELECT count(*)::int FROM jam_entries WHERE jam_id = ${gameJams.id})`,
			})
			.from(gameJams)
			.innerJoin(users, eq(gameJams.creatorId, users.id))
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(gameJams.startAt));

		return c.json({
			jams: result.map((r) => ({
				...r.jam,
				creator: {
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
				},
				entryCount: Number(r.entryCount),
			})),
		});
	})

	.post("/", requireAuth, requireCreator, zValidator("json", createJamSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// Check slug uniqueness
		const [existing] = await db
			.select({ id: gameJams.id })
			.from(gameJams)
			.where(eq(gameJams.slug, data.slug))
			.limit(1);

		if (existing) return c.json({ error: "Slug already taken" }, 409);

		const [jam] = await db
			.insert(gameJams)
			.values({
				creatorId: user.id,
				...data,
				startAt: new Date(data.startAt),
				endAt: new Date(data.endAt),
				votingEndAt: new Date(data.votingEndAt),
			})
			.returning();

		return c.json({ jam }, 201);
	})

	// ── Detail / Update / Delete ─────────────────────────────────────────────
	.get("/:slug", async (c) => {
		const { slug } = c.req.param();

		const result = await db
			.select({
				jam: gameJams,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
			})
			.from(gameJams)
			.innerJoin(users, eq(gameJams.creatorId, users.id))
			.where(eq(gameJams.slug, slug))
			.limit(1);

		if (result.length === 0) return c.json({ error: "Jam not found" }, 404);

		const row = result[0];
		return c.json({
			jam: {
				...row.jam,
				creator: {
					username: row.creatorUsername,
					displayName: row.creatorDisplayName,
				},
			},
		});
	})

	.patch("/:slug", requireAuth, zValidator("json", updateJamSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const data = c.req.valid("json");

		const [existing] = await db
			.select({ id: gameJams.id, creatorId: gameJams.creatorId })
			.from(gameJams)
			.where(eq(gameJams.slug, slug))
			.limit(1);

		if (!existing) return c.json({ error: "Jam not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		const updates: Record<string, any> = { ...data, updatedAt: new Date() };
		if (data.startAt) updates.startAt = new Date(data.startAt);
		if (data.endAt) updates.endAt = new Date(data.endAt);
		if (data.votingEndAt) updates.votingEndAt = new Date(data.votingEndAt);

		const [updated] = await db
			.update(gameJams)
			.set(updates)
			.where(eq(gameJams.id, existing.id))
			.returning();

		return c.json({ jam: updated });
	})

	.delete("/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const deleted = await db
			.delete(gameJams)
			.where(and(eq(gameJams.slug, slug), eq(gameJams.creatorId, user.id)))
			.returning({ id: gameJams.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	// ── Entries ──────────────────────────────────────────────────────────────
	.get("/:slug/entries", async (c) => {
		const { slug } = c.req.param();

		const [jam] = await db
			.select({ id: gameJams.id })
			.from(gameJams)
			.where(eq(gameJams.slug, slug))
			.limit(1);

		if (!jam) return c.json({ error: "Jam not found" }, 404);

		const entries = await db
			.select({
				entry: jamEntries,
				projectTitle: projects.title,
				projectSlug: projects.slug,
				projectCoverImage: projects.coverImage,
				submitterUsername: users.username,
			})
			.from(jamEntries)
			.innerJoin(projects, eq(jamEntries.projectId, projects.id))
			.innerJoin(users, eq(jamEntries.submittedById, users.id))
			.where(eq(jamEntries.jamId, jam.id))
			.orderBy(desc(jamEntries.createdAt));

		return c.json({
			entries: entries.map((r) => ({
				...r.entry,
				project: {
					title: r.projectTitle,
					slug: r.projectSlug,
					coverImage: r.projectCoverImage,
				},
				submitter: { username: r.submitterUsername },
			})),
		});
	})

	.post(
		"/:slug/entries",
		requireAuth,
		zValidator("json", z.object({ projectId: z.number().int() })),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();
			const { projectId } = c.req.valid("json");

			const [jam] = await db.select().from(gameJams).where(eq(gameJams.slug, slug)).limit(1);

			if (!jam) return c.json({ error: "Jam not found" }, 404);

			// Check jam is active (between start and end)
			const now = new Date();
			if (now < jam.startAt) return c.json({ error: "Jam has not started yet" }, 400);
			if (now > jam.endAt && !jam.allowLateSubmissions) {
				return c.json({ error: "Jam submission period has ended" }, 400);
			}

			// Verify project ownership and published status
			const [project] = await db
				.select({ id: projects.id, isPublished: projects.isPublished })
				.from(projects)
				.where(and(eq(projects.id, projectId), eq(projects.creatorId, user.id)))
				.limit(1);

			if (!project) return c.json({ error: "Project not found or not owned by you" }, 404);
			if (!project.isPublished) return c.json({ error: "Project must be published" }, 400);

			// Submit entry (unique constraint handles duplicates)
			try {
				const [entry] = await db
					.insert(jamEntries)
					.values({ jamId: jam.id, projectId, submittedById: user.id })
					.returning();

				return c.json({ entry }, 201);
			} catch {
				return c.json({ error: "Project already submitted to this jam" }, 409);
			}
		},
	)

	// ── Votes ────────────────────────────────────────────────────────────────
	.post(
		"/:slug/entries/:entryId/vote",
		requireAuth,
		zValidator("json", z.object({ score: z.number().int().min(1).max(5) })),
		async (c) => {
			const user = c.get("user");
			const { slug, entryId } = c.req.param();
			const { score } = c.req.valid("json");

			const [jam] = await db.select().from(gameJams).where(eq(gameJams.slug, slug)).limit(1);

			if (!jam) return c.json({ error: "Jam not found" }, 404);

			// Check voting period
			const now = new Date();
			if (now < jam.endAt) return c.json({ error: "Voting has not started" }, 400);
			if (now > jam.votingEndAt) return c.json({ error: "Voting period has ended" }, 400);

			// Get the entry
			const [entry] = await db
				.select()
				.from(jamEntries)
				.where(and(eq(jamEntries.id, Number(entryId)), eq(jamEntries.jamId, jam.id)))
				.limit(1);

			if (!entry) return c.json({ error: "Entry not found" }, 404);

			// Can't vote on own entry
			if (entry.submittedById === user.id) {
				return c.json({ error: "Cannot vote on your own entry" }, 400);
			}

			// Upsert vote
			const [vote] = await db
				.insert(jamVotes)
				.values({ entryId: entry.id, userId: user.id, score })
				.onConflictDoUpdate({
					target: [jamVotes.entryId, jamVotes.userId],
					set: { score },
				})
				.returning();

			return c.json({ vote }, 201);
		},
	)

	// ── Results ──────────────────────────────────────────────────────────────
	.get("/:slug/results", async (c) => {
		const { slug } = c.req.param();

		const [jam] = await db.select().from(gameJams).where(eq(gameJams.slug, slug)).limit(1);

		if (!jam) return c.json({ error: "Jam not found" }, 404);

		// Only show results after voting ends
		if (new Date() < jam.votingEndAt) {
			return c.json({ error: "Results not available until voting ends" }, 400);
		}

		const entries = await db
			.select({
				entry: jamEntries,
				projectTitle: projects.title,
				projectSlug: projects.slug,
				projectCoverImage: projects.coverImage,
				submitterUsername: users.username,
				avgScore: sql<number>`COALESCE(AVG(${jamVotes.score}), 0)::float`,
				voteCount: sql<number>`COUNT(${jamVotes.id})::int`,
			})
			.from(jamEntries)
			.innerJoin(projects, eq(jamEntries.projectId, projects.id))
			.innerJoin(users, eq(jamEntries.submittedById, users.id))
			.leftJoin(jamVotes, eq(jamVotes.entryId, jamEntries.id))
			.where(eq(jamEntries.jamId, jam.id))
			.groupBy(jamEntries.id, projects.title, projects.slug, projects.coverImage, users.username)
			.orderBy(desc(sql`COALESCE(AVG(${jamVotes.score}), 0)`));

		return c.json({
			jam,
			results: entries.map((r, index) => ({
				rank: index + 1,
				...r.entry,
				project: {
					title: r.projectTitle,
					slug: r.projectSlug,
					coverImage: r.projectCoverImage,
				},
				submitter: { username: r.submitterUsername },
				avgScore: Number(Number(r.avgScore).toFixed(2)),
				voteCount: Number(r.voteCount),
			})),
		});
	});

export { jamRoutes };

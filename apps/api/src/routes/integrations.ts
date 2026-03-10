/**
 * Integration routes — analytics, platform connections, cross-publish,
 * itch.io import.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import { db } from "@anthers/db/client";
import {
	users,
	projects,
	posts,
	attentionEvents,
	platformConnections,
	crossPublishResults,
	externalMetricSnapshots,
} from "@anthers/db/schema";
import { requireAuth } from "../middleware/auth.js";
import { boss, QUEUES, JOB_OPTIONS } from "../jobs/boss.js";

// ─── Routes ──────────────────────────────────────────────────────────────────

const integrationRoutes = new Hono()
	// ══════════════════════════════════════════════════════════════════════════
	// ANALYTICS
	// ══════════════════════════════════════════════════════════════════════════

	.get("/analytics/overview", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		const [overview] = await db
			.select({
				totalEvents: sql<number>`COUNT(*)`,
				totalDuration: sql<number>`COALESCE(SUM(duration_seconds), 0)`,
				uniqueViewers: sql<number>`COUNT(DISTINCT user_id)`,
				views: sql<number>`COUNT(*) FILTER (WHERE event_type = 'page_view')`,
				plays: sql<number>`COUNT(*) FILTER (WHERE event_type = 'play')`,
				watches: sql<number>`COUNT(*) FILTER (WHERE event_type = 'watch')`,
				reads: sql<number>`COUNT(*) FILTER (WHERE event_type = 'read')`,
				listens: sql<number>`COUNT(*) FILTER (WHERE event_type = 'listen')`,
			})
			.from(attentionEvents)
			.where(
				and(
					eq(attentionEvents.creatorId, user.id),
					gte(attentionEvents.createdAt, since),
				),
			);

		// Content counts
		const [projectCount] = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(projects)
			.where(eq(projects.creatorId, user.id));

		const [postCount] = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(posts)
			.where(eq(posts.creatorId, user.id));

		// Cross-publish stats
		const [publishCount] = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(crossPublishResults)
			.where(eq(crossPublishResults.userId, user.id));

		return c.json({
			period,
			events: {
				total: Number(overview.totalEvents),
				views: Number(overview.views),
				plays: Number(overview.plays),
				watches: Number(overview.watches),
				reads: Number(overview.reads),
				listens: Number(overview.listens),
			},
			totalDurationHours: Number((Number(overview.totalDuration) / 3600).toFixed(2)),
			uniqueViewers: Number(overview.uniqueViewers),
			contentCounts: {
				projects: Number(projectCount.count),
				posts: Number(postCount.count),
			},
			crossPublishCount: Number(publishCount.count),
		});
	})

	.get("/analytics/content", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const type = c.req.query("type") ?? "all";
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		const result: any[] = [];

		if (type === "all" || type === "projects") {
			const projectStats = await db
				.select({
					projectId: attentionEvents.projectId,
					projectTitle: projects.title,
					projectSlug: projects.slug,
					eventCount: sql<number>`COUNT(*)`,
					totalDuration: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)`,
				})
				.from(attentionEvents)
				.innerJoin(projects, eq(attentionEvents.projectId, projects.id))
				.where(
					and(
						eq(attentionEvents.creatorId, user.id),
						gte(attentionEvents.createdAt, since),
						sql`${attentionEvents.projectId} IS NOT NULL`,
					),
				)
				.groupBy(attentionEvents.projectId, projects.title, projects.slug)
				.orderBy(desc(sql`COUNT(*)`))
				.limit(50);

			result.push(
				...projectStats.map((r) => ({
					type: "project",
					id: r.projectId,
					title: r.projectTitle,
					slug: r.projectSlug,
					eventCount: Number(r.eventCount),
					totalDuration: Number(r.totalDuration),
				})),
			);
		}

		if (type === "all" || type === "posts") {
			const postStats = await db
				.select({
					postId: attentionEvents.postId,
					postTitle: posts.title,
					eventCount: sql<number>`COUNT(*)`,
					totalDuration: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)`,
				})
				.from(attentionEvents)
				.innerJoin(posts, eq(attentionEvents.postId, posts.id))
				.where(
					and(
						eq(attentionEvents.creatorId, user.id),
						gte(attentionEvents.createdAt, since),
						sql`${attentionEvents.postId} IS NOT NULL`,
					),
				)
				.groupBy(attentionEvents.postId, posts.title)
				.orderBy(desc(sql`COUNT(*)`))
				.limit(50);

			result.push(
				...postStats.map((r) => ({
					type: "post",
					id: r.postId,
					title: r.postTitle,
					eventCount: Number(r.eventCount),
					totalDuration: Number(r.totalDuration),
				})),
			);
		}

		return c.json({ content: result, period });
	})

	.get("/analytics/timeseries", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		const timeseries = await db
			.select({
				date: sql<string>`DATE(${attentionEvents.createdAt})`,
				views: sql<number>`COUNT(*) FILTER (WHERE event_type = 'page_view')`,
				plays: sql<number>`COUNT(*) FILTER (WHERE event_type = 'play')`,
				watches: sql<number>`COUNT(*) FILTER (WHERE event_type = 'watch')`,
				reads: sql<number>`COUNT(*) FILTER (WHERE event_type = 'read')`,
				listens: sql<number>`COUNT(*) FILTER (WHERE event_type = 'listen')`,
			})
			.from(attentionEvents)
			.where(
				and(
					eq(attentionEvents.creatorId, user.id),
					gte(attentionEvents.createdAt, since),
				),
			)
			.groupBy(sql`DATE(${attentionEvents.createdAt})`)
			.orderBy(sql`DATE(${attentionEvents.createdAt})`);

		return c.json({
			timeseries: timeseries.map((r) => ({
				date: r.date,
				views: Number(r.views),
				plays: Number(r.plays),
				watches: Number(r.watches),
				reads: Number(r.reads),
				listens: Number(r.listens),
			})),
			period,
		});
	})

	// ══════════════════════════════════════════════════════════════════════════
	// PLATFORM CONNECTIONS
	// ══════════════════════════════════════════════════════════════════════════

	.get("/platforms", requireAuth, async (c) => {
		const user = c.get("user");

		const connections = await db
			.select()
			.from(platformConnections)
			.where(eq(platformConnections.userId, user.id));

		// Don't expose tokens to frontend
		return c.json({
			platforms: connections.map((conn) => ({
				id: conn.id,
				platform: conn.platform,
				platformUserId: conn.platformUserId,
				platformUsername: conn.platformUsername,
				isActive: conn.isActive,
				createdAt: conn.createdAt,
			})),
		});
	})

	.post(
		"/platforms/connect",
		requireAuth,
		zValidator("json", z.object({
			platform: z.enum(["steam", "itchio", "substack"]),
			apiKey: z.string().min(1),
		})),
		async (c) => {
			const user = c.get("user");
			const { platform, apiKey } = c.req.valid("json");

			// Upsert
			await db
				.insert(platformConnections)
				.values({
					userId: user.id,
					platform,
					apiKey,
					isActive: true,
				})
				.onConflictDoUpdate({
					target: [platformConnections.userId, platformConnections.platform],
					set: { apiKey, isActive: true, updatedAt: new Date() },
				});

			return c.json({ success: true }, 201);
		},
	)

	.delete("/platforms/:platform/disconnect", requireAuth, async (c) => {
		const user = c.get("user");
		const { platform } = c.req.param();

		const result = await db
			.delete(platformConnections)
			.where(
				and(
					eq(platformConnections.userId, user.id),
					eq(platformConnections.platform, platform),
				),
			);

		if (result.rowCount === 0) return c.json({ error: "Connection not found" }, 404);
		return c.body(null, 204);
	})

	// ══════════════════════════════════════════════════════════════════════════
	// CROSS-PUBLISH
	// ══════════════════════════════════════════════════════════════════════════

	.get("/cross-publish", requireAuth, async (c) => {
		const user = c.get("user");
		const platform = c.req.query("platform");

		const conditions = [eq(crossPublishResults.userId, user.id)];
		if (platform) {
			conditions.push(eq(crossPublishResults.platform, platform));
		}

		const results = await db
			.select()
			.from(crossPublishResults)
			.where(and(...conditions))
			.orderBy(desc(crossPublishResults.createdAt));

		return c.json({ results });
	})

	.post(
		"/cross-publish/initiate",
		requireAuth,
		zValidator("json", z.object({
			platform: z.string().min(1),
			projectId: z.number().int().optional(),
			postId: z.number().int().optional(),
		})),
		async (c) => {
			const user = c.get("user");
			const { platform, projectId, postId } = c.req.valid("json");

			if (!projectId && !postId) {
				return c.json({ error: "Either projectId or postId is required" }, 400);
			}

			// Check platform connection exists
			const [conn] = await db
				.select({ id: platformConnections.id })
				.from(platformConnections)
				.where(
					and(
						eq(platformConnections.userId, user.id),
						eq(platformConnections.platform, platform),
						eq(platformConnections.isActive, true),
					),
				)
				.limit(1);

			if (!conn) {
				return c.json({ error: `Not connected to ${platform}` }, 400);
			}

			const [result] = await db
				.insert(crossPublishResults)
				.values({
					userId: user.id,
					platform,
					projectId: projectId ?? null,
					postId: postId ?? null,
					status: "pending",
				})
				.returning();

			await boss.send(
				QUEUES.CROSS_PUBLISH,
				{ crossPublishId: result.id },
				JOB_OPTIONS[QUEUES.CROSS_PUBLISH],
			);

			return c.json({ result }, 201);
		},
	)

	// ══════════════════════════════════════════════════════════════════════════
	// ITCH.IO IMPORT
	// ══════════════════════════════════════════════════════════════════════════

	.get("/import/itchio/preview", requireAuth, async (c) => {
		const itchUsername = c.req.query("username");
		if (!itchUsername) {
			return c.json({ error: "username parameter required" }, 400);
		}

		// TODO: Scrape itch.io profile page for game list
		// This is a web scraping operation that will be implemented in Phase 4
		return c.json({
			games: [],
			message: "itch.io import preview not yet implemented",
		});
	})

	.post(
		"/import/itchio/detail",
		requireAuth,
		zValidator("json", z.object({ url: z.string().url() })),
		async (c) => {
			// TODO: Fetch detailed metadata from a single itch.io game page
			return c.json({
				game: null,
				message: "itch.io detail fetch not yet implemented",
			});
		},
	)

	.post(
		"/import/itchio",
		requireAuth,
		zValidator("json", z.object({
			games: z.array(z.object({ url: z.string().url() })).max(20),
		})),
		async (c) => {
			// TODO: Import itch.io games as draft projects
			return c.json({
				imported: 0,
				message: "itch.io import not yet implemented",
			});
		},
	);

export { integrationRoutes };

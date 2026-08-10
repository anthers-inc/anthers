// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Integration routes — analytics, platform connections, cross-publish,
 * itch.io import.
 *
 * > [!warning] Analytics read TWO tables, and both halves are required
 * > Raw `attention_events` are deleted after `ATTENTION_RAW_RETENTION_DAYS` and rolled
 * > into `attention_daily` by `jobs/prune-attention.ts`, per 51.05's retention
 * > promise. A creator's `period` can be up to a year, so **anything reading only the
 * > raw table silently returns zero for the older part of the window** — not an error,
 * > just a history that quietly stops. Every query below unions the two.
 * >
 * > The one figure that cannot be unioned is `uniqueViewers`: the rollup holds daily
 * > distinct counts and adding them across days counts a returning viewer once per
 * > day. That is a genuine, permanent consequence of not keeping identities, so the
 * > count is reported over the raw window only and the response says which window that
 * > is (`uniqueViewersWindowDays`) rather than overstating a total.
 *
 * The privacy property these queries carry is pinned by `analytics-privacy.test.ts`:
 * no analytics response may contain a viewer-identifying field. `attention_daily` has
 * no `user_id` column at all, so the rolled-up half is safe by construction; the raw
 * half is safe by what it selects.
 */

import { db } from "@anthers/db/client";
import {
	attentionDaily,
	attentionEvents,
	crossPublishResults,
	platformConnections,
	posts,
	projects,
	works,
} from "@anthers/db/schema";
import { ATTENTION_RAW_RETENTION_DAYS } from "@anthers/shared/constants";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { requireAuth } from "../middleware/auth.js";

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
				totalEvents: sql<number>`COUNT(*)::int`,
				totalDuration: sql<number>`COALESCE(SUM(duration_seconds), 0)::float`,
				uniqueViewers: sql<number>`COUNT(DISTINCT user_id)::int`,
				views: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'page_view'))::int`,
				plays: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'play'))::int`,
				watches: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'watch'))::int`,
				reads: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'read'))::int`,
				listens: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'listen'))::int`,
			})
			.from(attentionEvents)
			.where(and(eq(attentionEvents.creatorId, user.id), gte(attentionEvents.createdAt, since)));

		// The rolled-up half of the same window. Counts and seconds add across the two
		// tables because the prune job deletes exactly what it summarised — an event is
		// in one or the other, never both.
		const [rolled] = await db
			.select({
				totalEvents: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}), 0)::int`,
				totalDuration: sql<number>`COALESCE(SUM(${attentionDaily.totalSeconds}), 0)::float`,
				views: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'page_view'), 0)::int`,
				plays: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'play'), 0)::int`,
				watches: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'watch'), 0)::int`,
				reads: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'read'), 0)::int`,
				listens: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'listen'), 0)::int`,
			})
			.from(attentionDaily)
			.where(
				and(
					eq(attentionDaily.creatorId, user.id),
					gte(attentionDaily.day, since.toISOString().slice(0, 10)),
				),
			);

		// Content counts
		const [projectCount] = await db
			.select({ count: sql<number>`COUNT(*)::int` })
			.from(projects)
			.where(eq(projects.creatorId, user.id));

		const [postCount] = await db
			.select({ count: sql<number>`COUNT(*)::int` })
			.from(posts)
			.where(eq(posts.creatorId, user.id));

		// Cross-publish stats
		const [publishCount] = await db
			.select({ count: sql<number>`COUNT(*)::int` })
			.from(crossPublishResults)
			.where(eq(crossPublishResults.userId, user.id));

		return c.json({
			period,
			events: {
				total: Number(overview.totalEvents) + Number(rolled.totalEvents),
				views: Number(overview.views) + Number(rolled.views),
				plays: Number(overview.plays) + Number(rolled.plays),
				watches: Number(overview.watches) + Number(rolled.watches),
				reads: Number(overview.reads) + Number(rolled.reads),
				listens: Number(overview.listens) + Number(rolled.listens),
			},
			totalDurationHours: Number(
				((Number(overview.totalDuration) + Number(rolled.totalDuration)) / 3600).toFixed(2),
			),
			// Deliberately NOT summed with the rollup — see the module note. Daily distinct
			// counts can't be added into a period total without counting a returning viewer
			// once per day, and there is no identity left to deduplicate against. Reporting
			// it over the raw window and naming that window is the honest version; the
			// alternative is a bigger number that means nothing.
			uniqueViewers: Number(overview.uniqueViewers),
			uniqueViewersWindowDays: Math.min(period, ATTENTION_RAW_RETENTION_DAYS),
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

		// Attention is tracked per-post in the unified model, so content analytics
		// are post-scoped. (`type` is kept for API compatibility; only posts exist.)
		const result: any[] = [];

		if (type === "all" || type === "posts") {
			const postStats = await db
				.select({
					workId: attentionEvents.workId,
					postTitle: works.title,
					postSlug: works.slug,
					eventCount: sql<number>`COUNT(*)::int`,
					totalDuration: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::float`,
				})
				.from(attentionEvents)
				.innerJoin(works, eq(attentionEvents.workId, works.id))
				.where(
					and(
						eq(attentionEvents.creatorId, user.id),
						gte(attentionEvents.createdAt, since),
						sql`${attentionEvents.workId} IS NOT NULL`,
					),
				)
				.groupBy(attentionEvents.workId, works.title, works.slug)
				.orderBy(desc(sql`COUNT(*)`))
				.limit(50);

			// The rolled-up half, keyed the same way so the two merge per Work.
			const rolledStats = await db
				.select({
					workId: attentionDaily.workId,
					postTitle: works.title,
					postSlug: works.slug,
					eventCount: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}), 0)::int`,
					totalDuration: sql<number>`COALESCE(SUM(${attentionDaily.totalSeconds}), 0)::float`,
				})
				.from(attentionDaily)
				.innerJoin(works, eq(attentionDaily.workId, works.id))
				.where(
					and(
						eq(attentionDaily.creatorId, user.id),
						gte(attentionDaily.day, since.toISOString().slice(0, 10)),
					),
				)
				.groupBy(attentionDaily.workId, works.title, works.slug);

			// Merge on Work id: a Work whose history straddles the retention boundary has
			// rows in both tables, and returning it twice would double it in the UI.
			const byWork = new Map<
				number,
				{ id: number; title: string; slug: string; eventCount: number; totalDuration: number }
			>();
			for (const r of [...postStats, ...rolledStats]) {
				if (r.workId == null) continue;
				const existing = byWork.get(r.workId);
				if (existing) {
					existing.eventCount += Number(r.eventCount);
					existing.totalDuration += Number(r.totalDuration);
				} else {
					byWork.set(r.workId, {
						id: r.workId,
						title: r.postTitle ?? "",
						slug: r.postSlug ?? "",
						eventCount: Number(r.eventCount),
						totalDuration: Number(r.totalDuration),
					});
				}
			}

			result.push(
				...[...byWork.values()]
					.sort((a, b) => b.eventCount - a.eventCount)
					.slice(0, 50)
					.map((r) => ({ type: "post", ...r })),
			);
		}

		return c.json({ content: result, period });
	})

	.get("/analytics/timeseries", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		// Group attention events by UTC calendar day of their timestamp.
		const dateExpr = sql<string>`to_char(${attentionEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
		const timeseries = await db
			.select({
				date: dateExpr,
				views: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'page_view'))::int`,
				plays: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'play'))::int`,
				watches: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'watch'))::int`,
				reads: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'read'))::int`,
				listens: sql<number>`(COUNT(*) FILTER (WHERE event_type = 'listen'))::int`,
			})
			.from(attentionEvents)
			.where(and(eq(attentionEvents.creatorId, user.id), gte(attentionEvents.createdAt, since)))
			.groupBy(dateExpr)
			.orderBy(dateExpr);

		// The rolled-up half. `attention_daily.day` is already the UTC calendar day the
		// expression above derives, so the two series share a key and merge by date.
		const rolledSeries = await db
			.select({
				date: attentionDaily.day,
				views: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'page_view'), 0)::int`,
				plays: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'play'), 0)::int`,
				watches: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'watch'), 0)::int`,
				reads: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'read'), 0)::int`,
				listens: sql<number>`COALESCE(SUM(${attentionDaily.eventCount}) FILTER (WHERE ${attentionDaily.eventType} = 'listen'), 0)::int`,
			})
			.from(attentionDaily)
			.where(
				and(
					eq(attentionDaily.creatorId, user.id),
					gte(attentionDaily.day, since.toISOString().slice(0, 10)),
				),
			)
			.groupBy(attentionDaily.day);

		const byDate = new Map<
			string,
			{
				date: string;
				views: number;
				plays: number;
				watches: number;
				reads: number;
				listens: number;
			}
		>();
		for (const r of [...timeseries, ...rolledSeries]) {
			const row = byDate.get(r.date) ?? {
				date: r.date,
				views: 0,
				plays: 0,
				watches: 0,
				reads: 0,
				listens: 0,
			};
			row.views += Number(r.views);
			row.plays += Number(r.plays);
			row.watches += Number(r.watches);
			row.reads += Number(r.reads);
			row.listens += Number(r.listens);
			byDate.set(r.date, row);
		}

		return c.json({
			timeseries: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
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
		zValidator(
			"json",
			z.object({
				platform: z.enum(["steam", "itchio", "substack"]),
				apiKey: z.string().min(1),
			}),
		),
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

		const deleted = await db
			.delete(platformConnections)
			.where(
				and(eq(platformConnections.userId, user.id), eq(platformConnections.platform, platform)),
			)
			.returning({ id: platformConnections.id });

		if (deleted.length === 0) return c.json({ error: "Connection not found" }, 404);
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
		zValidator(
			"json",
			z.object({
				platform: z.string().min(1),
				postId: z.number().int(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { platform, postId } = c.req.valid("json");

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
					postId,
					status: "pending",
				})
				.returning();

			await queue.send(
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
		zValidator(
			"json",
			z.object({
				games: z.array(z.object({ url: z.string().url() })).max(20),
			}),
		),
		async (c) => {
			// TODO: Import itch.io games as draft projects
			return c.json({
				imported: 0,
				message: "itch.io import not yet implemented",
			});
		},
	);

export { integrationRoutes };

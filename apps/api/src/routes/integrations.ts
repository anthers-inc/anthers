// SPDX-License-Identifier: Apache-2.0
/**
 * Integration routes — creator analytics, and the itch.io importer that is not built yet.
 *
 * > [!warning] Analytics read TWO tables, and both halves are required
 * > Raw `attention_events` are deleted after `ATTENTION_RAW_RETENTION_DAYS` and rolled
 * > into `attention_daily` by `jobs/prune-attention.ts`, per the Privacy Policy's retention
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
import { attentionDaily, posts, projects, works } from "@anthers/db/schema";
import { ATTENTION_RAW_RETENTION_DAYS } from "@anthers/shared/constants";
import { zValidator } from "@hono/zod-validator";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { creatorAnalyticsRanges } from "../services/attention-ranges.js";

/** One Work's attention over the analytics period, merged across the raw and rolled-up tables. */
interface WorkStats {
	id: number;
	publicId: number | null;
	title: string;
	slug: string;
	eventCount: number;
	totalDuration: number;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const integrationRoutes = new Hono()
	// ══════════════════════════════════════════════════════════════════════════
	// ANALYTICS
	// ══════════════════════════════════════════════════════════════════════════

	.get("/analytics/overview", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		// Raw ranges, split per viewer on read: a creator's totals can never include
		// the same real second twice from one account.
		const rawGroups = await creatorAnalyticsRanges(user.id, since, () => "all");
		const raw = rawGroups[0] ?? { totalSeconds: 0, eventCount: 0, viewers: new Set<number>() };
		const byType = await creatorAnalyticsRanges(user.id, since, (r) => r.eventType);

		// The rolled-up half of the same window. Counts and seconds add across the two
		// tables because the prune job deletes exactly what it summarized — an event is
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

		const typeTotal = (t: string) => Number(byType.find((g) => g.key === t)?.eventCount ?? 0);

		// Content counts
		const [projectCount] = await db
			.select({ count: sql<number>`COUNT(*)::int` })
			.from(projects)
			.where(eq(projects.creatorId, user.id));

		const [postCount] = await db
			.select({ count: sql<number>`COUNT(*)::int` })
			.from(posts)
			.where(eq(posts.creatorId, user.id));

		return c.json({
			period,
			events: {
				total: raw.eventCount + Number(rolled.totalEvents),
				views: typeTotal("page_view") + Number(rolled.views),
				plays: typeTotal("play") + Number(rolled.plays),
				watches: typeTotal("watch") + Number(rolled.watches),
				reads: typeTotal("read") + Number(rolled.reads),
				listens: typeTotal("listen") + Number(rolled.listens),
			},
			totalDurationHours: Number(
				((raw.totalSeconds + Number(rolled.totalDuration)) / 3600).toFixed(2),
			),
			// Deliberately NOT summed with the rollup — see the module note. Daily distinct
			// counts can't be added into a period total without counting a returning viewer
			// once per day, and there is no identity left to deduplicate against. Reporting
			// it over the raw window and naming that window is the honest version; the
			// alternative is a bigger number that means nothing.
			uniqueViewers: raw.viewers.size,
			uniqueViewersWindowDays: Math.min(period, ATTENTION_RAW_RETENTION_DAYS),
			contentCounts: {
				projects: Number(projectCount.count),
				posts: Number(postCount.count),
			},
		});
	})

	.get("/analytics/content", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const type = c.req.query("type") ?? "all";
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		// 🚨 **Every row here is a WORK, and it said `post` until 2026-09-11.** Attention is
		// recorded against `attention_events.work_id` — a post announces and is never consumed
		// — so these rows were joined to `works`, titled from `works`, grouped by `works.id`,
		// and then labeled `post` by a mapper that predates the split. The Studio believed the
		// label and built `/@name/posts/{id}` out of a Work's row id, which resolves to
		// nothing: `findPostRow` reads a bare number as a **publicId**, and those are nine
		// digits while a Work id is a small serial. Every row in the creator's analytics table
		// linked to a 404.
		//
		// `publicId` rides along because that is what a durable Work URL is built from; the
		// row id would work today and break the moment a link is shared.
		const result: (WorkStats & { type: "work" })[] = [];

		if (type === "all" || type === "posts" || type === "works") {
			// Raw ranges, split per viewer, grouped per Work.
			const rawGroups = await creatorAnalyticsRanges(
				user.id,
				since,
				(r) => `w:${r.workId ?? "none"}`,
			);
			const workIds = rawGroups
				.map((g) => (g.key.startsWith("w:") ? Number(g.key.slice(2)) : null))
				.filter((id): id is number => id != null && !Number.isNaN(id));
			const workRows =
				workIds.length > 0
					? await db
							.select({
								id: works.id,
								publicId: works.publicId,
								title: works.title,
								slug: works.slug,
							})
							.from(works)
							.where(inArray(works.id, workIds))
					: [];
			const workMeta = new Map(workRows.map((w) => [w.id, w]));
			const postStats = rawGroups
				.map((g) => {
					const id = g.key.startsWith("w:") ? Number(g.key.slice(2)) : null;
					const meta = id != null ? workMeta.get(id) : undefined;
					if (id == null || !meta) return null;
					return {
						workId: id,
						publicId: meta.publicId,
						postTitle: meta.title,
						postSlug: meta.slug,
						eventCount: g.eventCount,
						totalDuration: g.totalSeconds,
					};
				})
				.filter((r): r is NonNullable<typeof r> => r != null);

			// The rolled-up half, keyed the same way so the two merge per Work.
			const rolledStats = await db
				.select({
					workId: attentionDaily.workId,
					publicId: works.publicId,
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
				.groupBy(attentionDaily.workId, works.publicId, works.title, works.slug);

			// Merge on Work id: a Work whose history straddles the retention boundary has
			// rows in both tables, and returning it twice would double it in the UI.
			const byWork = new Map<number, WorkStats>();
			for (const r of [...postStats, ...rolledStats]) {
				if (r.workId == null) continue;
				const existing = byWork.get(r.workId);
				if (existing) {
					existing.eventCount += Number(r.eventCount);
					existing.totalDuration += Number(r.totalDuration);
				} else {
					byWork.set(r.workId, {
						id: r.workId,
						publicId: r.publicId ?? null,
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
					.map((r) => ({ type: "work" as const, ...r })),
			);
		}

		return c.json({ content: result, period });
	})

	.get("/analytics/timeseries", requireAuth, async (c) => {
		const user = c.get("user");
		const period = Math.min(Number(c.req.query("period") ?? 30), 365);
		const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

		// Group attention events by the UTC day the time was SPENT, not recorded.
		const rawSeries = await creatorAnalyticsRanges(user.id, since, (r) => r.day as `d:${string}`);
		const timeseries = rawSeries.map((g) => ({
			date: g.key.slice(2),
			views: 0,
			plays: 0,
			watches: 0,
			reads: 0,
			listens: 0,
		}));
		// Fold event types into per-day counts — one groupBy pass by day, one per type.
		const byDayType = await creatorAnalyticsRanges(
			user.id,
			since,
			(r) => `${r.day}:${r.eventType}`,
		);
		const perDay = new Map(timeseries.map((t) => [t.date, t]));
		for (const g of byDayType) {
			const [date, type] = g.key.split(":") as [string, string];
			const row = perDay.get(date) ?? {
				date,
				views: 0,
				plays: 0,
				watches: 0,
				reads: 0,
				listens: 0,
			};
			if (type === "page_view") row.views += g.eventCount;
			else if (type === "play") row.plays += g.eventCount;
			else if (type === "watch") row.watches += g.eventCount;
			else if (type === "read") row.reads += g.eventCount;
			else if (type === "listen") row.listens += g.eventCount;
			perDay.set(date, row);
		}
		const timeseriesRows = [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date));

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
		for (const r of [...timeseriesRows, ...rolledSeries]) {
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

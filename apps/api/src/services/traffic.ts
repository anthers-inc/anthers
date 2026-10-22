// SPDX-License-Identifier: Apache-2.0
/**
 * The traffic service — the ONLY writer of traffic records, and the home of every
 * read the analytics surfaces make.
 *
 * The one-writer discipline here is the same `services/moderation.ts` and
 * `services/refunds.ts` encode, and for a second reason on top: the whole privacy
 * story of first-party traffic is what this module does with identity. It is the one
 * place that decides what a row may carry (no user id, no IP, no fingerprint — a
 * client-generated session id only), so a future change to that model (the Polysemy
 * signpost in the task for this work names it) is a change to this file and a test,
 * not a sweep of call sites. Routes stay thin and call this.
 *
 * Intake defenses live in the route (`routes/traffic.ts`); this module trusts its own
 * caller about *which* door let the request in, and is answerable for everything the
 * record then says: the caps, the classification, and the enum values it writes.
 */

import { db } from "@anthers/db/client";
import {
	cardImpressions,
	cardImpressionsDaily,
	trafficDaily,
	trafficEvents,
	users,
} from "@anthers/db/schema";
import {
	classifyReferrerSource,
	deviceClassFor,
	MAX_PATH_LENGTH,
	MAX_PREVIOUS_PATH_LENGTH,
	MAX_REFERRER_HOST_LENGTH,
	MAX_SESSION_ID_LENGTH,
	type ReferrerSource,
} from "@anthers/shared/traffic";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { profilePath } from "../lib/handles.js";
import { rowsOf } from "./rows.js";

/** The card surfaces that can legitimately display a countable card. */
const CARD_SUBJECT_KINDS = ["project", "creator"] as const;
const CARD_KINDS = ["shown", "click"] as const;

/** A validated page-view intake, after every cap this service enforces. */
export interface PageViewInput {
	path: string;
	referrerHost: string | null;
	previousPath: string | null;
	sessionId: string;
	pageHost: string | null;
	userAgent: string | null;
}

/**
 * Strip a full referrer URL to its host. The browser's `strict-origin-when-cross-origin`
 * default already strips cross-origin referrers to an origin; a same-origin referrer
 * can still carry a path — and either way, the storage rule is the same: host only.
 * A path can carry somebody's search terms and other sites' tracking parameters, and
 * storing them would import another site's tracking data into ours.
 */
export function referrerHostOf(referrer: string | null): string | null {
	if (!referrer) return null;
	try {
		const url = new URL(referrer);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.host.slice(0, MAX_REFERRER_HOST_LENGTH) || null;
	} catch {
		// Not a URL (some referrers arrive opaque, `android-app://…` parses, junk does
		// not) — no host is knowable, so the referrer contributes nothing.
		return null;
	}
}

/** Cap a client-supplied path. Over-long paths are real pages with junk on them; cap rather than refuse, the view still counts. */
function capPath(path: string | null, max: number): string | null {
	if (!path) return null;
	return path.slice(0, max);
}

/** The day a timestamp falls on, in UTC, as the rollups spell it (`YYYY-MM-DD`). */
export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

// ── Writers ──────────────────────────────────────────────────────────────────

/** Record one page view. Throws only on a structurally impossible row (no session id), which the route renders as a drop. */
export async function recordPageView(input: PageViewInput): Promise<void> {
	const sessionId = input.sessionId?.slice(0, MAX_SESSION_ID_LENGTH);
	if (!sessionId) return; // A view with no session id cannot be counted honestly; drop it.
	const referrerHost =
		referrerHostOf(input.referrerHost)?.slice(0, MAX_REFERRER_HOST_LENGTH) ?? null;

	await db.insert(trafficEvents).values({
		path: capPath(input.path, MAX_PATH_LENGTH) ?? "/",
		referrerHost,
		referrerSource: classifyReferrerSource(referrerHost, input.pageHost),
		previousPath: capPath(input.previousPath, MAX_PREVIOUS_PATH_LENGTH),
		sessionId,
		device: deviceClassFor(input.userAgent ?? ""),
	});
}

/** Record one card display (shown or click). Silently refuses values that are not the documented shape — a beacon is never a place to store surprises. */
export async function recordCardDisplay(input: {
	subjectKind: string;
	subjectId: number;
	kind: string;
	surface: string;
}): Promise<boolean> {
	if (!CARD_SUBJECT_KINDS.includes(input.subjectKind as (typeof CARD_SUBJECT_KINDS)[number]))
		return false;
	if (!CARD_KINDS.includes(input.kind as (typeof CARD_KINDS)[number])) return false;
	if (!Number.isInteger(input.subjectId) || input.subjectId <= 0) return false;
	const surface = input.surface.slice(0, 32) || "discover";

	await db.insert(cardImpressions).values({
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		kind: input.kind,
		surface,
	});
	return true;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One day's traffic totals as the union read renders it: views add, sessions are that day's distinct count. */
export interface TrafficDayEntry {
	day: string;
	views: number;
	sessions: number | null;
}

/**
 * Daily views and sessions over a window, reading raw and rolled-up rows as one
 * history.
 *
 * 🚨 The same union rule the attention analytics carry, and for the same reason: raw
 * rows are pruned into `traffic_daily` after `TRAFFIC_RAW_RETENTION_DAYS`, so a query
 * against only the raw table goes silently zero past the retention line. Views add
 * across the halves because the prune deletes exactly what it summarized — an event
 * sits in one table, never both.
 *
 * Sessions differ: a day fully inside the raw window reports its true distinct-session
 * count; an older day reports the per-day count the rollup stored. Across days,
 * sessions never sum — the same returning-visitor caveat `attention_daily`'s
 * `unique_viewers` note carries — so windows are reported with which half answered.
 */
export async function trafficTimeseries(days: number): Promise<TrafficDayEntry[]> {
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	const [raw, rolled] = await Promise.all([
		db
			.select({
				day: sql<string>`to_char(${trafficEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
				views: sql<number>`count(*)::int`,
				sessions: sql<number>`count(distinct ${trafficEvents.sessionId})::int`,
			})
			.from(trafficEvents)
			// The cutoff scan cannot use the created index on a to_char expression, but
			// the window is the retention window at most — this scan is bounded by the
			// pruner's work, not by history.
			.where(gte(trafficEvents.createdAt, since))
			.groupBy(sql`1`),
		db
			.select({
				day: trafficDaily.day,
				views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int`,
			})
			.from(trafficDaily)
			.where(gte(trafficDaily.day, sinceDay))
			.groupBy(trafficDaily.day),
	]);

	const byDay = new Map<string, TrafficDayEntry>();
	for (const r of rolled) byDay.set(r.day, { day: r.day, views: r.views, sessions: null });
	for (const r of raw) {
		// Raw beats rollup where both exist — they never should (the prune deletes what
		// it summarized), and if they ever do, the finer figure is the one to show.
		byDay.set(r.day, { day: r.day, views: r.views, sessions: r.sessions });
	}
	return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** One source's totals over a window: views, and the entry-session count over the raw window. */
export interface TrafficSourceEntry {
	source: ReferrerSource;
	views: number;
}

/** Views by referrer source over a window, unioned across raw and rolled-up. */
export async function trafficBySource(days: number): Promise<TrafficSourceEntry[]> {
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	const [raw, rolled] = await Promise.all([
		db
			.select({
				source: trafficEvents.referrerSource,
				views: sql<number>`count(*)::int`,
			})
			.from(trafficEvents)
			.where(gte(trafficEvents.createdAt, since))
			.groupBy(trafficEvents.referrerSource),
		db
			.select({
				source: trafficDaily.referrerSource,
				views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int`,
			})
			.from(trafficDaily)
			.where(gte(trafficDaily.day, sinceDay))
			.groupBy(trafficDaily.referrerSource),
	]);

	const merged = new Map<ReferrerSource, number>();
	for (const r of raw)
		merged.set(r.source as ReferrerSource, (merged.get(r.source as ReferrerSource) ?? 0) + r.views);
	for (const r of rolled)
		merged.set(r.source as ReferrerSource, (merged.get(r.source as ReferrerSource) ?? 0) + r.views);
	return [...merged.entries()]
		.map(([source, views]) => ({ source, views }))
		.sort((a, b) => b.views - a.views);
}

/** The top pages over a window, unioned across raw and rolled-up. */
export interface TrafficPathEntry {
	path: string;
	views: number;
}

export async function trafficTopPaths(days: number, limit = 20): Promise<TrafficPathEntry[]> {
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	const [raw, rolled] = await Promise.all([
		db
			.select({ path: trafficEvents.path, views: sql<number>`count(*)::int` })
			.from(trafficEvents)
			.where(gte(trafficEvents.createdAt, since))
			.groupBy(trafficEvents.path)
			.orderBy(desc(sql`2`))
			.limit(limit),
		db
			.select({
				path: trafficDaily.path,
				views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int`,
			})
			.from(trafficDaily)
			.where(gte(trafficDaily.day, sinceDay))
			.groupBy(trafficDaily.path)
			.orderBy(desc(sql`2`))
			.limit(limit),
	]);

	// Merge by exact path. A path seen in both halves would double-count — it cannot
	// (see the union note), and a defensive merge that added would hide a prune defect
	// rather than surface it, so the merge asserts nothing and simply unions.
	const merged = new Map<string, number>();
	for (const r of rolled) merged.set(r.path, (merged.get(r.path) ?? 0) + r.views);
	for (const r of raw) merged.set(r.path, (merged.get(r.path) ?? 0) + r.views);
	return [...merged.entries()]
		.map(([path, views]) => ({ path, views }))
		.sort((a, b) => b.views - a.views)
		.slice(0, limit);
}

/**
 * A creator's traffic: views of their profile, works, projects and posts, resolved
 * from recorded *paths* rather than stamped on the rows.
 *
 * 🚨 **Why resolve at read, and what it costs.** Stamping `creator_id` at intake would
 * cost a lookup on every beacon and stamp a site-wide anonymous table with per-person
 * attribution logic for no privacy gain — the row still would not know who the visitor
 * was. Resolving at read keys traffic to the handle that names the creator's public
 * address, and its honest cost is stated here: a creator who *changes* handle inherits
 * their old traffic only through `handle_history`'s redirect, not through these
 * figures. That is accepted for traffic (it measures the address, and the address is
 * what marketing points at) and is one of the things the Privacy Policy wording will
 * say plainly.
 */
export interface CreatorTraffic {
	profileViews: number;
	topWorks: Array<{ workId: number | null; path: string; views: number }>;
	topProjects: Array<{ path: string; views: number }>;
}

export async function creatorTraffic(creatorId: number, days: number): Promise<CreatorTraffic> {
	const [creator] = await db
		.select({ handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, creatorId))
		.limit(1);
	if (!creator?.handle) return { profileViews: 0, topWorks: [], topProjects: [] };

	const prefix = profilePath(creator.handle);
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	// The same union-by-window the site-wide reads use; grouped by path prefix family.
	const [profileRaw, profileRolled] = await Promise.all([
		db
			.select({ views: sql<number>`count(*)::int` })
			.from(trafficEvents)
			.where(and(gte(trafficEvents.createdAt, since), eq(trafficEvents.path, prefix))),
		db
			.select({ views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int` })
			.from(trafficDaily)
			.where(and(gte(trafficDaily.day, sinceDay), eq(trafficDaily.path, prefix))),
	]);

	const workSuffix = `${prefix}/works/`;
	const [worksRaw, worksRolled] = await Promise.all([
		db
			.select({
				path: trafficEvents.path,
				views: sql<number>`count(*)::int`,
			})
			.from(trafficEvents)
			.where(
				and(
					gte(trafficEvents.createdAt, since),
					sql`${trafficEvents.path} LIKE ${`${workSuffix}%`}`,
				),
			)
			.groupBy(trafficEvents.path)
			.orderBy(desc(sql`2`))
			.limit(10),
		db
			.select({
				path: trafficDaily.path,
				views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int`,
			})
			.from(trafficDaily)
			.where(
				and(gte(trafficDaily.day, sinceDay), sql`${trafficDaily.path} LIKE ${`${workSuffix}%`}`),
			)
			.groupBy(trafficDaily.path)
			.orderBy(desc(sql`2`))
			.limit(10),
	]);

	const projectSuffix = `${prefix}/`;
	// A project page is the two-segment form `/@handle/{slug}` — anything deeper is
	// posts, works, or another surface.
	const [projectsRaw] = await Promise.all([
		db
			.select({ path: trafficEvents.path, views: sql<number>`count(*)::int` })
			.from(trafficEvents)
			.where(
				and(
					gte(trafficEvents.createdAt, since),
					sql`${trafficEvents.path} LIKE ${`${projectSuffix}%`}`,
					sql`${trafficEvents.path} NOT LIKE ${`${projectSuffix}posts/%`}`,
					sql`${trafficEvents.path} NOT LIKE ${`${projectSuffix}works/%`}`,
					// Exactly one segment under the handle: no more slashes after stripping the prefix.
					sql`position('/' in substring(${trafficEvents.path} from ${projectSuffix.length + 1})) = 0`,
					sql`length(substring(${trafficEvents.path} from ${projectSuffix.length + 1})) > 0`,
				),
			)
			.groupBy(trafficEvents.path)
			.orderBy(desc(sql`2`))
			.limit(10),
	]);

	const mergedWorks = new Map<string, number>();
	for (const r of [...worksRolled, ...worksRaw])
		mergedWorks.set(r.path, (mergedWorks.get(r.path) ?? 0) + r.views);
	const topWorks = [...mergedWorks.entries()]
		.map(([path, views]) => ({ workId: workPublicIdFromPath(path), path, views }))
		.sort((a, b) => b.views - a.views)
		.slice(0, 10);

	const mergedProjects = new Map<string, number>();
	for (const r of projectsRaw)
		mergedProjects.set(r.path, (mergedProjects.get(r.path) ?? 0) + r.views);
	const topProjects = [...mergedProjects.entries()]
		.map(([path, views]) => ({ path, views }))
		.sort((a, b) => b.views - a.views)
		.slice(0, 10);

	return {
		profileViews: (profileRaw[0]?.views ?? 0) + (profileRolled[0]?.views ?? 0),
		topWorks,
		topProjects,
	};
}

/**
 * The Work a work-page path names, read from the durable half of its address:
 * `/@handle/works/{slug}-{publicId}` — the trailing integer on the last segment.
 * The slug half breaks on rename; the publicId half never does, which is the whole
 * point of it being on the URL.
 */
export function workPublicIdFromPath(path: string): number | null {
	const last = path.split("/").pop() ?? "";
	const match = /-(\d+)$/.exec(last);
	return match ? Number.parseInt(match[1]!, 10) : null;
}

/**
 * A creator's views by day, over their own pages — profile, works, projects, posts —
 * read from the same union of raw and rolled-up rows the site-wide reads use, filtered
 * by the creator's path prefix. The prefix boundary is exact-plus-slash on purpose: a
 * filter on `LIKE prefix || '%'` would let `/@al` swallow `/@alice`, so the condition
 * is "the bare profile path, or anything under it."
 */
export async function creatorTrafficSeries(
	creatorId: number,
	days: number,
): Promise<TrafficDayEntry[]> {
	const prefix = await creatorPathPrefix(creatorId);
	if (!prefix) return [];
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	const [raw, rolled] = await Promise.all([
		db
			.select({
				day: sql<string>`to_char(${trafficEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
				views: sql<number>`count(*)::int`,
				sessions: sql<number>`count(distinct ${trafficEvents.sessionId})::int`,
			})
			.from(trafficEvents)
			.where(and(gte(trafficEvents.createdAt, since), underCreatorPath(trafficEvents.path, prefix)))
			.groupBy(sql`1`),
		db
			.select({
				day: trafficDaily.day,
				views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int`,
			})
			.from(trafficDaily)
			.where(and(gte(trafficDaily.day, sinceDay), underCreatorPath(trafficDaily.path, prefix)))
			.groupBy(trafficDaily.day),
	]);

	const byDay = new Map<string, TrafficDayEntry>();
	for (const r of rolled) byDay.set(r.day, { day: r.day, views: r.views, sessions: null });
	for (const r of raw) {
		byDay.set(r.day, { day: r.day, views: r.views, sessions: r.sessions });
	}
	return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * A creator's views split by referrer source, over their own pages — where their
 * readers arrived from, as aggregates the raw and rolled-up halves merge. Sources are
 * classified at intake and stored; nothing here re-derives one.
 */
export async function creatorTrafficSources(
	creatorId: number,
	days: number,
): Promise<TrafficSourceEntry[]> {
	const prefix = await creatorPathPrefix(creatorId);
	if (!prefix) return [];
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	const [raw, rolled] = await Promise.all([
		db
			.select({ source: trafficEvents.referrerSource, views: sql<number>`count(*)::int` })
			.from(trafficEvents)
			.where(and(gte(trafficEvents.createdAt, since), underCreatorPath(trafficEvents.path, prefix)))
			.groupBy(trafficEvents.referrerSource),
		db
			.select({
				source: trafficDaily.referrerSource,
				views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int`,
			})
			.from(trafficDaily)
			.where(and(gte(trafficDaily.day, sinceDay), underCreatorPath(trafficDaily.path, prefix)))
			.groupBy(trafficDaily.referrerSource),
	]);

	const merged = new Map<ReferrerSource, number>();
	for (const r of raw)
		merged.set(r.source as ReferrerSource, (merged.get(r.source as ReferrerSource) ?? 0) + r.views);
	for (const r of rolled)
		merged.set(r.source as ReferrerSource, (merged.get(r.source as ReferrerSource) ?? 0) + r.views);
	return [...merged.entries()]
		.map(([source, views]) => ({ source, views }))
		.sort((a, b) => b.views - a.views);
}

/** The creator's path prefix (`/@handle`), or null if the account does not exist. */
async function creatorPathPrefix(creatorId: number): Promise<string | null> {
	const [creator] = await db
		.select({ handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, creatorId))
		.limit(1);
	if (!creator?.handle) return null;
	return profilePath(creator.handle);
}

/** The prefix-boundary condition shared by the creator reads: the bare profile path, or anything under it. */
function underCreatorPath(pathColumn: AnyPgColumn, prefix: string) {
	return sql`(${pathColumn} = ${prefix} OR ${pathColumn} LIKE ${`${prefix}/%`})`;
}

/**
 * A creator's card performance: how often their cards were shown on Discover against
 * how often those cards themselves were clicked — the impressions figure the Roadmap
 * carries, from `card_impressions_daily` (which survives pruning with the attribution
 * resolved).
 */
export interface CreatorCards {
	shown: number;
	clicked: number;
	bySubject: Array<{ subjectKind: string; subjectId: number; shown: number; clicked: number }>;
}

export async function creatorCards(creatorId: number, days: number): Promise<CreatorCards> {
	const sinceDay = utcDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
	const rows = await db
		.select({
			subjectKind: cardImpressionsDaily.subjectKind,
			subjectId: cardImpressionsDaily.subjectId,
			shown: sql<number>`COALESCE(SUM(${cardImpressionsDaily.shown}), 0)::int`,
			clicked: sql<number>`COALESCE(SUM(${cardImpressionsDaily.clicked}), 0)::int`,
		})
		.from(cardImpressionsDaily)
		.where(
			and(eq(cardImpressionsDaily.creatorId, creatorId), gte(cardImpressionsDaily.day, sinceDay)),
		)
		.groupBy(cardImpressionsDaily.subjectKind, cardImpressionsDaily.subjectId);

	return {
		shown: rows.reduce((sum, r) => sum + r.shown, 0),
		clicked: rows.reduce((sum, r) => sum + r.clicked, 0),
		bySubject: rows.map((r) => ({ ...r })).sort((a, b) => b.shown - a.shown),
	};
}

/** One stage of the funnel; raw rows are joined at read (no per-person figure leaves the aggregate). */
export interface FunnelStage {
	landingViews: number;
	signups: number;
	firstSupports: number;
}

/**
 * The acquisition funnel — landing page views, signups, first support — as aggregates
 * over the same window, never a per-session join.
 *
 * 🚨 **The stages are counted from different tables and are never chained.** Traffic
 * rows carry no identity, so "which session signed up" is not a question this pipeline
 * can answer — by design, not by omission. The funnel is therefore honest rates:
 * of the people who landed, of the people who signed up in the same window, of the
 * people whose FIRST support landed in it. Reading these as a cohort conversion
 * overstates nothing and connects nobody — that is the trade the no-identity decision
 * made, stated here where the reader of the figure will find it.
 */
export async function trafficFunnel(days: number): Promise<FunnelStage> {
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const sinceDay = utcDay(since);

	const [landing, signups, supportsRowsA, supportsRowsB] = await Promise.all([
		Promise.all([
			db
				.select({ views: sql<number>`count(*)::int` })
				.from(trafficEvents)
				.where(and(gte(trafficEvents.createdAt, since), eq(trafficEvents.path, "/"))),
			db
				.select({ views: sql<number>`COALESCE(SUM(${trafficDaily.views}), 0)::int` })
				.from(trafficDaily)
				.where(and(gte(trafficDaily.day, sinceDay), eq(trafficDaily.path, "/"))),
		]),
		db.select({ count: sql<number>`count(*)::int` }).from(users).where(gte(users.createdAt, since)),
		db.execute(sql`
			SELECT count(DISTINCT p.buyer_id)::int AS count
			FROM purchases p
			WHERE p.buyer_id IS NOT NULL
			  AND p.created_at >= ${since.toISOString()}::timestamptz
			  AND NOT EXISTS (
				SELECT 1 FROM purchases earlier
				WHERE earlier.buyer_id = p.buyer_id AND earlier.created_at < p.created_at)
		`),
		db.execute(sql`
			SELECT count(DISTINCT ub.user_id)::int AS count
			FROM user_badges ub
			WHERE ub.created_at >= ${since.toISOString()}::timestamptz
			  AND NOT EXISTS (
				SELECT 1 FROM user_badges earlier
				WHERE earlier.user_id = ub.user_id AND earlier.created_at < ub.created_at)
		`),
	]);

	const firstSupports =
		((rowsOf<{ count: number }>(supportsRowsA)[0]?.count ?? 0) as number) +
		((rowsOf<{ count: number }>(supportsRowsB)[0]?.count ?? 0) as number);

	return {
		// Each half of the landing read is one query's rows; the union rule adds them.
		landingViews: (landing[0][0]?.views ?? 0) + (landing[1][0]?.views ?? 0),
		signups: signups[0]?.count ?? 0,
		firstSupports,
	};
}

/**
 * Days the pruner may process, as the identity of what is prunable: whole UTC days,
 * strictly older than the retention cutoff — the same whole-day rule
 * `prune-attention` states, and for the same reason (a partially-pruned day is a
 * silently smaller total next time the rollup overwrites it).
 */
export async function prunableTrafficDays(
	retentionDays: number,
	maxDays: number,
): Promise<string[]> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const cutoffIso = cutoff.toISOString();
	// Both raw tables are pruned by this job, so the day list is the UNION of their
	// prunable days — a day holding only card displays (no page view got through the
	// door) is exactly as owed its rollup as one holding views.
	const result = await db.execute(sql`
		SELECT day FROM (
			SELECT DISTINCT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM traffic_events WHERE created_at < ${cutoffIso}::timestamptz
			UNION
			SELECT DISTINCT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM card_impressions WHERE created_at < ${cutoffIso}::timestamptz
		) prunable
		-- Oldest first: a backlog drains from its head, and maxDays bounds one run.
		ORDER BY day
		LIMIT ${maxDays}
	`);
	return rowsOf<{ day: string }>(result).map((r) => r.day);
}

/** Distinct sessions ever seen in raw rows — an operator's liveness reading, not a published metric. */
export async function rawSessionCount(): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(distinct ${trafficEvents.sessionId})::int` })
		.from(trafficEvents)
		.where(isNotNull(trafficEvents.sessionId));
	return row?.count ?? 0;
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Global search for the topbar's Search mode.
 *
 * Two passes over the same query. **Names** matches a creator's display name or handle,
 * and a Work's, Project's or Post's title — the fast, high-signal pass. **Body** matches
 * the secondary prose (a bio, a description, a Post's body) and is only requested when the
 * names pass has come up short; the client decides that from the count and sends a second
 * request. The server never runs both in one call, so the first result never waits on the
 * slower fields.
 *
 * 🚨 **A search result is a listing, and every listing carries the same rules.** Each kind
 * gets its visibility conditions — released/published, not blocked, not suspended, not the
 * automated-test account — and Works additionally carry `maturityHiddenFrom` and
 * `parentalHiddenFrom`. A Project whose released Works are all hidden from this viewer is
 * absent, because its title and cover would otherwise announce what the rung withholds.
 * These are `WHERE` conditions, before the limit, for the reason every other listing gives:
 * filtering a page afterwards silently returns short pages.
 *
 * ⭐ **Connected rows rank first.** The viewer's own rows, then what is in their Library,
 * then what a creator they follow made, then everything else; within a tier, an exact title
 * beats a prefix, a prefix beats a later match, and recency breaks the rest. Rank here
 * rather than in the panel so the API suite can prove it.
 */
import { db } from "@anthers/db/client";
import { follows, libraryItems, posts, projects, users, works } from "@anthers/db/schema";
import {
	isSearchScope,
	isSearchType,
	SEARCH_TYPES,
	type SearchConnection,
	type SearchHit,
	type SearchScope,
	type SearchType,
	searchTerms,
} from "@anthers/shared/search";
import { and, type Column, desc, eq, notInArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { notSuspendedAccount, notTestAccount } from "../services/account-visibility.js";
import { notBlockedBy } from "../services/blocks.js";
import { adultVisibility, maturityHiddenFrom } from "../services/content-preferences.js";
import { isCreatorWhere } from "../services/creator-standing.js";
import { parentalHiddenFrom, parentalVisibility } from "../services/parental-controls.js";
import { matchesFields } from "../services/search-query.js";
import { resolveThumbnailUrl } from "../services/thumbnails.js";

/** A row plus the two values ranking needs and the response does not ship. */
type RankedHit = SearchHit & { sortAt: number; matchRank: number };

type Visibility = {
	adult: Awaited<ReturnType<typeof adultVisibility>>;
	parental: Awaited<ReturnType<typeof parentalVisibility>>;
};

/** The per-type cap the route will honor. The client asks for five or twenty. */
const MAX_LIMIT = 20;

/**
 * `EXISTS` over the viewer's Library, one function per kind.
 *
 * Kept as three small functions rather than one parameterized helper: the column is part
 * of the SQL, and a template cannot name a column the way it names a value.
 */
function workSavedBy(viewerId: number): SQL<boolean> {
	return sql<boolean>`EXISTS (SELECT 1 FROM ${libraryItems} li WHERE li.user_id = ${viewerId} AND li.work_id = ${works.id})`;
}

function projectSavedBy(viewerId: number): SQL<boolean> {
	return sql<boolean>`EXISTS (SELECT 1 FROM ${libraryItems} li WHERE li.user_id = ${viewerId} AND li.project_id = ${projects.id})`;
}

function postSavedBy(viewerId: number): SQL<boolean> {
	return sql<boolean>`EXISTS (SELECT 1 FROM ${libraryItems} li WHERE li.user_id = ${viewerId} AND li.post_id = ${posts.id})`;
}

/** Whether the viewer follows the creator a row belongs to. */
function followingCreator(viewerId: number, creatorColumn: SQL | Column): SQL<boolean> {
	return sql<boolean>`EXISTS (SELECT 1 FROM ${follows} f WHERE f.follower_id = ${viewerId} AND f.creator_id = ${creatorColumn})`;
}

function connectionOf(
	viewerId: number,
	creatorId: number | null,
	saved: boolean,
	following: boolean,
): SearchConnection {
	if (creatorId === viewerId) return "self";
	if (saved) return "library";
	if (following) return "following";
	return null;
}

function connectionRank(connection: SearchConnection): number {
	if (connection === "self") return 0;
	if (connection === "library") return 1;
	if (connection === "following") return 2;
	return 3;
}

/**
 * Exact title, then prefix, then a later title match. Body matches are all the same tier:
 * the term is present, and there is no stronger place in a description or bio for it.
 */
function matchRankOf(title: string, query: string, scope: SearchScope): number {
	if (scope === "body") return 3;
	const lower = title.toLowerCase();
	if (lower === query) return 0;
	if (lower.startsWith(query)) return 1;
	return 2;
}

function subtitleFor(name: string | null, handle: string | null): string | null {
	return name || handle || null;
}

const workTypeLabel = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/**
 * The Project's own title and thumbnail may describe what its Works contain, so a Project
 * holding only Works this viewer cannot see is absent. This is the condition the public
 * Projects listing carries, reproduced here against the same aliases.
 */
function projectMembersVisible(visibility: Visibility, viewerId: number): SQL {
	const memberVisible =
		and(
			maturityHiddenFrom(
				visibility.adult.prefs,
				viewerId,
				sql`w.creator_id`,
				sql`w.maturity`,
				sql`w.maturity_rows`,
			),
			parentalHiddenFrom(visibility.parental.policy, viewerId, sql`w.creator_id`, sql`w.type`),
		) ?? sql`true`;
	return sql`(
		NOT EXISTS (
			SELECT 1 FROM project_items pi
			JOIN works w ON w.id = pi.work_id
			WHERE pi.project_id = ${projects.id} AND w.visibility = 'released'
		)
		OR EXISTS (
			SELECT 1 FROM project_items pi
			JOIN works w ON w.id = pi.work_id
			WHERE pi.project_id = ${projects.id} AND w.visibility = 'released' AND (${memberVisible})
		)
	)`;
}

/** Exclusions the client sends for the second pass: the rows the first pass already showed. */
function excludedIds(excluded: Map<SearchType, Set<number>>, kind: SearchType): number[] {
	return [...(excluded.get(kind) ?? [])];
}

async function searchCreators(
	viewerId: number,
	terms: string[],
	scope: SearchScope,
	limit: number,
	excluded: Map<SearchType, Set<number>>,
	query: string,
): Promise<RankedHit[]> {
	const fields = scope === "names" ? [users.displayName, users.atprotoHandle] : [users.bio];
	const excludedHere = excludedIds(excluded, "creator");
	const rows = await db
		.select({
			id: users.id,
			handle: users.atprotoHandle,
			displayName: users.displayName,
			avatar: users.avatar,
			createdAt: users.createdAt,
			isFollowing: followingCreator(viewerId, users.id),
		})
		.from(users)
		.where(
			and(
				isCreatorWhere(users.id),
				matchesFields(terms, fields),
				notBlockedBy(viewerId, users.id),
				notSuspendedAccount(users.id),
				notTestAccount(users.id),
				excludedHere.length > 0 ? notInArray(users.id, excludedHere) : undefined,
			),
		)
		.orderBy(desc(users.createdAt))
		.limit(limit);

	return Promise.all(
		rows.map(async (row) => {
			const title = row.displayName || row.handle;
			return {
				kind: "creator" as const,
				id: row.id,
				title,
				subtitle: row.displayName ? row.handle : null,
				thumbnail: await resolveThumbnailUrl(row.avatar),
				handle: row.handle,
				slug: null,
				publicId: null,
				connection: connectionOf(viewerId, row.id, false, row.isFollowing),
				sortAt: row.createdAt.getTime(),
				matchRank: matchRankOf(title, query, scope),
			};
		}),
	);
}

async function searchWorks(
	viewerId: number,
	terms: string[],
	scope: SearchScope,
	limit: number,
	excluded: Map<SearchType, Set<number>>,
	query: string,
	visibility: Visibility,
): Promise<RankedHit[]> {
	const fields = scope === "names" ? [works.title] : [works.description];
	const excludedHere = excludedIds(excluded, "work");
	const rows = await db
		.select({
			id: works.id,
			publicId: works.publicId,
			slug: works.slug,
			title: works.title,
			thumbnail: works.thumbnail,
			type: works.type,
			creatorId: works.creatorId,
			handle: users.atprotoHandle,
			displayName: users.displayName,
			releasedAt: works.releasedAt,
			createdAt: works.createdAt,
			isSaved: workSavedBy(viewerId),
			isFollowing: followingCreator(viewerId, works.creatorId),
		})
		.from(works)
		.innerJoin(users, eq(users.id, works.creatorId))
		.where(
			and(
				eq(works.visibility, "released"),
				eq(works.takedownStatus, "active"),
				eq(works.quarantineStatus, "none"),
				matchesFields(terms, fields),
				notBlockedBy(viewerId, works.creatorId),
				notSuspendedAccount(works.creatorId),
				notTestAccount(works.creatorId),
				visibility.adult.hidden,
				visibility.parental.hidden,
				excludedHere.length > 0 ? notInArray(works.id, excludedHere) : undefined,
			),
		)
		.orderBy(desc(works.releasedAt))
		.limit(limit);

	return Promise.all(
		rows.map(async (row) => {
			const name = subtitleFor(row.displayName, row.handle);
			return {
				kind: "work" as const,
				id: row.id,
				title: row.title ?? "",
				subtitle: name ? `${workTypeLabel(row.type)} by ${name}` : workTypeLabel(row.type),
				thumbnail: await resolveThumbnailUrl(row.thumbnail),
				handle: row.handle,
				slug: row.slug,
				publicId: row.publicId,
				connection: connectionOf(viewerId, row.creatorId, row.isSaved, row.isFollowing),
				sortAt: (row.releasedAt ?? row.createdAt).getTime(),
				matchRank: matchRankOf(row.title ?? "", query, scope),
			};
		}),
	);
}

async function searchProjects(
	viewerId: number,
	terms: string[],
	scope: SearchScope,
	limit: number,
	excluded: Map<SearchType, Set<number>>,
	query: string,
	visibility: Visibility,
): Promise<RankedHit[]> {
	const fields = scope === "names" ? [projects.title] : [projects.description];
	const excludedHere = excludedIds(excluded, "project");
	const rows = await db
		.select({
			id: projects.id,
			slug: projects.slug,
			title: projects.title,
			thumbnail: projects.thumbnail,
			creatorId: projects.creatorId,
			handle: users.atprotoHandle,
			displayName: users.displayName,
			updatedAt: projects.updatedAt,
			isSaved: projectSavedBy(viewerId),
			isFollowing: followingCreator(viewerId, projects.creatorId),
		})
		.from(projects)
		.innerJoin(users, eq(users.id, projects.creatorId))
		.where(
			and(
				eq(projects.isPublished, true),
				matchesFields(terms, fields),
				notBlockedBy(viewerId, projects.creatorId),
				notSuspendedAccount(projects.creatorId),
				notTestAccount(projects.creatorId),
				projectMembersVisible(visibility, viewerId),
				excludedHere.length > 0 ? notInArray(projects.id, excludedHere) : undefined,
			),
		)
		.orderBy(desc(projects.updatedAt))
		.limit(limit);

	return Promise.all(
		rows.map(async (row) => ({
			kind: "project" as const,
			id: row.id,
			title: row.title,
			subtitle: subtitleFor(row.displayName, row.handle),
			thumbnail: await resolveThumbnailUrl(row.thumbnail),
			handle: row.handle,
			slug: row.slug,
			publicId: null,
			connection: connectionOf(viewerId, row.creatorId, row.isSaved, row.isFollowing),
			sortAt: row.updatedAt.getTime(),
			matchRank: matchRankOf(row.title, query, scope),
		})),
	);
}

async function searchPosts(
	viewerId: number,
	terms: string[],
	scope: SearchScope,
	limit: number,
	excluded: Map<SearchType, Set<number>>,
	query: string,
): Promise<RankedHit[]> {
	const fields = scope === "names" ? [posts.title] : [posts.body];
	const excludedHere = excludedIds(excluded, "post");
	const rows = await db
		.select({
			id: posts.id,
			publicId: posts.publicId,
			slug: posts.slug,
			title: posts.title,
			creatorId: posts.creatorId,
			handle: users.atprotoHandle,
			displayName: users.displayName,
			publishedAt: posts.publishedAt,
			createdAt: posts.createdAt,
			isSaved: postSavedBy(viewerId),
			isFollowing: followingCreator(viewerId, posts.creatorId),
		})
		.from(posts)
		.innerJoin(users, eq(users.id, posts.creatorId))
		.where(
			and(
				eq(posts.isPublished, true),
				matchesFields(terms, fields),
				notBlockedBy(viewerId, posts.creatorId),
				notSuspendedAccount(posts.creatorId),
				notTestAccount(posts.creatorId),
				excludedHere.length > 0 ? notInArray(posts.id, excludedHere) : undefined,
			),
		)
		.orderBy(desc(posts.publishedAt))
		.limit(limit);

	return Promise.all(
		rows.map(async (row) => {
			const title = row.title || "Untitled post";
			return {
				kind: "post" as const,
				id: row.id,
				title,
				subtitle: subtitleFor(row.displayName, row.handle),
				thumbnail: null,
				handle: row.handle,
				slug: row.slug,
				publicId: row.publicId,
				connection: connectionOf(viewerId, row.creatorId, row.isSaved, row.isFollowing),
				sortAt: (row.publishedAt ?? row.createdAt).getTime(),
				matchRank: matchRankOf(row.title ?? "", query, scope),
			};
		}),
	);
}

/** The response shape is the public `SearchHit`; ranking fields stay here. */
function toHit(hit: RankedHit): SearchHit {
	return {
		kind: hit.kind,
		id: hit.id,
		title: hit.title,
		subtitle: hit.subtitle,
		thumbnail: hit.thumbnail,
		handle: hit.handle,
		slug: hit.slug,
		publicId: hit.publicId,
		connection: hit.connection,
	};
}

const searchRoutes = new Hono().get("/", requireAuth, async (c) => {
	const viewer = c.get("user");
	const terms = searchTerms(c.req.query("q") ?? "");
	if (terms.length === 0) return c.json({ results: [] });

	const scopeRaw = c.req.query("scope") ?? "names";
	if (!isSearchScope(scopeRaw)) return c.json({ error: "Unknown search scope." }, 400);
	const typeRaw = c.req.query("type");
	if (typeRaw != null && typeRaw !== "all" && !isSearchType(typeRaw)) {
		return c.json({ error: "Unknown search type." }, 400);
	}

	const requested = Number(c.req.query("limit"));
	const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : 5;
	const query = terms.join(" ");
	const kinds: SearchType[] = typeRaw && typeRaw !== "all" ? [typeRaw] : [...SEARCH_TYPES];
	const excluded = new Map<SearchType, Set<number>>();
	for (const entry of (c.req.query("exclude") ?? "").split(",").slice(0, 200)) {
		const [kind, idText] = entry.split(":");
		const id = Number(idText);
		if (!isSearchType(kind) || !Number.isInteger(id) || id <= 0) continue;
		const set = excluded.get(kind) ?? new Set<number>();
		set.add(id);
		excluded.set(kind, set);
	}

	const visibility: Visibility = {
		adult: await adultVisibility(viewer.id),
		parental: await parentalVisibility(viewer.id),
	};
	// A Record rather than a switch: `SearchType` is a closed set, and the type checker
	// refuses a map that misses one, while a switch can fall through a case somebody adds
	// later and return `undefined` where a promise was promised.
	const searchers: Record<SearchType, () => Promise<RankedHit[]>> = {
		creator: () => searchCreators(viewer.id, terms, scopeRaw, limit, excluded, query),
		work: () => searchWorks(viewer.id, terms, scopeRaw, limit, excluded, query, visibility),
		project: () => searchProjects(viewer.id, terms, scopeRaw, limit, excluded, query, visibility),
		post: () => searchPosts(viewer.id, terms, scopeRaw, limit, excluded, query),
	};
	const pending = kinds.map((kind) => searchers[kind]());
	const hits = (await Promise.all(pending)).flat();

	// The rank is the promise: connected first, then the strongest title match, then
	// recency. Sorting here, not in SQL, because the order spans four different queries.
	hits.sort(
		(a, b) =>
			connectionRank(a.connection) - connectionRank(b.connection) ||
			a.matchRank - b.matchRank ||
			b.sortAt - a.sortAt,
	);

	return c.json({ results: hits.slice(0, limit * SEARCH_TYPES.length).map(toHit) });
});

export { searchRoutes };

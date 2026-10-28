// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: Projects, which group Works and Posts.
 *
 * A Project is a creator's shelf and its own page; it confers no access on anything it holds.
 *
 * Split out of `routes/content.ts` on 2026-10-28; docblocks moved with their code.
 */

import { db } from "@anthers/db/client";
import { posts, projectItems, projectPosts, projects, users, works } from "@anthers/db/schema";
import type { WorkType } from "@anthers/shared/content";
import {
	asProjectSortDirection,
	asProjectSortMode,
	sortProjectItems,
} from "@anthers/shared/project-sort";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, like, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { embedCreator } from "../../lib/handles.js";
import { displayPostTitles } from "../../lib/post-title-mentions.js";
import { getOptionalUserId, requireAuth } from "../../middleware/auth.js";
import {
	type AccessibleWork,
	buildAccessContext,
	resolveAccessSync,
} from "../../services/access.js";
import { notSuspendedAccount, notTestAccount } from "../../services/account-visibility.js";
import { PROJECT_COLLECTION } from "../../services/atproto-record-plan.js";
import { queueRecordRemoval } from "../../services/atproto-record-removal.js";
import { recordUrlFor } from "../../services/atproto-repo.js";
import { adultVisibility, maturityHiddenFrom } from "../../services/content-preferences.js";
import { parentalHiddenFrom, parentalVisibility } from "../../services/parental-controls.js";
import { publishRefusal } from "../../services/publish-refusal.js";
import { queueRecordSync } from "../../services/record-sync.js";
import { FOREIGN_FILE_REFUSAL, isOwnStorageRef } from "../../services/storage/keys.js";
import {
	allowanceSpent,
	contextFor,
	deliveryCtx,
	loadWorkBundles,
	previewRequest,
	resolveProjectThumbnails,
	resolveWorkThumbnail,
	serializeWorkForUser,
} from "../content.js";
import {
	addPostToProjectSchema,
	addWorkToProjectSchema,
	createProjectSchema,
	projectsId,
	updateProjectSchema,
} from "./schemas.js";

const projectsRoutes = new Hono()
	// ══════════════════════════════════════════════════════════════════════════
	// PROJECTS — they group Works and Posts
	// ══════════════════════════════════════════════════════════════════════════

	.get("/projects", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		// A whitespace-only search or price (a bare space from the filter box, a number
		// input's intermediate state) is a truthy string but matches nothing sensible:
		// `search` becomes a like('% %') over every row and a blank `min_price` fails
		// the ::numeric cast with a 500. Trimmed to nothing so the falsy checks below
		// treat them as absent — the browser bug that sends them is fixed at the inputs
		// as well, but the API declines garbage rather than guessing what it meant.
		const search = c.req.query("search")?.trim() || undefined;
		// Discover's sidebar has always sent these; until now the handler read none of
		// them, so every filter control on the page did nothing while looking like it
		// worked. They key on the project's **Works**, because a project is a collection
		// and has no type, tags or price of its own.
		const mediaType = c.req.query("media_type");
		const tag = c.req.query("tag");
		const pricing = c.req.query("pricing");
		const sort = c.req.query("sort") ?? "newest";
		const minPrice = c.req.query("min_price")?.trim() || undefined;
		const maxPrice = c.req.query("max_price")?.trim() || undefined;
		const platform = c.req.query("platform");
		const duration = c.req.query("duration");
		const showLocked = c.req.query("show_locked");
		// `on_sale` is accepted and ignored: there is no discount, sale-price or promotion
		// concept anywhere in the schema, so there is nothing to filter on. The control was
		// removed from the sidebar rather than left drawing a checkbox over nothing; this
		// keeps an older client from 400ing on a param it still remembers.
		void c.req.query("on_sale");

		/**
		 * A project matches when ANY released Work in it matches: a Project is
		 * described by what it contains, so "games" means "contains a game" rather than
		 * "contains only games". Private and withdrawn Works never qualify a project for
		 * a public listing.
		 */
		const containsWork = (predicate: SQL) => sql`EXISTS (
			SELECT 1 FROM project_items pi
			JOIN works w ON w.id = pi.work_id
			WHERE pi.project_id = ${projects.id} AND w.visibility = 'released' AND (${predicate})
		)`;

		/** Any allowed row on the Work's access table — there is exactly one such table. */
		const anyAccessRow = (predicate: SQL) => sql`EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(w.access, '[]'::jsonb)) r
			WHERE (r->>'allow')::boolean AND (${predicate})
		)`;

		/** The cheapest allowed offer on a Work, for the price-range filter. */
		const cheapestPrice = sql`(
			SELECT MIN((r->>'price')::numeric)
			FROM jsonb_array_elements(COALESCE(w.access, '[]'::jsonb)) r
			WHERE (r->>'allow')::boolean
		)`;

		const conditions: SQL[] = [];
		if (mine === "true") {
			const userId = await getOptionalUserId(c);
			if (!userId) return c.json({ projects: [] });
			conditions.push(eq(projects.creatorId, userId));
		} else {
			conditions.push(eq(projects.isPublished, true));
			// A suspended account's Projects go dark with everything else it made, before
			// any LIMIT, the same way the feed drops its posts.
			conditions.push(notSuspendedAccount(projects.creatorId) as SQL);
			// The automated-test account's Projects are hidden from the listing too, on
			// the same query-condition pattern.
			conditions.push(notTestAccount(projects.creatorId) as SQL);
		}

		// 🚨 **A project whose released Works are all ones the user may not see is absent too.**
		// A project carries no rating of its own, but its title and thumbnail describe what is in
		// it, so a project holding only Adult work would otherwise announce that work's existence
		// to somebody who has not opted in — the thing the rung withholds. A project with no
		// released Works at all is still listed, since there is nothing in it to disclose.
		const listingUserId = await getOptionalUserId(c);
		const [{ prefs: userPrefs }, { policy: userPolicy }] = await Promise.all([
			adultVisibility(listingUserId),
			parentalVisibility(listingUserId),
		]);
		const memberVisible = and(
			maturityHiddenFrom(
				userPrefs,
				listingUserId,
				sql`w.creator_id`,
				sql`w.maturity`,
				sql`w.maturity_rows`,
			),
			parentalHiddenFrom(userPolicy, listingUserId, sql`w.creator_id`, sql`w.type`),
		);
		conditions.push(sql`(
			NOT EXISTS (
				SELECT 1 FROM project_items pi JOIN works w ON w.id = pi.work_id
				WHERE pi.project_id = ${projects.id} AND w.visibility = 'released'
			)
			OR ${containsWork(memberVisible ?? sql`true`)}
		)`);

		if (creator) {
			const [user] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.atprotoHandle, creator))
				.limit(1);
			if (!user) return c.json({ projects: [] });
			conditions.push(eq(projects.creatorId, user.id));
		}

		if (search) {
			conditions.push(
				or(like(projects.title, `%${search}%`), like(projects.description, `%${search}%`)) as SQL,
			);
		}

		if (mediaType) conditions.push(containsWork(sql`w.type = ${mediaType}`));
		if (tag) conditions.push(containsWork(sql`w.tags @> ${JSON.stringify([tag])}::jsonb`));

		// `free` is the baseline row the resolver calls universally free; `paid` is any
		// priced offer; `gated` is a threshold you must hold rather than buy. They overlap
		// on purpose — a project can hold a free Work and a priced one, and answering
		// "show me free things" with "only wholly-free Projects" would hide it.
		if (pricing === "free") {
			conditions.push(
				containsWork(
					anyAccessRow(sql`(r->>'threshold')::numeric = 0 AND (r->>'price')::numeric <= 0`),
				),
			);
		} else if (pricing === "paid") {
			conditions.push(containsWork(anyAccessRow(sql`(r->>'price')::numeric > 0`)));
		} else if (pricing === "gated") {
			conditions.push(containsWork(anyAccessRow(sql`(r->>'threshold')::numeric > 0`)));

			// "Show locked content" is OFF by default, so a gated browse shows only what
			// this user can actually open. That needs the access rules in SQL rather
			// than the usual `resolveAccessSync` pass, because filtering in memory would
			// run AFTER `LIMIT 100` and silently return fewer rows to some users than
			// others — a filter whose result depends on who is asking is exactly the kind
			// that has to be part of the query.
			//
			// Signed-out users are exempt: everything gated is locked to them, so the
			// filter would empty the list every time and read as a broken page rather than
			// as a filter doing its job. "Hide what I can't open" only means something
			// once there is something you can.
			const userId = await getOptionalUserId(c);
			if (showLocked !== "true" && userId != null) {
				const ctx = await buildAccessContext(userId);
				// The access table compares against what the user gives *that Work's creator*,
				// a different number per row, so the user's allocations travel as a jsonb map
				// keyed by creator id and are looked up per row.
				const seedMap = JSON.stringify(Object.fromEntries(ctx.supportByCreator));
				// Coerced explicitly because the ids are inlined rather than bound: they
				// come from our own `purchases` rows and are integers already, and this is
				// what keeps that true if the source ever changes.
				const purchased = [...ctx.purchasedWorkIds].map(Number).filter(Number.isInteger);
				conditions.push(
					containsWork(sql`(
						${userId} = w.creator_id
						OR w.id = ANY(${sql.raw(`ARRAY[${purchased.length ? purchased.join(",") : ""}]::int[]`)})
						OR EXISTS (
							SELECT 1 FROM jsonb_array_elements(COALESCE(w.access, '[]'::jsonb)) r
							WHERE (r->>'allow')::boolean AND (r->>'price')::numeric <= 0
								-- 🚨 ::numeric on BOTH sides. Every one of these casts was ::int
								-- until 2026-08-16, which was correct while a threshold counted
								-- whole Seeds and is now a hard 500: Postgres refuses "9.5" as an
								-- integer outright. Found by the gauntlet's deliberately
								-- non-round $9.50 rung — added to catch a FLOAT comparison in
								-- JS, and it caught an integer cast in SQL instead, which is the
								-- better argument for having put it there.
								AND (r->>'threshold')::numeric
									<= COALESCE((${seedMap}::jsonb ->> w.creator_id::text)::numeric, 0)
						)
					)`),
				);
			}
		}

		// Price range applies to the cheapest offer, which is the one the buyer would pay.
		if (minPrice) conditions.push(containsWork(sql`${cheapestPrice} >= ${minPrice}::numeric`));
		if (maxPrice) conditions.push(containsWork(sql`${cheapestPrice} <= ${maxPrice}::numeric`));

		// Platform lives on the downloadable build, not the Work — a game ships several.
		if (platform) {
			conditions.push(
				containsWork(
					sql`EXISTS (SELECT 1 FROM work_assets a WHERE a.work_id = w.id AND a.platform = ${platform})`,
				),
			);
		}

		// Duration bands differ by medium — half an hour is a long track and a short film —
		// so they are read against the media type the user has already selected, and
		// ignored without one rather than guessing which scale was meant.
		// `null` upper bound means unbounded — not a sentinel, because `duration_seconds`
		// is int4 and any "very large" stand-in either overflows the column type or
		// invites someone to pick one that doesn't.
		const BANDS: Record<string, Record<string, [number, number | null]>> = {
			music: { short: [0, 300], medium: [300, 1800], long: [1800, null] },
			// A podcast episode or an audiobook runs on a film's scale rather than a song's.
			audio: { short: [0, 600], medium: [600, 3600], long: [3600, null] },
			video: { short: [0, 600], medium: [600, 3600], long: [3600, null] },
		};
		const band = duration && mediaType ? BANDS[mediaType]?.[duration] : undefined;
		if (band) {
			const upper = band[1] === null ? sql`` : sql` AND w.duration_seconds < ${band[1]}`;
			conditions.push(
				containsWork(
					sql`w.duration_seconds IS NOT NULL AND w.duration_seconds >= ${band[0]}${upper}`,
				),
			);
		}

		// Summed views and the recommended share both range over the project's released Works, for the
		// same reason the filters do. `trending` is deliberately absent: it needs views over
		// a window and `works.view_count` is a lifetime counter, so there is nothing honest
		// to order by — the option is gone from the sidebar rather than silently aliased.
		const newest = desc(projects.createdAt);
		let orderClause: SQL[];
		switch (sort) {
			case "popular":
				orderClause = [
					sql`(SELECT COALESCE(SUM(w.view_count), 0) FROM project_items pi JOIN works w ON w.id = pi.work_id
						WHERE pi.project_id = ${projects.id} AND w.visibility = 'released') DESC`,
					newest as unknown as SQL,
				];
				break;
			case "most_recommended":
				// The share of visible reviews that recommended it, which is what the public
				// figure on a Work is. ⚠️ Raw SQL, so nothing typechecks the column name here —
				// a rename that misses this line sorts by nothing and reports no error.
				orderClause = [
					sql`(SELECT AVG(CASE WHEN rt.verdict = 'recommended' THEN 1.0 ELSE 0 END)
						FROM project_items pi JOIN reviews rt ON rt.work_id = pi.work_id
						WHERE pi.project_id = ${projects.id} AND rt.moderation_status = 'visible') DESC NULLS LAST`,
					newest as unknown as SQL,
				];
				break;
			default:
				orderClause = [newest as unknown as SQL];
		}

		const result = await db
			.select({
				project: projects,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
				postCount: sql<number>`(SELECT COUNT(*)::int FROM project_posts WHERE project_id = ${projectsId})`,
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(...orderClause)
			.limit(100);

		/**
		 * The Studio's Projects table shows each Project's works as a thumbnail grid beside
		 * the project block, and the owner's listing is the only caller that sends `mine`,
		 * so the works ride this same call rather than one fetch per project. The owner
		 * already holds every state serialized here — private and withdrawn included —
		 * which is what makes an owner-only shape safe to lean. One batched query over the
		 * page's projects, grouped in memory; a correlated subquery per row would run a
		 * hundred queries at a Catalog's size for the same bytes.
		 */
		const worksByProject: Map<
			number,
			{
				id: number;
				publicId?: number;
				slug?: string;
				title: string | null;
				type: WorkType;
				thumbnail: string | null;
				visibility?: "private" | "released" | "withdrawn";
				sortOrder: number;
			}[]
		> | null = mine === "true" && result.length > 0 ? new Map() : null;
		if (worksByProject) {
			const itemRows = await db
				.select({
					projectId: projectItems.projectId,
					sortOrder: projectItems.sortOrder,
					id: works.id,
					publicId: works.publicId,
					slug: works.slug,
					title: works.title,
					type: works.type,
					thumbnail: works.thumbnail,
					visibility: works.visibility,
				})
				.from(projectItems)
				.innerJoin(works, eq(projectItems.workId, works.id))
				.where(
					inArray(
						projectItems.projectId,
						result.map((r) => r.project.id),
					),
				)
				.orderBy(asc(projectItems.sortOrder));
			for (const row of itemRows) {
				const list = worksByProject.get(row.projectId) ?? [];
				list.push({
					id: row.id,
					publicId: row.publicId,
					slug: row.slug,
					title: row.title,
					// Text columns arrive as strings; the column's own comment hands the
					// invariant that they hold only the published vocabulary. Asserting it
					// here keeps the response's shape honest — the client types its unions.
					type: row.type as WorkType,
					thumbnail: row.thumbnail,
					visibility:
						row.visibility === "released" || row.visibility === "withdrawn"
							? row.visibility
							: "private",
					sortOrder: row.sortOrder,
				});
				worksByProject.set(row.projectId, list);
			}
		}

		/**
		 * A Project whose thumbnail is one of its Works reads that Work's thumbnail here too,
		 * filtered by what this reader may see — the owner's `mine` listing sees every
		 * Work of theirs, a public listing only the ones it could open.
		 */
		const projectThumbnails = await resolveProjectThumbnails(
			result.map((r) => r.project),
			{ userId: listingUserId, seeAll: mine === "true" },
		);

		return c.json({
			projects: result.map((r) => ({
				...r.project,
				thumbnail: projectThumbnails.get(r.project.id) ?? r.project.thumbnail,
				postCount: Number(r.postCount),
				// Only the Studio's listing carries it; the public shape never does.
				...(worksByProject ? { worksSummary: worksByProject.get(r.project.id) ?? [] } : {}),
				creator: embedCreator({
					handle: r.creatorHandle,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				}),
			})),
		});
	})

	.post("/projects", requireAuth, zValidator("json", createProjectSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// A draft project is open to anyone, as a draft Work is; publishing one takes a fully
		// set-up creator, the same as releasing a Work or publishing a post.
		if (data.isPublished) {
			const refusal = await publishRefusal(user, "publish");
			if (refusal) return c.json(refusal.body, refusal.status);
		}

		if (!(await isOwnStorageRef(data.thumbnail ?? "", user.id))) {
			return c.json(FOREIGN_FILE_REFUSAL, 400);
		}
		if (!(await isOwnStorageRef(data.thumbnailSource ?? "", user.id))) {
			return c.json(FOREIGN_FILE_REFUSAL, 400);
		}

		const [existing] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, data.slug))
			.limit(1);
		if (existing) return c.json({ error: "A project with this slug already exists" }, 409);

		const [project] = await db
			.insert(projects)
			.values({
				creatorId: user.id,
				title: data.title,
				slug: data.slug,
				description: data.description,
				thumbnail: data.thumbnail,
				thumbnailSource: data.thumbnailSource,
				thumbnailCrop: data.thumbnailCrop ?? null,
				pageConfig: data.pageConfig ?? {},
				...(data.worksSortMode ? { worksSortMode: data.worksSortMode } : {}),
				...(data.worksSortDirection ? { worksSortDirection: data.worksSortDirection } : {}),
				...(data.postsSortMode ? { postsSortMode: data.postsSortMode } : {}),
				...(data.postsSortDirection ? { postsSortDirection: data.postsSortDirection } : {}),
				isPublished: data.isPublished,
			})
			.returning();

		void queueRecordSync("project", project.id);

		return c.json({ project }, 201);
	})

	.get("/projects/:slug", async (c) => {
		const { slug } = c.req.param();
		const userId = await getOptionalUserId(c);

		const result = await db
			.select({
				project: projects,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(
				and(
					eq(projects.slug, slug),
					// A suspended creator's Project page reads as not found — the listing's
					// filter is the route's WHERE so the answer never depends on which
					// surface was asked. User-independent, so the owner's own row drops
					// too; a suspended account cannot sign in to reach it anyway.
					notSuspendedAccount(projects.creatorId),
					// The automated-test account's Project page reads as not found the
					// same way, so it never surfaces from a link that starts at a listing.
					notTestAccount(projects.creatorId),
				),
			)
			.limit(1);

		if (result.length === 0) return c.json({ error: "Project not found" }, 404);
		const row = result[0];
		// A draft Project is its creator's business, exactly as a private Work is: it 404s
		// for everyone else, because the existence of unreleased work is itself not public
		// information — and this route's member filtering (the drafts of WORKS and posts
		// below) was never the project's own gate. Drafts reach their owner through the
		// same URL; the editor lives there for published and draft rows alike.
		if (row.project.isPublished !== true && userId !== row.project.creatorId) {
			return c.json({ error: "Project not found" }, 404);
		}

		const memberRows = await db
			.select({
				post: posts,
				sortOrder: projectPosts.sortOrder,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(projectPosts)
			.innerJoin(posts, eq(projectPosts.postId, posts.id))
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(
				and(
					eq(projectPosts.projectId, row.project.id),
					// Draft members are the creator's own business. This route is
					// unauthenticated and filtered neither the project's `isPublished` nor its
					// members', so a draft added to a project leaked its title, slug and
					// thumbnail to anyone holding the project URL. Metadata only — post detail
					// already 404'd and the delivery routes re-resolve — but a leak all the same.
					userId === row.project.creatorId ? undefined : eq(posts.isPublished, true),
				),
			)
			.orderBy(asc(projectPosts.sortOrder), asc(posts.createdAt));

		// The Works in this Project, each resolved on its own gates. A Project groups its
		// Works: putting one here changes nothing about who can open it.
		const itemRows = await db
			.select({ work: works, sortOrder: projectItems.sortOrder })
			.from(projectItems)
			.innerJoin(works, eq(projectItems.workId, works.id))
			.where(
				and(
					eq(projectItems.projectId, row.project.id),
					// A creator browsing their own project sees drafts; nobody else does.
					userId === row.project.creatorId ? undefined : eq(works.visibility, "released"),
					// A project is a listing like any other, so an Adult member is absent
					// from it rather than present and locked.
					(await adultVisibility(userId)).hidden,
					// A guardian's blocks hide as well as refuse — a grid of cards a child
					// cannot click is an advertisement, not a protection.
					(await parentalVisibility(userId)).hidden,
				),
			)
			.orderBy(asc(projectItems.sortOrder));

		const memberWorkIds = itemRows.map((r) => r.work.id);
		const { assetsByWork, jobByWork, pagesByWork, sectionsByWork, buildsByWork } =
			await loadWorkBundles(memberWorkIds);
		const [workCtx, projectSpent] = await Promise.all([
			buildAccessContext(userId, { workIds: memberWorkIds }),
			allowanceSpent(userId),
		]);
		await Promise.all(itemRows.map((r) => resolveWorkThumbnail(r.work)));

		// The thumbnail chosen from a Work is resolved from the list this reader already sees:
		// a Work hidden from them contributes nothing and the uploaded image stands in.
		const thumbnailWork = itemRows.find((m) => m.work.id === row.project.thumbnailWorkId)?.work;
		/*
		 * The Project's saved sort settings order both shelves (2026-10-19). `sortProjectItems`
		 * copies, so each member keeps the `sortOrder` its membership carries — the drag
		 * order — while the array a reader receives is the reading order the creator
		 * chose. Manual is the default and returns the stored order untouched.
		 */
		const serializedWorks = await Promise.all(
			itemRows.map(async (m) => ({
				sortOrder: m.sortOrder,
				...(await serializeWorkForUser(
					m.work,
					assetsByWork.get(m.work.id) ?? [],
					jobByWork.get(m.work.id) ?? null,
					resolveAccessSync(
						m.work as AccessibleWork,
						contextFor(m.work, userId, workCtx, previewRequest(c)),
					),
					deliveryCtx(),
					projectSpent,
					userId,
					pagesByWork.get(m.work.id) ?? 0,
					sectionsByWork.get(m.work.id) ?? 0,
					(buildsByWork.get(m.work.id) ?? []).some((b) => b.isPrimary),
					(buildsByWork.get(m.work.id) ?? []).find((b) => b.isPrimary)?.requiresIsolation ?? false,
				)),
			})),
		);

		// The names behind the member posts' title mentions, in one lookup for the page.
		const memberPostTitles = await displayPostTitles(
			memberRows.map((m) => m.post.title),
			userId,
		);
		// No per-post access verdict: a post has no gates. The Works a member post
		// links resolve on their own gates, at the post's own endpoint.
		const serializedPosts = memberRows.map((m, index) => ({
			id: m.post.id,
			publicId: m.post.publicId,
			slug: m.post.slug,
			title: m.post.title,
			displayTitle: memberPostTitles[index] ?? m.post.title,
			isPublished: m.post.isPublished,
			publishedAt: m.post.publishedAt,
			sortOrder: m.sortOrder,
			creator: embedCreator({
				handle: m.creatorHandle,
				displayName: m.creatorDisplayName,
				avatar: m.creatorAvatar,
			}),
		}));

		// 🚨 The full source is the uncropped upload and never leaves the owner's session: a
		// creator may have framed something out of view, so the public shape carries no
		// `thumbnailSource` key at all rather than an empty one.
		const { thumbnailSource, thumbnailCrop, ...publicProject } = row.project;

		return c.json({
			project: {
				...publicProject,
				...(userId === row.project.creatorId ? { thumbnailSource, thumbnailCrop } : {}),
				thumbnail: thumbnailWork?.thumbnail || row.project.thumbnail,
				/**
				 * The project's public record link, beside the thing it is (the widening task,
				 * 2026-10-10) — same link a Work's and a post's page carry. Null while there is
				 * no record, which is ordinary.
				 */
				recordUrl: recordUrlFor(row.project.atprotoUri),
				creator: embedCreator({
					handle: row.creatorHandle,
					displayName: row.creatorDisplayName,
					avatar: row.creatorAvatar,
				}),
				works: sortProjectItems(
					serializedWorks,
					asProjectSortMode(row.project.worksSortMode),
					asProjectSortDirection(row.project.worksSortDirection),
				),
				posts: sortProjectItems(
					serializedPosts,
					asProjectSortMode(row.project.postsSortMode),
					asProjectSortDirection(row.project.postsSortDirection),
				),
			},
		});
	})

	.patch("/projects/:slug", requireAuth, zValidator("json", updateProjectSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const data = c.req.valid("json");

		const [existing] = await db
			.select({
				id: projects.id,
				creatorId: projects.creatorId,
				isPublished: projects.isPublished,
				thumbnail: projects.thumbnail,
				thumbnailSource: projects.thumbnailSource,
			})
			.from(projects)
			.where(eq(projects.slug, slug))
			.limit(1);
		if (!existing) return c.json({ error: "Project not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		// Checked on a change only, like a Work's file references; see `storage/keys.ts`.
		for (const [sent, stored] of [
			[data.thumbnail, existing.thumbnail],
			[data.thumbnailSource, existing.thumbnailSource],
		] as const) {
			if (
				sent !== undefined &&
				sent !== (stored ?? "") &&
				!(await isOwnStorageRef(sent, user.id))
			) {
				return c.json(FOREIGN_FILE_REFUSAL, 400);
			}
		}

		// A thumbnail chosen from a Work must be this creator's Work **and in this Project's
		// list** — the reference is what the read resolves, so a Work from another Project
		// would dress this one in something it does not hold.
		if (data.thumbnailWorkId != null) {
			const [onProject] = await db
				.select({ id: works.id })
				.from(projectItems)
				.innerJoin(works, eq(projectItems.workId, works.id))
				.where(
					and(
						eq(projectItems.projectId, existing.id),
						eq(works.id, data.thumbnailWorkId),
						eq(works.creatorId, user.id),
					),
				)
				.limit(1);
			if (!onProject) {
				return c.json({ error: "Choose a Work that is in this Project." }, 400);
			}
		}

		// Uploading a new image is the other way to choose a thumbnail, so it retires the Work
		// reference unless the same request names one. Removing the uploaded image leaves a
		// chosen Work alone: the two choices fall back to each other only in one direction.
		const patch: typeof data & { updatedAt: Date } = { ...data, updatedAt: new Date() };
		if (data.thumbnail && data.thumbnailWorkId === undefined) patch.thumbnailWorkId = null;
		// Choosing a Work's image is not the Project's own upload, so the owner's framing of
		// its own image no longer describes what is shown.
		if (data.thumbnailWorkId != null) patch.thumbnailCrop = null;

		// Asked only on the transition into published, because the editor sends `isPublished`
		// with every save and an already-published project must stay editable.
		if (data.isPublished === true && !existing.isPublished) {
			const refusal = await publishRefusal(user, "publish");
			if (refusal) return c.json(refusal.body, refusal.status);
		}

		if (data.slug && data.slug !== slug) {
			const [taken] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, data.slug))
				.limit(1);
			if (taken) return c.json({ error: "Slug already taken" }, 409);
		}

		const [updated] = await db
			.update(projects)
			.set(patch)
			.where(eq(projects.id, existing.id))
			.returning();

		// The record carries the title, the description and the URL, so any of the three moving
		// is a reason to rewrite it — and unpublishing is what takes it down.
		void queueRecordSync("project", updated.id);

		// The answer is the page's row, so its thumbnail is whatever the Project now shows —
		// the Work's own thumbnail when one is chosen and this owner may see it.
		const thumbnails = await resolveProjectThumbnails([updated], {
			userId: user.id,
			seeAll: true,
		});
		return c.json({
			project: { ...updated, thumbnail: thumbnails.get(updated.id) ?? updated.thumbnail },
		});
	})

	.delete("/projects/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		// ⚠️ **Returned rather than looked up first, and it has to carry the URI.** A record whose
		// row is gone can never be found again — see `queueRecordRemoval` — so the address is read
		// out of the delete itself, which is the last moment it exists.
		const deleted = await db
			.delete(projects)
			.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
			.returning({ id: projects.id, atprotoUri: projects.atprotoUri });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);

		if (deleted[0].atprotoUri) {
			await queueRecordRemoval({
				ownerId: user.id,
				collection: PROJECT_COLLECTION,
				uri: deleted[0].atprotoUri,
			});
		}

		return c.body(null, 204);
	})

	// ── Project membership (Works) ────────────────────────────────────────────
	//
	// The half that was always missing. A project could only hold announcements, which
	// meant an album could not hold its tracks — the *Publishing* page's own worked example ("a track in
	// both an album and a best-of") was not expressible in the schema it described.
	.post(
		"/projects/:slug/works",
		requireAuth,
		zValidator("json", addWorkToProjectSchema),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();
			const { workId, sortOrder } = c.req.valid("json");

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
				.limit(1);
			if (!project) return c.json({ error: "Project not found" }, 404);

			const [work] = await db
				.select({ id: works.id })
				.from(works)
				.where(and(eq(works.id, workId), eq(works.creatorId, user.id)))
				.limit(1);
			if (!work) return c.json({ error: "Work not found" }, 404);

			let order = sortOrder;
			if (order === undefined) {
				const [maxRow] = await db
					.select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
					.from(projectItems)
					.where(eq(projectItems.projectId, project.id));
				order = Number(maxRow.max) + 1;
			}

			const [link] = await db
				.insert(projectItems)
				.values({ projectId: project.id, workId: work.id, sortOrder: order })
				.onConflictDoNothing({ target: [projectItems.projectId, projectItems.workId] })
				.returning();

			if (!link) return c.json({ error: "Work is already in this Project" }, 409);
			return c.json({ projectItem: link }, 201);
		},
	)

	.delete("/projects/:slug/works/:workId", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug, workId } = c.req.param();

		const deleted = await db
			.delete(projectItems)
			.where(
				and(
					eq(projectItems.workId, Number(workId)),
					sql`${projectItems.projectId} IN (SELECT id FROM projects WHERE slug = ${slug} AND creator_id = ${user.id})`,
				),
			)
			.returning({ id: projectItems.id });

		// Removing a Work from a Project never touches the Work. It stays in the
		// Catalog, released, with its gates — a Project groups Works, not an owner.
		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);

		// A thumbnail chosen from the Work being taken out of the list returns to the uploaded
		// image, since the Work no longer dresses this Project.
		await db
			.update(projects)
			.set({ thumbnailWorkId: null })
			.where(
				and(
					eq(projects.slug, slug),
					eq(projects.creatorId, user.id),
					eq(projects.thumbnailWorkId, Number(workId)),
				),
			);

		return c.body(null, 204);
	})

	/**
	 * Reorder the Works in a Project.
	 *
	 * The counterpart to `/posts/reorder`, and it had no equivalent until 2026-08-13 —
	 * `POST /works` assigns `max(sortOrder) + 1` and nothing could change it afterwards, so
	 * order was fixed at the moment of adding. For an album that is not a missing
	 * convenience: **track order is the artifact**, and "add them in the right sequence or
	 * start over" is not an authoring model.
	 *
	 * 🚨 **Wrapped in a transaction, unlike the posts version it mirrors.** That one issues N
	 * sequential un-transacted UPDATEs, so a failure partway leaves the list *scrambled* —
	 * some members renumbered, some not — which is worse than the reorder simply failing,
	 * and worse in a way the creator has to repair by hand. Ordering is exactly the state
	 * where a partial write is indefensible. Worth fixing on the posts side too.
	 *
	 * `workIds` is the **complete** desired order. Members omitted from it keep their
	 * existing `sortOrder`, which may then collide with an assigned one — send the whole
	 * list. Ids that aren't members are ignored rather than rejected: the `projectId`
	 * predicate simply matches nothing, so a stale client can't renumber another Project.
	 */
	.post(
		"/projects/:slug/works/reorder",
		requireAuth,
		zValidator("json", z.object({ workIds: z.array(z.number().int()) })),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();
			const { workIds } = c.req.valid("json");

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
				.limit(1);
			if (!project) return c.json({ error: "Project not found" }, 404);

			// A duplicate id would silently give two members the same position, so the order
			// the creator sees would depend on the tiebreak rather than on what they asked
			// for. Cheaper to refuse than to explain.
			if (new Set(workIds).size !== workIds.length) {
				return c.json({ error: "Duplicate Work in the requested order" }, 400);
			}

			await db.transaction(async (tx) => {
				for (let i = 0; i < workIds.length; i++) {
					await tx
						.update(projectItems)
						.set({ sortOrder: i })
						.where(
							and(eq(projectItems.projectId, project.id), eq(projectItems.workId, workIds[i])),
						);
				}
			});

			return c.json({ success: true });
		},
	)

	// ── Project membership (project_posts) ────────────────────────────────────
	.post(
		"/projects/:slug/posts",
		requireAuth,
		zValidator("json", addPostToProjectSchema),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();
			const { postId, sortOrder } = c.req.valid("json");

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
				.limit(1);
			if (!project) return c.json({ error: "Project not found" }, 404);

			const [post] = await db
				.select({ id: posts.id })
				.from(posts)
				.where(and(eq(posts.id, postId), eq(posts.creatorId, user.id)))
				.limit(1);
			if (!post) return c.json({ error: "Post not found" }, 404);

			let order = sortOrder;
			if (order === undefined) {
				const [maxRow] = await db
					.select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
					.from(projectPosts)
					.where(eq(projectPosts.projectId, project.id));
				order = Number(maxRow.max) + 1;
			}

			const [link] = await db
				.insert(projectPosts)
				.values({ projectId: project.id, postId: post.id, sortOrder: order })
				.onConflictDoNothing({ target: [projectPosts.projectId, projectPosts.postId] })
				.returning();

			if (!link) return c.json({ error: "Post is already in this Project" }, 409);
			return c.json({ projectPost: link }, 201);
		},
	)

	.delete("/projects/:slug/posts/:postId", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug, postId } = c.req.param();

		const deleted = await db
			.delete(projectPosts)
			.where(
				and(
					eq(projectPosts.postId, Number(postId)),
					eq(
						projectPosts.projectId,
						sql`(SELECT id FROM projects WHERE slug = ${slug} AND creator_id = ${user.id})`,
					),
				),
			)
			.returning({ id: projectPosts.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	.patch(
		"/projects/:slug/posts/reorder",
		requireAuth,
		zValidator("json", z.object({ postIds: z.array(z.number().int()) })),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();
			const { postIds } = c.req.valid("json");

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
				.limit(1);
			if (!project) return c.json({ error: "Project not found" }, 404);

			for (let i = 0; i < postIds.length; i++) {
				await db
					.update(projectPosts)
					.set({ sortOrder: i })
					.where(and(eq(projectPosts.projectId, project.id), eq(projectPosts.postId, postIds[i])));
			}

			return c.json({ success: true });
		},
	);

export { projectsRoutes };

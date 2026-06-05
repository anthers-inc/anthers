// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content routes — projects, posts, comments, ratings, assets, screenshots,
 * transcoding status, media upload, inline images.
 */

import { db } from "@anthers/db/client";
import {
	assets,
	bookmarks,
	comments,
	inlineImages,
	posts,
	projects,
	ratings,
	screenshots,
	transcodingJobs,
	users,
} from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, asc, avg, count, desc, eq, inArray, like, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { requireAuth } from "../middleware/auth.js";
import { validateSession } from "../services/auth.js";
import { sanitizePostHtml } from "../services/sanitize.js";
import { isLocalStorage, storage } from "../services/storage/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getOptionalUserId(c: any): Promise<number | null> {
	const token = getCookie(c, "session");
	if (!token) return null;
	const result = await validateSession(token);
	return result?.user.id ?? null;
}

function estimateReadMinutes(text: string): number {
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.ceil(wordCount / 200));
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createProjectSchema = z.object({
	title: z.string().min(1).max(255),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens"),
	description: z.string().max(50000).optional().default(""),
	shortDescription: z.string().max(300).optional().default(""),
	mediaType: z.enum(["game", "video", "audio", "text"]).default("game"),
	tags: z.array(z.string()).optional().default([]),
	isPublished: z.boolean().optional().default(false),
	pricingType: z.enum(["free", "pwyw", "paid"]).default("free"),
	price: z.string().optional(),
	minPrice: z.string().optional(),
	suggestedPrice: z.string().optional(),
	coverImage: z.string().max(500).optional().default(""),
	embedUrl: z.string().max(500).optional().default(""),
	websiteUrl: z.string().max(500).optional().default(""),
	sourceUrl: z.string().max(500).optional().default(""),
});

const updateProjectSchema = createProjectSchema.partial();

const createPostSchema = z.object({
	title: z.string().max(255).optional().default(""),
	body: z.string().optional().default(""),
	bodyHtml: z.string().optional().default(""),
	contentType: z.enum(["text", "video", "audio"]).default("text"),
	videoFile: z.string().max(500).optional().default(""),
	audioFile: z.string().max(500).optional().default(""),
	thumbnail: z.string().max(500).optional().default(""),
	durationSeconds: z.number().int().optional(),
	isPremium: z.boolean().optional().default(false),
	visibility: z.enum(["public", "subscribers_only", "gated"]).default("public"),
	isPublished: z.boolean().optional().default(false),
	projectId: z.number().int().optional(),
});

const updatePostSchema = createPostSchema.partial();

const createCommentSchema = z.object({
	body: z.string().min(1).max(10000),
});

const createRatingSchema = z.object({
	score: z.number().int().min(1).max(5),
});

const createAssetSchema = z.object({
	file: z.string().min(1).max(500),
	filename: z.string().min(1).max(255),
	fileSize: z.number().int().optional().default(0),
	mimeType: z.string().max(100).optional().default(""),
	platform: z.string().max(50).optional().default(""),
	version: z.string().max(50).optional().default(""),
	isPrimary: z.boolean().optional().default(false),
});

const createScreenshotSchema = z.object({
	image: z.string().min(1).max(500),
	caption: z.string().max(255).optional().default(""),
	sortOrder: z.number().int().optional().default(0),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

const contentRoutes = new Hono()
	// ══════════════════════════════════════════════════════════════════════════
	// PROJECTS
	// ══════════════════════════════════════════════════════════════════════════

	.get("/projects", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		const mediaType = c.req.query("media_type");
		const tag = c.req.query("tag");
		const search = c.req.query("search");
		const sort = c.req.query("sort") ?? "newest";

		const conditions: any[] = [];

		// "mine" mode: requires auth, includes drafts
		if (mine === "true") {
			const userId = await getOptionalUserId(c);
			if (!userId) return c.json({ projects: [] });
			conditions.push(eq(projects.creatorId, userId));
		} else {
			conditions.push(eq(projects.isPublished, true));
		}

		if (creator) {
			const [user] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.username, creator))
				.limit(1);
			if (!user) return c.json({ projects: [] });
			conditions.push(eq(projects.creatorId, user.id));
		}

		if (mediaType) {
			conditions.push(eq(projects.mediaType, mediaType));
		}

		if (tag) {
			// SQLite JSON: project.tags is stored as a JSON text array; check
			// containment via json_each.
			conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${projects.tags}) WHERE value = ${tag})`);
		}

		if (search) {
			conditions.push(
				or(
					like(projects.title, `%${search}%`),
					like(projects.description, `%${search}%`),
					like(projects.shortDescription, `%${search}%`),
				),
			);
		}

		// Build order
		let orderClause: SQL[];
		switch (sort) {
			case "popular":
				orderClause = [desc(projects.viewCount), desc(projects.createdAt)];
				break;
			case "top_rated":
				orderClause = [
					desc(sql`COALESCE(AVG(${ratings.score}), 0)`),
					desc(sql`COUNT(${ratings.id})`),
					desc(projects.createdAt),
				];
				break;
			case "trending": {
				const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
				orderClause = [
					desc(
						sql`COALESCE((SELECT count(*) FROM attention_events WHERE project_id = ${projects.id} AND created_at >= ${sevenDaysAgoMs}), 0)`,
					),
					desc(projects.viewCount),
					desc(projects.createdAt),
				];
				break;
			}
			case "downloads":
				orderClause = [desc(projects.downloadCount), desc(projects.createdAt)];
				break;
			default: // newest
				orderClause = [desc(projects.createdAt)];
		}

		// For top_rated sort, we need a join and group by
		if (sort === "top_rated") {
			const result = await db
				.select({
					project: projects,
					creatorUsername: users.username,
					creatorDisplayName: users.displayName,
					creatorAvatar: users.avatar,
					ratingAverage: avg(ratings.score).as("rating_average"),
					ratingCount: count(ratings.id).as("rating_count"),
				})
				.from(projects)
				.innerJoin(users, eq(projects.creatorId, users.id))
				.leftJoin(ratings, eq(ratings.projectId, projects.id))
				.where(and(...conditions))
				.groupBy(projects.id, users.id)
				.orderBy(...orderClause)
				.limit(100);

			return c.json({
				projects: result.map((r) => ({
					...r.project,
					creator: {
						username: r.creatorUsername,
						displayName: r.creatorDisplayName,
						avatar: r.creatorAvatar,
					},
					ratingAverage: r.ratingAverage ? Number(r.ratingAverage) : null,
					ratingCount: Number(r.ratingCount),
				})),
			});
		}

		// Standard queries (no join needed for sort)
		const result = await db
			.select({
				project: projects,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(...orderClause)
			.limit(100);

		return c.json({
			projects: result.map((r) => ({
				...r.project,
				creator: {
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
			})),
		});
	})

	.post("/projects", requireAuth, zValidator("json", createProjectSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// Check slug uniqueness
		const [existing] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, data.slug))
			.limit(1);

		if (existing) {
			return c.json({ error: "A project with this slug already exists" }, 409);
		}

		const [project] = await db
			.insert(projects)
			.values({
				creatorId: user.id,
				...data,
			})
			.returning();

		// TODO: ATProto sync

		return c.json({ project }, 201);
	})

	.get("/projects/:slug", async (c) => {
		const { slug } = c.req.param();

		const result = await db
			.select({
				project: projects,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
				ratingAverage: sql<number>`(SELECT AVG(score) FROM ratings WHERE project_id = ${projects.id})`,
				ratingCount: sql<number>`(SELECT COUNT(*) FROM ratings WHERE project_id = ${projects.id})`,
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(eq(projects.slug, slug))
			.limit(1);

		if (result.length === 0) {
			return c.json({ error: "Project not found" }, 404);
		}

		// Increment view count (fire-and-forget)
		db.update(projects)
			.set({ viewCount: sql`${projects.viewCount} + 1` })
			.where(eq(projects.slug, slug))
			.execute();

		const row = result[0];

		// Fetch assets and screenshots
		const [projectAssets, projectScreenshots] = await Promise.all([
			db.select().from(assets).where(eq(assets.projectId, row.project.id)),
			db
				.select()
				.from(screenshots)
				.where(eq(screenshots.projectId, row.project.id))
				.orderBy(asc(screenshots.sortOrder)),
		]);

		return c.json({
			project: {
				...row.project,
				creator: {
					username: row.creatorUsername,
					displayName: row.creatorDisplayName,
					avatar: row.creatorAvatar,
				},
				ratingAverage: row.ratingAverage ? Number(row.ratingAverage) : null,
				ratingCount: Number(row.ratingCount),
				assets: projectAssets,
				screenshots: projectScreenshots,
			},
		});
	})

	.patch("/projects/:slug", requireAuth, zValidator("json", updateProjectSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const data = c.req.valid("json");

		// Ownership check
		const [existing] = await db
			.select({ id: projects.id, creatorId: projects.creatorId })
			.from(projects)
			.where(eq(projects.slug, slug))
			.limit(1);

		if (!existing) return c.json({ error: "Project not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		// If slug is being changed, check uniqueness
		if (data.slug && data.slug !== slug) {
			const [slugTaken] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, data.slug))
				.limit(1);
			if (slugTaken) return c.json({ error: "Slug already taken" }, 409);
		}

		const [updated] = await db
			.update(projects)
			.set({ ...data, updatedAt: new Date() })
			.where(eq(projects.id, existing.id))
			.returning();

		return c.json({ project: updated });
	})

	.delete("/projects/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const deleted = await db
			.delete(projects)
			.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
			.returning({ id: projects.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);

		return c.body(null, 204);
	})

	// ── Project Assets ───────────────────────────────────────────────────────

	.post("/projects/:slug/assets", requireAuth, zValidator("json", createAssetSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [project] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
			.limit(1);

		if (!project) return c.json({ error: "Project not found" }, 404);

		const data = c.req.valid("json");
		const [asset] = await db
			.insert(assets)
			.values({ projectId: project.id, ...data })
			.returning();

		return c.json({ asset }, 201);
	})

	.delete("/projects/:slug/assets/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug, id } = c.req.param();

		const deleted = await db
			.delete(assets)
			.where(
				and(
					eq(assets.id, Number(id)),
					eq(
						assets.projectId,
						sql`(SELECT id FROM projects WHERE slug = ${slug} AND creator_id = ${user.id})`,
					),
				),
			)
			.returning({ id: assets.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	.post("/projects/:slug/assets/:id/download", async (c) => {
		const { slug, id } = c.req.param();

		const [asset] = await db
			.select()
			.from(assets)
			.innerJoin(projects, eq(assets.projectId, projects.id))
			.where(and(eq(assets.id, Number(id)), eq(projects.slug, slug)))
			.limit(1);

		if (!asset) return c.json({ error: "Asset not found" }, 404);

		// Increment download count
		db.update(projects)
			.set({ downloadCount: sql`${projects.downloadCount} + 1` })
			.where(eq(projects.slug, slug))
			.execute();

		return c.json({ url: asset.assets.file });
	})

	// ── Project Screenshots ──────────────────────────────────────────────────

	.post(
		"/projects/:slug/screenshots",
		requireAuth,
		zValidator("json", createScreenshotSchema),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
				.limit(1);

			if (!project) return c.json({ error: "Project not found" }, 404);

			const data = c.req.valid("json");
			const [screenshot] = await db
				.insert(screenshots)
				.values({ projectId: project.id, ...data })
				.returning();

			return c.json({ screenshot }, 201);
		},
	)

	.delete("/projects/:slug/screenshots/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug, id } = c.req.param();

		const deleted = await db
			.delete(screenshots)
			.where(
				and(
					eq(screenshots.id, Number(id)),
					eq(
						screenshots.projectId,
						sql`(SELECT id FROM projects WHERE slug = ${slug} AND creator_id = ${user.id})`,
					),
				),
			)
			.returning({ id: screenshots.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	// ── Project Comments ─────────────────────────────────────────────────────

	.get("/projects/:slug/comments", async (c) => {
		const { slug } = c.req.param();

		const [project] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, slug))
			.limit(1);

		if (!project) return c.json({ error: "Project not found" }, 404);

		const result = await db
			.select({
				comment: comments,
				username: users.username,
				avatar: users.avatar,
			})
			.from(comments)
			.innerJoin(users, eq(comments.userId, users.id))
			.where(eq(comments.projectId, project.id))
			.orderBy(desc(comments.createdAt));

		return c.json({
			comments: result.map((r) => ({
				...r.comment,
				username: r.username,
				avatar: r.avatar,
			})),
		});
	})

	.post(
		"/projects/:slug/comments",
		requireAuth,
		zValidator("json", createCommentSchema),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, slug))
				.limit(1);

			if (!project) return c.json({ error: "Project not found" }, 404);

			const { body } = c.req.valid("json");
			const [comment] = await db
				.insert(comments)
				.values({ userId: user.id, projectId: project.id, body })
				.returning();

			return c.json(
				{
					comment: { ...comment, username: user.username },
				},
				201,
			);
		},
	)

	// ── Project Ratings ──────────────────────────────────────────────────────

	.get("/projects/:slug/ratings", async (c) => {
		const { slug } = c.req.param();

		const [project] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, slug))
			.limit(1);

		if (!project) return c.json({ error: "Project not found" }, 404);

		// Aggregate
		const [agg] = await db
			.select({
				average: avg(ratings.score),
				count: count(ratings.id),
			})
			.from(ratings)
			.where(eq(ratings.projectId, project.id));

		// User's own rating
		let userRating: number | null = null;
		const currentUserId = await getOptionalUserId(c);
		if (currentUserId) {
			const [userRatingRow] = await db
				.select({ score: ratings.score })
				.from(ratings)
				.where(and(eq(ratings.projectId, project.id), eq(ratings.userId, currentUserId)))
				.limit(1);
			userRating = userRatingRow?.score ?? null;
		}

		return c.json({
			average: agg.average ? Number(agg.average) : null,
			count: Number(agg.count),
			userRating,
		});
	})

	.post(
		"/projects/:slug/ratings",
		requireAuth,
		zValidator("json", createRatingSchema),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();

			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, slug))
				.limit(1);

			if (!project) return c.json({ error: "Project not found" }, 404);

			const { score } = c.req.valid("json");

			// Upsert: insert or update on conflict
			const [rating] = await db
				.insert(ratings)
				.values({ userId: user.id, projectId: project.id, score })
				.onConflictDoUpdate({
					target: [ratings.userId, ratings.projectId],
					set: { score },
				})
				.returning();

			// TODO: ATProto sync

			return c.json({ rating }, 201);
		},
	)

	// ══════════════════════════════════════════════════════════════════════════
	// POSTS
	// ══════════════════════════════════════════════════════════════════════════

	.get("/posts", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		const projectSlug = c.req.query("project");
		const contentType = c.req.query("content_type");
		const visibility = c.req.query("visibility");

		const conditions: any[] = [];

		if (mine === "true") {
			const userId = await getOptionalUserId(c);
			if (!userId) return c.json({ posts: [] });
			conditions.push(eq(posts.creatorId, userId));
		} else {
			conditions.push(eq(posts.isPublished, true));
		}

		if (creator) {
			const [user] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.username, creator))
				.limit(1);
			if (!user) return c.json({ posts: [] });
			conditions.push(eq(posts.creatorId, user.id));
		}

		if (projectSlug) {
			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, projectSlug))
				.limit(1);
			if (!project) return c.json({ posts: [] });
			conditions.push(eq(posts.projectId, project.id));
		}

		if (contentType) {
			conditions.push(eq(posts.contentType, contentType));
		}

		if (visibility) {
			conditions.push(eq(posts.visibility, visibility));
		}

		const result = await db
			.select({
				post: posts,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(posts)
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(posts.createdAt))
			.limit(100);

		// Get latest transcoding status for each post
		const postIds = result.map((r) => r.post.id);
		const transcodingMap = new Map<number, { status: string; progress: number }>();
		if (postIds.length > 0) {
			const jobs = await db
				.select({
					postId: transcodingJobs.postId,
					status: transcodingJobs.status,
					progress: transcodingJobs.progress,
				})
				.from(transcodingJobs)
				.where(inArray(transcodingJobs.postId, postIds))
				.orderBy(desc(transcodingJobs.createdAt));

			// Keep only the latest job per post
			for (const job of jobs) {
				if (!transcodingMap.has(job.postId)) {
					transcodingMap.set(job.postId, {
						status: job.status,
						progress: job.progress ?? 0,
					});
				}
			}
		}

		return c.json({
			posts: result.map((r) => ({
				id: r.post.id,
				creatorId: r.post.creatorId,
				projectId: r.post.projectId,
				title: r.post.title,
				contentType: r.post.contentType,
				thumbnail: r.post.thumbnail,
				durationSeconds: r.post.durationSeconds,
				isPremium: r.post.isPremium,
				visibility: r.post.visibility,
				isPublished: r.post.isPublished,
				estimatedReadMinutes: r.post.estimatedReadMinutes,
				createdAt: r.post.createdAt,
				updatedAt: r.post.updatedAt,
				creator: {
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
				latestTranscodingStatus: transcodingMap.get(r.post.id) ?? null,
			})),
		});
	})

	.post("/posts", requireAuth, zValidator("json", createPostSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// Sanitize creator-supplied HTML at the trust boundary — bodyHtml is
		// rendered to other users via dangerouslySetInnerHTML.
		data.bodyHtml = sanitizePostHtml(data.bodyHtml);

		// Calculate read time for text posts
		let estimatedReadMinutes: number | undefined;
		if (data.contentType === "text" && (data.bodyHtml || data.body)) {
			estimatedReadMinutes = estimateReadMinutes(data.bodyHtml || data.body);
		}

		const [post] = await db
			.insert(posts)
			.values({
				creatorId: user.id,
				projectId: data.projectId ?? null,
				title: data.title,
				body: data.body,
				bodyHtml: data.bodyHtml,
				contentType: data.contentType,
				videoFile: data.videoFile,
				audioFile: data.audioFile,
				thumbnail: data.thumbnail,
				durationSeconds: data.durationSeconds ?? null,
				isPremium: data.isPremium,
				visibility: data.visibility,
				isPublished: data.isPublished,
				estimatedReadMinutes: estimatedReadMinutes ?? null,
			})
			.returning();

		// Trigger transcoding for video/audio posts
		if (data.contentType === "video" && data.videoFile) {
			const [job] = await db
				.insert(transcodingJobs)
				.values({
					postId: post.id,
					mediaType: "video",
					status: "pending",
				})
				.returning();
			queue.send(QUEUES.TRANSCODE_VIDEO, { jobId: job.id }, JOB_OPTIONS[QUEUES.TRANSCODE_VIDEO]);
		} else if (data.contentType === "audio" && data.audioFile) {
			const [job] = await db
				.insert(transcodingJobs)
				.values({
					postId: post.id,
					mediaType: "audio",
					status: "pending",
				})
				.returning();
			queue.send(QUEUES.PROCESS_AUDIO, { jobId: job.id }, JOB_OPTIONS[QUEUES.PROCESS_AUDIO]);
		}

		// TODO: ATProto sync

		return c.json({ post }, 201);
	})

	.get("/posts/:id", async (c) => {
		const { id } = c.req.param();

		const result = await db
			.select({
				post: posts,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(posts)
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(eq(posts.id, Number(id)))
			.limit(1);

		if (result.length === 0) return c.json({ error: "Post not found" }, 404);

		const row = result[0];

		// Get transcoding jobs
		const jobs = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.postId, row.post.id))
			.orderBy(desc(transcodingJobs.createdAt));

		// Visibility gating
		let accessGranted = true;
		const postData: any = {
			...row.post,
			creator: {
				username: row.creatorUsername,
				displayName: row.creatorDisplayName,
				avatar: row.creatorAvatar,
			},
			transcodingJobs: jobs,
		};

		if (row.post.visibility !== "public") {
			const currentUserId = await getOptionalUserId(c);

			if (!currentUserId) {
				accessGranted = false;
			} else if (currentUserId === row.post.creatorId) {
				accessGranted = true; // creators always see their own content
			} else {
				// TODO: Check subscription/gate access (Phase 3.7)
				accessGranted = false;
			}

			postData.accessGranted = accessGranted;

			if (!accessGranted) {
				postData.body = "";
				postData.bodyHtml = "";
				postData.videoFile = null;
				postData.audioFile = null;
			}
		}

		return c.json({ post: postData });
	})

	.patch("/posts/:id", requireAuth, zValidator("json", updatePostSchema), async (c) => {
		const user = c.get("user");
		const { id } = c.req.param();
		const data = c.req.valid("json");

		const [existing] = await db
			.select({ id: posts.id, creatorId: posts.creatorId })
			.from(posts)
			.where(eq(posts.id, Number(id)))
			.limit(1);

		if (!existing) return c.json({ error: "Post not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		// Sanitize creator-supplied HTML at the trust boundary — bodyHtml is
		// rendered to other users via dangerouslySetInnerHTML.
		if (data.bodyHtml !== undefined) {
			data.bodyHtml = sanitizePostHtml(data.bodyHtml);
		}

		// Recalculate read time if text content changed
		if (data.contentType === "text" || (!data.contentType && (data.bodyHtml || data.body))) {
			const text = data.bodyHtml || data.body;
			if (text) {
				(data as any).estimatedReadMinutes = estimateReadMinutes(text);
			}
		}

		const [updated] = await db
			.update(posts)
			.set({ ...data, updatedAt: new Date() })
			.where(eq(posts.id, existing.id))
			.returning();

		return c.json({ post: updated });
	})

	.delete("/posts/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { id } = c.req.param();

		const deleted = await db
			.delete(posts)
			.where(and(eq(posts.id, Number(id)), eq(posts.creatorId, user.id)))
			.returning({ id: posts.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	// ── Post Comments ────────────────────────────────────────────────────────

	.get("/posts/:id/comments", async (c) => {
		const { id } = c.req.param();

		const result = await db
			.select({
				comment: comments,
				username: users.username,
				avatar: users.avatar,
			})
			.from(comments)
			.innerJoin(users, eq(comments.userId, users.id))
			.where(eq(comments.postId, Number(id)))
			.orderBy(desc(comments.createdAt));

		return c.json({
			comments: result.map((r) => ({
				...r.comment,
				username: r.username,
				avatar: r.avatar,
			})),
		});
	})

	.post("/posts/:id/comments", requireAuth, zValidator("json", createCommentSchema), async (c) => {
		const user = c.get("user");
		const { id } = c.req.param();

		const [post] = await db
			.select({ id: posts.id })
			.from(posts)
			.where(eq(posts.id, Number(id)))
			.limit(1);

		if (!post) return c.json({ error: "Post not found" }, 404);

		const { body } = c.req.valid("json");
		const [comment] = await db
			.insert(comments)
			.values({ userId: user.id, postId: post.id, body })
			.returning();

		return c.json(
			{
				comment: { ...comment, username: user.username },
			},
			201,
		);
	})

	// ── Transcoding Status ───────────────────────────────────────────────────

	.get("/posts/:id/transcoding", async (c) => {
		const { id } = c.req.param();

		const jobs = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.postId, Number(id)))
			.orderBy(desc(transcodingJobs.createdAt));

		return c.json({ jobs });
	})

	// ── Inline Images ────────────────────────────────────────────────────────

	// ── Media Upload ────────────────────────────────────────────────────────

	/**
	 * Get a presigned upload URL for large media (video, audio, assets).
	 * In S3 mode: returns a presigned PUT URL for direct browser→Spaces upload.
	 * In local mode: returns the direct-upload endpoint URL instead.
	 */
	.post(
		"/media-upload/presign",
		requireAuth,
		zValidator(
			"json",
			z.object({
				filename: z.string().min(1).max(255),
				contentType: z.string().min(1).max(100),
				mediaType: z.enum(["video", "audio", "asset"]),
			}),
		),
		async (c) => {
			const { filename, contentType, mediaType } = c.req.valid("json");

			// Generate a storage key following legacy conventions
			const ext = filename.includes(".") ? filename.split(".").pop() : "";
			const uuid = crypto.randomUUID().replace(/-/g, "");
			const keyMap = {
				video: `videos/originals/${uuid}.${ext}`,
				audio: `audio/originals/${uuid}.${ext}`,
				asset: `assets/${uuid}.${ext}`,
			} as const;
			const key = keyMap[mediaType];

			if (isLocalStorage) {
				// Local mode — return the direct upload endpoint
				return c.json({
					method: "direct" as const,
					uploadUrl: `/api/content/media-upload/direct`,
					key,
				});
			}

			const uploadUrl = await storage.getPresignedUploadUrl(key, contentType, 3600);
			return c.json({ method: "presigned" as const, uploadUrl, key });
		},
	)

	/**
	 * Direct file upload — receives multipart form data.
	 * Used in local dev mode, and for small files (avatars, covers, screenshots) in all modes.
	 */
	.post("/media-upload/direct", requireAuth, async (c) => {
		const user = c.get("user");
		const formData = await c.req.formData();
		const file = formData.get("file");
		const mediaType = formData.get("mediaType") as string | null;
		const entityId = formData.get("entityId") as string | null;

		if (!(file instanceof File)) {
			return c.json({ error: "No file provided" }, 400);
		}

		// Size limit: 500MB for video/audio, 10MB for images
		const isMedia = mediaType === "video" || mediaType === "audio";
		const maxSize = isMedia ? 500 * 1024 * 1024 : 10 * 1024 * 1024;
		if (file.size > maxSize) {
			return c.json(
				{
					error: `File too large (max ${isMedia ? "500MB" : "10MB"})`,
				},
				413,
			);
		}

		// Generate storage key based on media type
		const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
		const uuid = crypto.randomUUID().replace(/-/g, "");
		let key: string;

		switch (mediaType) {
			case "video":
				key = `videos/originals/${uuid}.${ext}`;
				break;
			case "audio":
				key = `audio/originals/${uuid}.${ext}`;
				break;
			case "avatar":
				key = `avatars/${user.id}/${uuid}.${ext}`;
				break;
			case "header":
				key = `headers/${user.id}/${uuid}.${ext}`;
				break;
			case "cover":
				key = `covers/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "screenshot":
				key = `screenshots/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "asset":
				key = `assets/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "inline-image":
				key = `inline-images/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "jam-cover":
				key = `jams/covers/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			default:
				key = `uploads/${user.id}/${uuid}.${ext}`;
		}

		// Determine ACL: private for gated content, public for everything else
		const privateTypes = new Set(["video", "audio", "asset"]);
		const acl = privateTypes.has(mediaType ?? "") ? "private" : "public";

		const buffer = Buffer.from(await file.arrayBuffer());
		await storage.upload(key, buffer, file.type, acl);
		const url = await storage.getUrl(key);

		return c.json({ key, url }, 201);
	})

	// ── Inline Images ────────────────────────────────────────────────────────

	.post("/inline-images", requireAuth, async (c) => {
		const user = c.get("user");

		// For now, accept JSON with image URL (actual file upload handled by media routes)
		const body = await c.req.json();
		const image = body?.image;

		if (!image || typeof image !== "string") {
			return c.json({ error: "Image URL required" }, 400);
		}

		const [inlineImage] = await db
			.insert(inlineImages)
			.values({ creatorId: user.id, image })
			.returning();

		return c.json({ inlineImage }, 201);
	})

	// ── Bookmarks ────────────────────────────────────────────────────────────
	// User-ordered list of bookmarked projects, posts, and creators.
	// Bookmarks serve as a personal list: track an ongoing series, flag
	// something for later, or pin important items. Users control the order
	// by dragging items up/down.

	.get("/bookmarks", requireAuth, async (c) => {
		const user = c.get("user");

		const result = await db
			.select({
				bookmark: bookmarks,
				projectTitle: projects.title,
				projectSlug: projects.slug,
				projectCoverImage: projects.coverImage,
				projectMediaType: projects.mediaType,
				postTitle: posts.title,
				postContentType: posts.contentType,
				postCreatorId: posts.creatorId,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(bookmarks)
			.leftJoin(projects, eq(bookmarks.projectId, projects.id))
			.leftJoin(posts, eq(bookmarks.postId, posts.id))
			.leftJoin(users, eq(bookmarks.creatorId, users.id))
			.where(eq(bookmarks.userId, user.id))
			.orderBy(asc(bookmarks.sortOrder));

		return c.json({
			bookmarks: result.map((r) => ({
				...r.bookmark,
				project: r.bookmark.projectId
					? {
							title: r.projectTitle,
							slug: r.projectSlug,
							coverImage: r.projectCoverImage,
							mediaType: r.projectMediaType,
						}
					: null,
				post: r.bookmark.postId
					? {
							title: r.postTitle,
							contentType: r.postContentType,
						}
					: null,
				creator: r.bookmark.creatorId
					? {
							username: r.creatorUsername,
							displayName: r.creatorDisplayName,
							avatar: r.creatorAvatar,
						}
					: null,
			})),
		});
	})

	.post(
		"/bookmarks",
		requireAuth,
		zValidator(
			"json",
			z
				.object({
					projectId: z.number().int().optional(),
					postId: z.number().int().optional(),
					creatorId: z.number().int().optional(),
				})
				.refine(
					(d) => [d.projectId, d.postId, d.creatorId].filter(Boolean).length === 1,
					"Exactly one of projectId, postId, or creatorId must be provided",
				),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

			// Set sortOrder to end of list
			const [maxSort] = await db
				.select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
				.from(bookmarks)
				.where(eq(bookmarks.userId, user.id));

			const [bookmark] = await db
				.insert(bookmarks)
				.values({
					userId: user.id,
					projectId: data.projectId ?? null,
					postId: data.postId ?? null,
					creatorId: data.creatorId ?? null,
					sortOrder: Number(maxSort.max) + 1,
				})
				.returning();

			return c.json({ bookmark }, 201);
		},
	)

	.patch(
		"/bookmarks/reorder",
		requireAuth,
		zValidator(
			"json",
			z.object({
				/** Ordered array of bookmark IDs, from top to bottom */
				ids: z.array(z.number().int()),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { ids } = c.req.valid("json");

			for (let i = 0; i < ids.length; i++) {
				await db
					.update(bookmarks)
					.set({ sortOrder: i })
					.where(and(eq(bookmarks.id, ids[i]), eq(bookmarks.userId, user.id)));
			}

			return c.json({ success: true });
		},
	)

	.delete("/bookmarks/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { id } = c.req.param();

		const deleted = await db
			.delete(bookmarks)
			.where(and(eq(bookmarks.id, Number(id)), eq(bookmarks.userId, user.id)))
			.returning({ id: bookmarks.id });

		if (deleted.length === 0) return c.json({ error: "Bookmark not found" }, 404);
		return c.body(null, 204);
	});

export { contentRoutes };

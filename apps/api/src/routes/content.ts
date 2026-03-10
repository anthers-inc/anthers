/**
 * Content routes — projects, posts, comments, ratings, assets, screenshots,
 * transcoding status, media upload, inline images.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	eq,
	and,
	or,
	desc,
	asc,
	sql,
	ilike,
	avg,
	count,
	inArray,
} from "drizzle-orm";
import { db } from "@anthers/db/client";
import {
	users,
	projects,
	screenshots,
	assets,
	posts,
	transcodingJobs,
	inlineImages,
	comments,
	ratings,
} from "@anthers/db/schema";
import { requireAuth } from "../middleware/auth.js";
import { requireCreator } from "../middleware/auth.js";
import { validateSession } from "../services/auth.js";
import { getCookie } from "hono/cookie";

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
	slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens"),
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
			conditions.push(sql`${projects.tags} @> ${JSON.stringify([tag])}::jsonb`);
		}

		if (search) {
			conditions.push(
				or(
					ilike(projects.title, `%${search}%`),
					ilike(projects.description, `%${search}%`),
					ilike(projects.shortDescription, `%${search}%`),
				),
			);
		}

		// Build order
		let orderClause;
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
			case "trending":
				orderClause = [
					desc(
						sql`COALESCE((SELECT count(*) FROM attention_events WHERE project_id = ${projects.id} AND created_at >= NOW() - INTERVAL '7 days'), 0)`,
					),
					desc(projects.viewCount),
					desc(projects.createdAt),
				];
				break;
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
			db.select().from(screenshots).where(eq(screenshots.projectId, row.project.id)).orderBy(asc(screenshots.sortOrder)),
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

		const result = await db
			.delete(projects)
			.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)));

		if (result.rowCount === 0) return c.json({ error: "Not found" }, 404);

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

		const result = await db.delete(assets).where(
			and(
				eq(assets.id, Number(id)),
				eq(
					assets.projectId,
					sql`(SELECT id FROM projects WHERE slug = ${slug} AND creator_id = ${user.id})`,
				),
			),
		);

		if (result.rowCount === 0) return c.json({ error: "Not found" }, 404);
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

		const result = await db.delete(screenshots).where(
			and(
				eq(screenshots.id, Number(id)),
				eq(
					screenshots.projectId,
					sql`(SELECT id FROM projects WHERE slug = ${slug} AND creator_id = ${user.id})`,
				),
			),
		);

		if (result.rowCount === 0) return c.json({ error: "Not found" }, 404);
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

			return c.json({
				comment: { ...comment, username: user.username },
			}, 201);
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
		let transcodingMap = new Map<number, { status: string; progress: number }>();
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
			await db.insert(transcodingJobs).values({
				postId: post.id,
				mediaType: "video",
				status: "pending",
			});
			// TODO: Queue BullMQ job for actual transcoding
		} else if (data.contentType === "audio" && data.audioFile) {
			await db.insert(transcodingJobs).values({
				postId: post.id,
				mediaType: "audio",
				status: "pending",
			});
			// TODO: Queue BullMQ job for actual processing
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

		const result = await db
			.delete(posts)
			.where(and(eq(posts.id, Number(id)), eq(posts.creatorId, user.id)));

		if (result.rowCount === 0) return c.json({ error: "Not found" }, 404);
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

	.post(
		"/posts/:id/comments",
		requireAuth,
		zValidator("json", createCommentSchema),
		async (c) => {
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

			return c.json({
				comment: { ...comment, username: user.username },
			}, 201);
		},
	)

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
	});

export { contentRoutes };

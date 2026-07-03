// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content routes — the unified Post model.
 *
 * Everything a creator publishes is a Post. Delivery (stream and/or download)
 * and access (free / paid / subscriber- or boost-gated) are orthogonal per-post
 * switches. Projects are collections (playlist-like wrappers) that group posts
 * via a many-to-many join and hold a custom showcase page — not a content type.
 *
 * See Architecture › "30.1 - Unified Post & Content Model".
 */

import { db } from "@anthers/db/client";
import {
	assets,
	bookmarks,
	comments,
	galleryImages,
	inlineImages,
	posts,
	projectPosts,
	projects,
	ratings,
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
import {
	type AccessiblePost,
	buildAccessContext,
	resolveAccessSync,
} from "../services/access.js";
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

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Derive a slug that's unique per the given existence check, suffixing on collision. */
async function makeUniqueSlug(
	base: string,
	exists: (slug: string) => Promise<boolean>,
): Promise<string> {
	const clean = slugify(base) || "post";
	if (!(await exists(clean))) return clean;
	for (let i = 0; i < 20; i++) {
		const candidate = `${clean}-${crypto.randomUUID().slice(0, 4)}`;
		if (!(await exists(candidate))) return candidate;
	}
	return `${clean}-${crypto.randomUUID().slice(0, 8)}`;
}

async function postSlugExists(slug: string): Promise<boolean> {
	const [row] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug)).limit(1);
	return !!row;
}

/** Strip stream media + body from a post the viewer can't access (metadata stays visible). */
function gateStreamPayload(postData: Record<string, any>): void {
	postData.body = "";
	postData.bodyHtml = "";
	postData.videoFile = "";
	postData.audioFile = "";
	postData.embedUrl = "";
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
	"text",
	"image",
	"audio",
	"video",
	"game",
	"software",
	"physical",
	"service",
] as const;

const MONEY = /^\d+(\.\d{1,2})?$/;

const postBaseSchema = z.object({
	title: z.string().max(255).optional().default(""),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens")
		.optional(),
	body: z.string().optional().default(""),
	bodyHtml: z.string().optional().default(""),
	contentType: z.enum(CONTENT_TYPES).default("text"),

	// Delivery (≥1 enforced by the refine on create)
	streamEnabled: z.boolean().optional().default(true),
	downloadEnabled: z.boolean().optional().default(false),

	// Stream payload / media
	videoFile: z.string().max(500).optional().default(""),
	audioFile: z.string().max(500).optional().default(""),
	coverImage: z.string().max(500).optional().default(""),
	thumbnail: z.string().max(500).optional().default(""),
	embedUrl: z.string().max(500).optional().default(""),
	durationSeconds: z.number().int().optional(),

	// Access & pricing (one entitlement model — see services/access.ts)
	basePrice: z.string().regex(MONEY).nullable().optional(),
	pricingMode: z.enum(["fixed", "pwyw"]).default("fixed"),
	minPrice: z.string().regex(MONEY).nullable().optional(),
	suggestedPrice: z.string().regex(MONEY).nullable().optional(),
	entitlementKind: z.enum(["tier", "boost"]).nullable().optional(),
	entitlementTier: z.enum(["root", "sprout", "petal", "bloom"]).nullable().optional(),
	entitlementBoostThreshold: z.string().regex(MONEY).nullable().optional(),
	entitlementDiscountPct: z.number().int().min(0).max(100).nullable().optional(),
	purchasableWithoutEntitlement: z.boolean().optional().default(true),

	// Presentation
	isPinned: z.boolean().optional().default(false),
	listing: z.enum(["timeline", "unlisted", "shop"]).default("timeline"),

	// Metadata
	tags: z.array(z.string()).optional().default([]),
	websiteUrl: z.string().max(500).optional().default(""),
	sourceUrl: z.string().max(500).optional().default(""),
	isPublished: z.boolean().optional().default(false),
});

const createPostSchema = postBaseSchema.refine((d) => d.streamEnabled || d.downloadEnabled, {
	message: "A post must enable at least one delivery method (stream or download)",
	path: ["streamEnabled"],
});

const updatePostSchema = postBaseSchema.partial();

const createProjectSchema = z.object({
	title: z.string().min(1).max(255),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens"),
	description: z.string().max(50000).optional().default(""),
	shortDescription: z.string().max(300).optional().default(""),
	coverImage: z.string().max(500).optional().default(""),
	pageConfig: z.record(z.unknown()).optional(),
	isPublished: z.boolean().optional().default(false),
});

const updateProjectSchema = createProjectSchema.partial();

const createCommentSchema = z.object({ body: z.string().min(1).max(10000) });
const createRatingSchema = z.object({ score: z.number().int().min(1).max(5) });

const createAssetSchema = z.object({
	file: z.string().min(1).max(500),
	filename: z.string().min(1).max(255),
	fileSize: z.number().int().optional().default(0),
	mimeType: z.string().max(100).optional().default(""),
	platform: z.string().max(50).optional().default(""),
	version: z.string().max(50).optional().default(""),
	isPrimary: z.boolean().optional().default(false),
});

const createGalleryImageSchema = z.object({
	image: z.string().min(1).max(500),
	caption: z.string().max(255).optional().default(""),
	sortOrder: z.number().int().optional().default(0),
});

const addToCollectionSchema = z.object({
	postId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

const contentRoutes = new Hono()
	// ══════════════════════════════════════════════════════════════════════════
	// POSTS — the universal content unit
	// ══════════════════════════════════════════════════════════════════════════

	.get("/posts", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		const collection = c.req.query("collection"); // project (collection) slug
		const contentType = c.req.query("content_type");
		const listing = c.req.query("listing"); // timeline | unlisted | shop
		const delivery = c.req.query("delivery"); // stream | download
		const access = c.req.query("access"); // free | paid | gated
		const tag = c.req.query("tag");
		const search = c.req.query("search");
		const sort = c.req.query("sort") ?? "newest";

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

		if (collection) {
			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, collection))
				.limit(1);
			if (!project) return c.json({ posts: [] });
			conditions.push(
				sql`${posts.id} IN (SELECT post_id FROM project_posts WHERE project_id = ${project.id})`,
			);
		}

		if (contentType) conditions.push(eq(posts.contentType, contentType));

		// Timeline visibility: default the public feed to timeline-listed posts only,
		// so operational shop/unlisted posts don't crowd it. An explicit listing filter
		// or a collection view overrides that default.
		if (listing) {
			conditions.push(eq(posts.listing, listing));
		} else if (mine !== "true" && !collection) {
			conditions.push(eq(posts.listing, "timeline"));
		}

		if (delivery === "stream") conditions.push(eq(posts.streamEnabled, true));
		else if (delivery === "download") conditions.push(eq(posts.downloadEnabled, true));

		if (access === "free") {
			conditions.push(sql`${posts.basePrice} IS NULL AND ${posts.entitlementKind} IS NULL`);
		} else if (access === "paid") {
			conditions.push(sql`${posts.basePrice} IS NOT NULL`);
		} else if (access === "gated") {
			conditions.push(sql`${posts.entitlementKind} IS NOT NULL`);
		}

		if (tag) conditions.push(sql`${posts.tags} @> ${JSON.stringify([tag])}::jsonb`);

		if (search) {
			conditions.push(
				or(like(posts.title, `%${search}%`), like(posts.body, `%${search}%`)),
			);
		}

		let orderClause: SQL[];
		switch (sort) {
			case "popular":
				orderClause = [desc(posts.viewCount), desc(posts.createdAt)];
				break;
			case "downloads":
				orderClause = [desc(posts.downloadCount), desc(posts.createdAt)];
				break;
			default:
				orderClause = [desc(posts.createdAt)];
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
			.orderBy(desc(posts.isPinned), ...orderClause)
			.limit(100);

		const postIds = result.map((r) => r.post.id);

		// Latest transcoding status per post.
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
			for (const job of jobs) {
				if (!transcodingMap.has(job.postId)) {
					transcodingMap.set(job.postId, { status: job.status, progress: job.progress ?? 0 });
				}
			}
		}

		// Access summary for the viewer, resolved from one loaded context.
		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds });

		return c.json({
			posts: result.map((r) => {
				const p = r.post;
				return {
					id: p.id,
					slug: p.slug,
					creatorId: p.creatorId,
					title: p.title,
					contentType: p.contentType,
					streamEnabled: p.streamEnabled,
					downloadEnabled: p.downloadEnabled,
					coverImage: p.coverImage,
					thumbnail: p.thumbnail,
					durationSeconds: p.durationSeconds,
					listing: p.listing,
					isPinned: p.isPinned,
					tags: p.tags,
					isPublished: p.isPublished,
					viewCount: p.viewCount,
					downloadCount: p.downloadCount,
					estimatedReadMinutes: p.estimatedReadMinutes,
					createdAt: p.createdAt,
					updatedAt: p.updatedAt,
					creator: {
						username: r.creatorUsername,
						displayName: r.creatorDisplayName,
						avatar: r.creatorAvatar,
					},
					access: resolveAccessSync(p as AccessiblePost, ctx),
					latestTranscodingStatus: transcodingMap.get(p.id) ?? null,
				};
			}),
		});
	})

	.post("/posts", requireAuth, zValidator("json", createPostSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// Explicit slug must be free; otherwise derive a unique one from the title.
		let slug: string;
		if (data.slug) {
			if (await postSlugExists(data.slug)) {
				return c.json({ error: "A post with this slug already exists" }, 409);
			}
			slug = data.slug;
		} else {
			slug = await makeUniqueSlug(data.title || "post", postSlugExists);
		}

		// Sanitize creator HTML at the trust boundary — bodyHtml renders via dangerouslySetInnerHTML.
		const bodyHtml = sanitizePostHtml(data.bodyHtml);

		let estimatedReadMinutes: number | null = null;
		if (data.contentType === "text" && (bodyHtml || data.body)) {
			estimatedReadMinutes = estimateReadMinutes(data.bodyHtml || data.body);
		}

		const [post] = await db
			.insert(posts)
			.values({
				creatorId: user.id,
				slug,
				title: data.title,
				body: data.body,
				bodyHtml,
				contentType: data.contentType,
				streamEnabled: data.streamEnabled,
				downloadEnabled: data.downloadEnabled,
				videoFile: data.videoFile,
				audioFile: data.audioFile,
				coverImage: data.coverImage,
				thumbnail: data.thumbnail,
				embedUrl: data.embedUrl,
				durationSeconds: data.durationSeconds ?? null,
				basePrice: data.basePrice ?? null,
				pricingMode: data.pricingMode,
				minPrice: data.minPrice ?? null,
				suggestedPrice: data.suggestedPrice ?? null,
				entitlementKind: data.entitlementKind ?? null,
				entitlementTier: data.entitlementTier ?? null,
				entitlementBoostThreshold: data.entitlementBoostThreshold ?? null,
				entitlementDiscountPct: data.entitlementDiscountPct ?? null,
				purchasableWithoutEntitlement: data.purchasableWithoutEntitlement,
				isPinned: data.isPinned,
				listing: data.listing,
				tags: data.tags,
				websiteUrl: data.websiteUrl,
				sourceUrl: data.sourceUrl,
				estimatedReadMinutes,
				isPublished: data.isPublished,
			})
			.returning();

		// Streamed video/audio needs transcoding; download-only media does not.
		if (data.streamEnabled && data.contentType === "video" && data.videoFile) {
			const [job] = await db
				.insert(transcodingJobs)
				.values({ postId: post.id, mediaType: "video", status: "pending" })
				.returning();
			await queue.send(QUEUES.TRANSCODE_VIDEO, { jobId: job.id }, JOB_OPTIONS[QUEUES.TRANSCODE_VIDEO]);
		} else if (data.streamEnabled && data.contentType === "audio" && data.audioFile) {
			const [job] = await db
				.insert(transcodingJobs)
				.values({ postId: post.id, mediaType: "audio", status: "pending" })
				.returning();
			await queue.send(QUEUES.PROCESS_AUDIO, { jobId: job.id }, JOB_OPTIONS[QUEUES.PROCESS_AUDIO]);
		}

		// TODO: ATProto sync

		return c.json({ post }, 201);
	})

	.get("/posts/:slug", async (c) => {
		const { slug } = c.req.param();

		const result = await db
			.select({
				post: posts,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
				ratingAverage: sql<number>`(SELECT AVG(score)::float FROM ratings WHERE post_id = ${posts.id})`,
				ratingCount: sql<number>`(SELECT COUNT(*)::int FROM ratings WHERE post_id = ${posts.id})`,
			})
			.from(posts)
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(eq(posts.slug, slug))
			.limit(1);

		if (result.length === 0) return c.json({ error: "Post not found" }, 404);
		const row = result[0];

		// Fire-and-forget view count.
		db.update(posts)
			.set({ viewCount: sql`${posts.viewCount} + 1` })
			.where(eq(posts.id, row.post.id))
			.execute();

		const [postGallery, postAssets, jobs] = await Promise.all([
			db
				.select()
				.from(galleryImages)
				.where(eq(galleryImages.postId, row.post.id))
				.orderBy(asc(galleryImages.sortOrder)),
			db.select().from(assets).where(eq(assets.postId, row.post.id)),
			db
				.select()
				.from(transcodingJobs)
				.where(eq(transcodingJobs.postId, row.post.id))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [row.post.id] });
		const access = resolveAccessSync(row.post as AccessiblePost, ctx);

		const postData: Record<string, any> = {
			...row.post,
			creator: {
				username: row.creatorUsername,
				displayName: row.creatorDisplayName,
				avatar: row.creatorAvatar,
			},
			ratingAverage: row.ratingAverage ? Number(row.ratingAverage) : null,
			ratingCount: Number(row.ratingCount),
			galleryImages: postGallery,
			// Download keys are only handed out through the access-checked download route.
			assets: postAssets.map((a) => ({ ...a, file: access.canAccess ? a.file : "" })),
			transcodingJobs: jobs,
			access,
		};

		if (!access.canAccess) gateStreamPayload(postData);

		return c.json({ post: postData });
	})

	.patch("/posts/:slug", requireAuth, zValidator("json", updatePostSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const data = c.req.valid("json");

		const [existing] = await db
			.select()
			.from(posts)
			.where(eq(posts.slug, slug))
			.limit(1);

		if (!existing) return c.json({ error: "Post not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		// Slug change must stay unique.
		if (data.slug && data.slug !== slug) {
			if (await postSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		const updates: Record<string, any> = { ...data, updatedAt: new Date() };

		if (data.bodyHtml !== undefined) updates.bodyHtml = sanitizePostHtml(data.bodyHtml);

		const nextContentType = data.contentType ?? existing.contentType;
		if (nextContentType === "text") {
			const text = updates.bodyHtml ?? data.body ?? existing.bodyHtml ?? existing.body ?? "";
			if (text) updates.estimatedReadMinutes = estimateReadMinutes(text);
		}

		const [updated] = await db
			.update(posts)
			.set(updates)
			.where(eq(posts.id, existing.id))
			.returning();

		// Re-trigger transcoding when a streamed media file was (re)set.
		const streamOn = updated.streamEnabled;
		if (streamOn && data.videoFile && data.videoFile !== existing.videoFile) {
			const [job] = await db
				.insert(transcodingJobs)
				.values({ postId: updated.id, mediaType: "video", status: "pending" })
				.returning();
			await queue.send(QUEUES.TRANSCODE_VIDEO, { jobId: job.id }, JOB_OPTIONS[QUEUES.TRANSCODE_VIDEO]);
		} else if (streamOn && data.audioFile && data.audioFile !== existing.audioFile) {
			const [job] = await db
				.insert(transcodingJobs)
				.values({ postId: updated.id, mediaType: "audio", status: "pending" })
				.returning();
			await queue.send(QUEUES.PROCESS_AUDIO, { jobId: job.id }, JOB_OPTIONS[QUEUES.PROCESS_AUDIO]);
		}

		return c.json({ post: updated });
	})

	.delete("/posts/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const deleted = await db
			.delete(posts)
			.where(and(eq(posts.slug, slug), eq(posts.creatorId, user.id)))
			.returning({ id: posts.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	// ── Post Comments ──────────────────────────────────────────────────────────
	.get("/posts/:slug/comments", async (c) => {
		const { slug } = c.req.param();
		const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const result = await db
			.select({ comment: comments, username: users.username, avatar: users.avatar })
			.from(comments)
			.innerJoin(users, eq(comments.userId, users.id))
			.where(eq(comments.postId, post.id))
			.orderBy(desc(comments.createdAt));

		return c.json({
			comments: result.map((r) => ({ ...r.comment, username: r.username, avatar: r.avatar })),
		});
	})

	.post("/posts/:slug/comments", requireAuth, zValidator("json", createCommentSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const { body } = c.req.valid("json");
		const [comment] = await db
			.insert(comments)
			.values({ userId: user.id, postId: post.id, body })
			.returning();

		return c.json({ comment: { ...comment, username: user.username } }, 201);
	})

	// ── Post Ratings ───────────────────────────────────────────────────────────
	.get("/posts/:slug/ratings", async (c) => {
		const { slug } = c.req.param();
		const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const [agg] = await db
			.select({ average: avg(ratings.score), count: count(ratings.id) })
			.from(ratings)
			.where(eq(ratings.postId, post.id));

		let userRating: number | null = null;
		const currentUserId = await getOptionalUserId(c);
		if (currentUserId) {
			const [row] = await db
				.select({ score: ratings.score })
				.from(ratings)
				.where(and(eq(ratings.postId, post.id), eq(ratings.userId, currentUserId)))
				.limit(1);
			userRating = row?.score ?? null;
		}

		return c.json({
			average: agg.average ? Number(agg.average) : null,
			count: Number(agg.count),
			userRating,
		});
	})

	.post("/posts/:slug/ratings", requireAuth, zValidator("json", createRatingSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const { score } = c.req.valid("json");
		const [rating] = await db
			.insert(ratings)
			.values({ userId: user.id, postId: post.id, score })
			.onConflictDoUpdate({ target: [ratings.userId, ratings.postId], set: { score } })
			.returning();

		return c.json({ rating }, 201);
	})

	// ── Post Assets (downloadable files) ─────────────────────────────────────────
	.post("/posts/:slug/assets", requireAuth, zValidator("json", createAssetSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const [post] = await db
			.select({ id: posts.id })
			.from(posts)
			.where(and(eq(posts.slug, slug), eq(posts.creatorId, user.id)))
			.limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const data = c.req.valid("json");
		const [asset] = await db.insert(assets).values({ postId: post.id, ...data }).returning();
		return c.json({ asset }, 201);
	})

	.delete("/posts/:slug/assets/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug, id } = c.req.param();

		const deleted = await db
			.delete(assets)
			.where(
				and(
					eq(assets.id, Number(id)),
					eq(
						assets.postId,
						sql`(SELECT id FROM posts WHERE slug = ${slug} AND creator_id = ${user.id})`,
					),
				),
			)
			.returning({ id: assets.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	.post("/posts/:slug/assets/:id/download", async (c) => {
		const { slug, id } = c.req.param();

		const [row] = await db
			.select({ asset: assets, post: posts })
			.from(assets)
			.innerJoin(posts, eq(assets.postId, posts.id))
			.where(and(eq(assets.id, Number(id)), eq(posts.slug, slug)))
			.limit(1);

		if (!row) return c.json({ error: "Asset not found" }, 404);

		// Enforce access server-side — the UI gate is not the source of truth.
		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [row.post.id] });
		const access = resolveAccessSync(row.post as AccessiblePost, ctx);
		if (!access.canAccess) {
			return c.json({ error: "Purchase or subscription required", access }, 403);
		}

		db.update(posts)
			.set({ downloadCount: sql`${posts.downloadCount} + 1` })
			.where(eq(posts.id, row.post.id))
			.execute();

		// Assets are stored private; hand back a short-lived signed URL (local mode
		// ignores signing and serves via /content).
		const url = await storage.getUrl(row.asset.file, { signed: true, expiresIn: 300 });
		return c.json({ url });
	})

	// ── Post Gallery Images ──────────────────────────────────────────────────────
	.post(
		"/posts/:slug/gallery",
		requireAuth,
		zValidator("json", createGalleryImageSchema),
		async (c) => {
			const user = c.get("user");
			const { slug } = c.req.param();
			const [post] = await db
				.select({ id: posts.id })
				.from(posts)
				.where(and(eq(posts.slug, slug), eq(posts.creatorId, user.id)))
				.limit(1);
			if (!post) return c.json({ error: "Post not found" }, 404);

			const data = c.req.valid("json");
			const [image] = await db
				.insert(galleryImages)
				.values({ postId: post.id, ...data })
				.returning();
			return c.json({ galleryImage: image }, 201);
		},
	)

	.delete("/posts/:slug/gallery/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug, id } = c.req.param();

		const deleted = await db
			.delete(galleryImages)
			.where(
				and(
					eq(galleryImages.id, Number(id)),
					eq(
						galleryImages.postId,
						sql`(SELECT id FROM posts WHERE slug = ${slug} AND creator_id = ${user.id})`,
					),
				),
			)
			.returning({ id: galleryImages.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	// ── Transcoding Status ───────────────────────────────────────────────────────
	.get("/posts/:slug/transcoding", async (c) => {
		const { slug } = c.req.param();
		const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const jobs = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.postId, post.id))
			.orderBy(desc(transcodingJobs.createdAt));

		return c.json({ jobs });
	})

	// ══════════════════════════════════════════════════════════════════════════
	// PROJECTS — collections that group posts
	// ══════════════════════════════════════════════════════════════════════════

	.get("/projects", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		const search = c.req.query("search");

		const conditions: any[] = [];
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

		if (search) {
			conditions.push(
				or(like(projects.title, `%${search}%`), like(projects.description, `%${search}%`)),
			);
		}

		const result = await db
			.select({
				project: projects,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
				postCount: sql<number>`(SELECT COUNT(*)::int FROM project_posts WHERE project_id = ${projects.id})`,
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(projects.createdAt))
			.limit(100);

		return c.json({
			projects: result.map((r) => ({
				...r.project,
				postCount: Number(r.postCount),
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
				shortDescription: data.shortDescription,
				coverImage: data.coverImage,
				pageConfig: data.pageConfig ?? {},
				isPublished: data.isPublished,
			})
			.returning();

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
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(eq(projects.slug, slug))
			.limit(1);

		if (result.length === 0) return c.json({ error: "Project not found" }, 404);
		const row = result[0];

		// Ordered member posts.
		const memberRows = await db
			.select({
				post: posts,
				sortOrder: projectPosts.sortOrder,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(projectPosts)
			.innerJoin(posts, eq(projectPosts.postId, posts.id))
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(eq(projectPosts.projectId, row.project.id))
			.orderBy(asc(projectPosts.sortOrder), asc(posts.createdAt));

		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(
			viewerId,
			{ postIds: memberRows.map((m) => m.post.id) },
		);

		return c.json({
			project: {
				...row.project,
				creator: {
					username: row.creatorUsername,
					displayName: row.creatorDisplayName,
					avatar: row.creatorAvatar,
				},
				posts: memberRows.map((m) => ({
					id: m.post.id,
					slug: m.post.slug,
					title: m.post.title,
					contentType: m.post.contentType,
					coverImage: m.post.coverImage,
					thumbnail: m.post.thumbnail,
					streamEnabled: m.post.streamEnabled,
					downloadEnabled: m.post.downloadEnabled,
					sortOrder: m.sortOrder,
					creator: {
						username: m.creatorUsername,
						displayName: m.creatorDisplayName,
						avatar: m.creatorAvatar,
					},
					access: resolveAccessSync(m.post as AccessiblePost, ctx),
				})),
			},
		});
	})

	.patch("/projects/:slug", requireAuth, zValidator("json", updateProjectSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const data = c.req.valid("json");

		const [existing] = await db
			.select({ id: projects.id, creatorId: projects.creatorId })
			.from(projects)
			.where(eq(projects.slug, slug))
			.limit(1);
		if (!existing) return c.json({ error: "Project not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

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

	// ── Collection membership (project_posts) ────────────────────────────────────
	.post("/projects/:slug/posts", requireAuth, zValidator("json", addToCollectionSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const { postId, sortOrder } = c.req.valid("json");

		const [project] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.slug, slug), eq(projects.creatorId, user.id)))
			.limit(1);
		if (!project) return c.json({ error: "Project not found" }, 404);

		// Only the creator's own posts can be collected.
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

		if (!link) return c.json({ error: "Post is already in this collection" }, 409);
		return c.json({ projectPost: link }, 201);
	})

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
					.where(
						and(eq(projectPosts.projectId, project.id), eq(projectPosts.postId, postIds[i])),
					);
			}

			return c.json({ success: true });
		},
	)

	// ══════════════════════════════════════════════════════════════════════════
	// MEDIA UPLOAD
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * Presigned upload URL for large media (video, audio, download assets).
	 * S3 mode: a presigned PUT for direct browser→Spaces upload. Local mode: the
	 * direct-upload endpoint URL instead.
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
			const user = c.get("user");

			// Creator-first key layout: every object lives under creators/<creatorId>/…
			const ext = filename.includes(".") ? filename.split(".").pop() : "";
			const uuid = crypto.randomUUID().replace(/-/g, "");
			const prefix = `creators/${user.id}`;
			const keyMap = {
				video: `${prefix}/videos/originals/${uuid}.${ext}`,
				audio: `${prefix}/audio/originals/${uuid}.${ext}`,
				asset: `${prefix}/assets/${uuid}.${ext}`,
			} as const;
			const key = keyMap[mediaType];

			if (isLocalStorage) {
				return c.json({ method: "direct" as const, uploadUrl: `/api/content/media-upload/direct`, key });
			}

			const uploadUrl = await storage.getPresignedUploadUrl(key, contentType, 3600);
			return c.json({ method: "presigned" as const, uploadUrl, key });
		},
	)

	/**
	 * Direct multipart upload — local dev, and small files (avatars, covers, gallery)
	 * in all modes.
	 */
	.post("/media-upload/direct", requireAuth, async (c) => {
		const user = c.get("user");
		const formData = await c.req.formData();
		const file = formData.get("file");
		const mediaType = formData.get("mediaType") as string | null;
		const entityId = formData.get("entityId") as string | null;

		if (!(file instanceof File)) return c.json({ error: "No file provided" }, 400);

		// 500MB for video/audio/assets, 10MB for images.
		const isMedia = mediaType === "video" || mediaType === "audio" || mediaType === "asset";
		const maxSize = isMedia ? 500 * 1024 * 1024 : 10 * 1024 * 1024;
		if (file.size > maxSize) {
			return c.json({ error: `File too large (max ${isMedia ? "500MB" : "10MB"})` }, 413);
		}

		const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
		const uuid = crypto.randomUUID().replace(/-/g, "");
		const prefix = `creators/${user.id}`;
		let key: string;

		switch (mediaType) {
			case "video":
				key = `${prefix}/videos/originals/${uuid}.${ext}`;
				break;
			case "audio":
				key = `${prefix}/audio/originals/${uuid}.${ext}`;
				break;
			case "avatar":
				key = `${prefix}/avatars/${uuid}.${ext}`;
				break;
			case "header":
				key = `${prefix}/headers/${uuid}.${ext}`;
				break;
			case "cover":
				key = `${prefix}/covers/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "gallery":
			case "screenshot":
				key = `${prefix}/gallery/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "asset":
				key = `${prefix}/assets/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "inline-image":
				key = `${prefix}/inline-images/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "jam-cover":
				key = `${prefix}/jams/covers/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			default:
				key = `${prefix}/uploads/${uuid}.${ext}`;
		}

		// Private for downloadable/originals; public for display images.
		const privateTypes = new Set(["video", "audio", "asset"]);
		const acl = privateTypes.has(mediaType ?? "") ? "private" : "public";

		const buffer = Buffer.from(await file.arrayBuffer());
		await storage.upload(key, buffer, file.type, acl);
		const url = await storage.getUrl(key);

		return c.json({ key, url }, 201);
	})

	// ── Inline Images ────────────────────────────────────────────────────────────
	.post("/inline-images", requireAuth, async (c) => {
		const user = c.get("user");
		const body = await c.req.json();
		const image = body?.image;
		if (!image || typeof image !== "string") return c.json({ error: "Image URL required" }, 400);

		const [inlineImage] = await db
			.insert(inlineImages)
			.values({ creatorId: user.id, image })
			.returning();
		return c.json({ inlineImage }, 201);
	})

	// ══════════════════════════════════════════════════════════════════════════
	// BOOKMARKS — a user-ordered list of posts, collections, and creators
	// ══════════════════════════════════════════════════════════════════════════

	.get("/bookmarks", requireAuth, async (c) => {
		const user = c.get("user");

		const result = await db
			.select({
				bookmark: bookmarks,
				projectTitle: projects.title,
				projectSlug: projects.slug,
				projectCoverImage: projects.coverImage,
				postTitle: posts.title,
				postSlug: posts.slug,
				postContentType: posts.contentType,
				postCoverImage: posts.coverImage,
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
					? { title: r.projectTitle, slug: r.projectSlug, coverImage: r.projectCoverImage }
					: null,
				post: r.bookmark.postId
					? {
							title: r.postTitle,
							slug: r.postSlug,
							contentType: r.postContentType,
							coverImage: r.postCoverImage,
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
					(d) => [d.projectId, d.postId, d.creatorId].filter((v) => v !== undefined).length === 1,
					"Exactly one of projectId, postId, or creatorId must be provided",
				),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

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
		zValidator("json", z.object({ ids: z.array(z.number().int()) })),
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

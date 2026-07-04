// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content routes — the unified Post model.
 *
 * Everything a creator publishes is a Post. A post BODY (rich text) is shown to
 * anyone with visibility; the deliverable is an ordered array of typed **content
 * elements** (`post_contents`), each carrying its own media + optional downloadable
 * assets. Delivery (stream and/or download) and access (the two OR-gated access
 * tables) are orthogonal per-post switches. Projects are collections that group
 * posts via a many-to-many join — not a content type.
 *
 * Posts are addressed by a durable numeric `publicId`; the canonical URL is
 * `/posts/{slug}-{publicId}` and a route param of either the bare publicId or the
 * slug-publicId form resolves to the same post (slug alone still works too).
 *
 * See Architecture › "30.1 - Unified Post & Content Model".
 */

import { db } from "@anthers/db/client";
import {
	type AnthersAccessRow,
	assets,
	type BoostAccessRow,
	bookmarks,
	comments,
	inlineImages,
	postContents,
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
	defaultAnthersAccess,
	defaultBoostAccess,
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

/** Allocate an unused 9-digit public id (Patreon-style durable key). */
async function makeUniquePublicId(): Promise<number> {
	for (let i = 0; i < 12; i++) {
		const id = 100_000_000 + Math.floor(Math.random() * 900_000_000);
		const [row] = await db
			.select({ id: posts.id })
			.from(posts)
			.where(eq(posts.publicId, id))
			.limit(1);
		if (!row) return id;
	}
	throw new Error("Could not allocate a unique public id");
}

/**
 * Parse a post route param that may be a bare publicId, a `slug-publicId`, or a
 * plain slug. publicIds are ≥6 digits, so a slug's trailing number rarely misfires
 * (and a miss just falls back to the slug lookup).
 */
function parsePostParam(param: string): { publicId: number | null; slug: string } {
	if (/^\d+$/.test(param)) return { publicId: Number(param), slug: param };
	const m = param.match(/-(\d{6,})$/);
	if (m) return { publicId: Number(m[1]), slug: param };
	return { publicId: null, slug: param };
}

/** Resolve the full post row from a route param (publicId preferred, slug fallback). */
async function findPostRow(param: string): Promise<typeof posts.$inferSelect | null> {
	const { publicId, slug } = parsePostParam(param);
	if (publicId != null) {
		const [byId] = await db.select().from(posts).where(eq(posts.publicId, publicId)).limit(1);
		if (byId) return byId;
	}
	const [bySlug] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
	return bySlug ?? null;
}

/** Post primary type for cards/badges/filter — the single element type, or "mixed". */
function deriveContentType(elements: { contentType: string }[]): string {
	if (elements.length === 0) return "text";
	const types = new Set(elements.map((e) => e.contentType));
	return types.size === 1 ? [...types][0] : "mixed";
}

/** Denormalized card image: first element's thumbnail, else its first image. */
function deriveThumbnail(
	elements: { thumbnail?: string | null; images?: string[] | null }[],
): string {
	for (const e of elements) {
		if (e.thumbnail) return e.thumbnail;
		if (e.images && e.images.length > 0) return e.images[0];
	}
	return "";
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

const anthersAccessRowSchema = z.object({
	tier: z.enum(["free", "root", "sprout", "petal", "bloom"]),
	allow: z.boolean(),
	price: z.string().regex(MONEY),
});

const boostAccessRowSchema = z.object({
	threshold: z.number().nonnegative(),
	allow: z.boolean(),
	price: z.string().regex(MONEY),
});

const contentElementSchema = z.object({
	id: z.number().int().optional(), // present = an existing element to keep/update
	contentType: z.enum(CONTENT_TYPES),
	title: z.string().max(255).optional().default(""),
	thumbnail: z.string().max(500).optional().default(""),
	bodyHtml: z.string().optional().default(""),
	images: z.array(z.string().max(500)).optional().default([]),
	videoFile: z.string().max(500).optional().default(""),
	audioFile: z.string().max(500).optional().default(""),
	embedUrl: z.string().max(500).optional().default(""),
	durationSeconds: z.number().int().optional(),
	metadata: z.record(z.unknown()).optional().default({}),
});

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

	// Delivery / access type (≥1 enforced by the refine on create)
	streamEnabled: z.boolean().optional().default(true),
	downloadEnabled: z.boolean().optional().default(false),

	// Access tables (default "free but fully locked" applied server-side when omitted)
	anthersAccess: z.array(anthersAccessRowSchema).optional(),
	boostAccess: z.array(boostAccessRowSchema).optional(),

	// The deliverable: an ordered array of typed content elements.
	contents: z.array(contentElementSchema).optional().default([]),

	// Presentation
	showOnTimeline: z.boolean().optional().default(true),
	isPinned: z.boolean().optional().default(false),

	// Metadata
	tags: z.array(z.string()).optional().default([]),
	websiteUrl: z.string().max(500).optional().default(""),
	sourceUrl: z.string().max(500).optional().default(""),
	isPublished: z.boolean().optional().default(false),

	// Optionally attach to a project (collection) on create.
	projectId: z.number().int().optional(),
});

const createPostSchema = postBaseSchema.refine((d) => d.streamEnabled || d.downloadEnabled, {
	message: "A post must enable at least one access type (stream or download)",
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

const addToCollectionSchema = z.object({
	postId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

// ─── Content-element persistence ──────────────────────────────────────────────

/** Map a validated element to its post_contents column values. */
function elementValues(el: z.infer<typeof contentElementSchema>, postId: number, position: number) {
	return {
		postId,
		position,
		contentType: el.contentType,
		title: el.title ?? "",
		thumbnail: el.thumbnail ?? "",
		bodyHtml: el.bodyHtml ? sanitizePostHtml(el.bodyHtml) : "",
		images: el.images ?? [],
		videoFile: el.videoFile ?? "",
		audioFile: el.audioFile ?? "",
		embedUrl: el.embedUrl ?? "",
		durationSeconds: el.durationSeconds ?? null,
		metadata: el.metadata ?? {},
	};
}

/**
 * Client-transcode transport: a browser upload may hand us a pre-encoded MP4 variant
 * ladder in the element's metadata (see apps/web/src/lib/transcode.ts). When present,
 * the server only remuxes to HLS (`package-video`) instead of re-encoding.
 */
interface ClientVariant {
	name: string;
	height: number;
	width: number;
	bitrate: string;
	bandwidth: number;
	key: string;
}

function readClientVariants(metadata: unknown): ClientVariant[] {
	const raw = (metadata as Record<string, unknown> | null)?.clientVariants;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(v): v is ClientVariant =>
			!!v &&
			typeof (v as ClientVariant).key === "string" &&
			typeof (v as ClientVariant).name === "string" &&
			typeof (v as ClientVariant).bandwidth === "number",
	);
}

/** Queue a transcode/normalize job for a video or audio element that has a source file. */
async function queueTranscodeFor(content: typeof postContents.$inferSelect): Promise<void> {
	if (content.contentType === "video" && content.videoFile) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ contentId: content.id, mediaType: "video", status: "pending" })
			.returning();
		// Browser-encoded ladder → cheap remux; otherwise the server encodes from source.
		const variants = readClientVariants(content.metadata);
		if (variants.length > 0) {
			await queue.send(
				QUEUES.PACKAGE_VIDEO,
				{ jobId: job.id, variants, duration: content.durationSeconds ?? undefined },
				JOB_OPTIONS[QUEUES.PACKAGE_VIDEO],
			);
		} else {
			await queue.send(
				QUEUES.TRANSCODE_VIDEO,
				{ jobId: job.id },
				JOB_OPTIONS[QUEUES.TRANSCODE_VIDEO],
			);
		}
	} else if (content.contentType === "audio" && content.audioFile) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ contentId: content.id, mediaType: "audio", status: "pending" })
			.returning();
		await queue.send(QUEUES.PROCESS_AUDIO, { jobId: job.id }, JOB_OPTIONS[QUEUES.PROCESS_AUDIO]);
	}
}

/** Insert a fresh set of content elements for a post (create path). */
async function insertContents(
	postId: number,
	elements: z.infer<typeof contentElementSchema>[],
): Promise<void> {
	for (let i = 0; i < elements.length; i++) {
		const [inserted] = await db
			.insert(postContents)
			.values(elementValues(elements[i], postId, i))
			.returning();
		await queueTranscodeFor(inserted);
	}
}

/**
 * Reconcile a post's content elements against a submitted array (update path):
 * keep+update elements referenced by id (preserving their assets/transcodes),
 * insert new ones, and delete those dropped from the array.
 */
async function reconcileContents(
	postId: number,
	elements: z.infer<typeof contentElementSchema>[],
): Promise<void> {
	const existing = await db.select().from(postContents).where(eq(postContents.postId, postId));
	const existingById = new Map(existing.map((e) => [e.id, e]));
	const keep = new Set<number>();

	for (let i = 0; i < elements.length; i++) {
		const el = elements[i];
		const prev = el.id != null ? existingById.get(el.id) : undefined;
		if (prev) {
			keep.add(prev.id);
			await db
				.update(postContents)
				.set({ ...elementValues(el, postId, i), updatedAt: new Date() })
				.where(eq(postContents.id, prev.id));
			// Re-queue when a streamed media source changed.
			if (el.contentType === "video" && el.videoFile && el.videoFile !== prev.videoFile) {
				await queueTranscodeFor({ ...prev, ...elementValues(el, postId, i) });
			} else if (el.contentType === "audio" && el.audioFile && el.audioFile !== prev.audioFile) {
				await queueTranscodeFor({ ...prev, ...elementValues(el, postId, i) });
			}
		} else {
			const [inserted] = await db
				.insert(postContents)
				.values(elementValues(el, postId, i))
				.returning();
			await queueTranscodeFor(inserted);
		}
	}

	const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
	if (toDelete.length > 0) {
		await db.delete(postContents).where(inArray(postContents.id, toDelete));
	}
}

/** Drop internal-only keys (e.g. client-transcode variant storage keys) from metadata. */
function stripInternalMetadata(metadata: unknown): Record<string, unknown> {
	if (!metadata || typeof metadata !== "object") return {};
	const { clientVariants, ...rest } = metadata as Record<string, unknown>;
	void clientVariants;
	return rest;
}

/**
 * Where a gated post's HLS should be streamed from. When set, a completed video
 * transcode's manifest URL is rewritten to the access-checked, signed-segment
 * endpoint (`buildHlsManifestUrl`) instead of the raw public CDN URL — so entitled
 * viewers of a gated post can actually play it (the CDN 403s private segments).
 */
interface HlsStreamCtx {
	slug: string;
	origin: string;
}

/** URL of the access-checked HLS master for a gated video element. */
function buildHlsManifestUrl(ctx: HlsStreamCtx, contentId: number, file = "master.m3u8"): string {
	return `${ctx.origin}/api/content/posts/${encodeURIComponent(ctx.slug)}/hls/${contentId}/${file}`;
}

/** Serialize one content element for a response, stripping the payload when gated. */
function serializeContent(
	el: typeof postContents.$inferSelect,
	elAssets: (typeof assets.$inferSelect)[],
	job: typeof transcodingJobs.$inferSelect | null,
	canAccess: boolean,
	hls: HlsStreamCtx | null,
) {
	// Gated video: hand the player our signed-segment manifest endpoint, not the raw
	// CDN URL (whose .ts segments are private → 403). Free/public posts keep the
	// direct public manifest (CDN-served, no per-request signing).
	let transcoding = job;
	if (
		hls &&
		canAccess &&
		job &&
		el.contentType === "video" &&
		job.status === "completed" &&
		job.hlsManifestUrl
	) {
		transcoding = { ...job, hlsManifestUrl: buildHlsManifestUrl(hls, el.id) };
	}

	return {
		id: el.id,
		postId: el.postId,
		position: el.position,
		contentType: el.contentType,
		title: el.title,
		thumbnail: el.thumbnail,
		durationSeconds: el.durationSeconds,
		// `clientVariants` are an internal packaging detail (storage keys) — never expose.
		metadata: stripInternalMetadata(el.metadata),
		// Payload is the deliverable — only handed out when the viewer has access.
		bodyHtml: canAccess ? el.bodyHtml : "",
		images: canAccess ? el.images : [],
		videoFile: canAccess ? el.videoFile : "",
		audioFile: canAccess ? el.audioFile : "",
		embedUrl: canAccess ? el.embedUrl : "",
		// Download keys are only handed out through the access-checked download route.
		assets: elAssets.map((a) => ({ ...a, file: canAccess ? a.file : "" })),
		transcoding,
	};
}

/** Load a post's content elements with their assets + latest transcode job, gating as needed. */
async function loadPostContents(
	postId: number,
	canAccess: boolean,
	hls: HlsStreamCtx | null = null,
) {
	const contents = await db
		.select()
		.from(postContents)
		.where(eq(postContents.postId, postId))
		.orderBy(asc(postContents.position));
	if (contents.length === 0) return [];

	const contentIds = contents.map((c) => c.id);
	const [assetRows, jobRows] = await Promise.all([
		db.select().from(assets).where(inArray(assets.contentId, contentIds)),
		db
			.select()
			.from(transcodingJobs)
			.where(inArray(transcodingJobs.contentId, contentIds))
			.orderBy(desc(transcodingJobs.createdAt)),
	]);

	const assetsByContent = new Map<number, (typeof assets.$inferSelect)[]>();
	for (const a of assetRows) {
		const list = assetsByContent.get(a.contentId) ?? [];
		list.push(a);
		assetsByContent.set(a.contentId, list);
	}
	const jobByContent = new Map<number, typeof transcodingJobs.$inferSelect>();
	for (const j of jobRows) {
		if (!jobByContent.has(j.contentId)) jobByContent.set(j.contentId, j);
	}

	// Thumbnails render directly as <img src>; older rows stored a bare storage key
	// instead of a URL — resolve those to public URLs (new uploads already store URLs).
	await Promise.all(
		contents.map(async (el) => {
			if (el.thumbnail && !/^(https?:)?\/\//.test(el.thumbnail) && !el.thumbnail.startsWith("/")) {
				el.thumbnail = await storage.getUrl(el.thumbnail);
			}
		}),
	);

	return contents.map((el) =>
		serializeContent(
			el,
			assetsByContent.get(el.id) ?? [],
			jobByContent.get(el.id) ?? null,
			canAccess,
			hls,
		),
	);
}

/**
 * Public origin the browser uses to reach us (same host serves the SPA + /api in
 * prod). Behind DO's ingress `c.req.url` carries an internal host, so absolute URLs
 * handed to the client must be built from FRONTEND_URL, not the request URL.
 */
function publicOrigin(): string {
	return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Decide where a post's HLS should stream from. In S3 mode ALL video streams through
 * the access-checked signed-segment endpoint — access is enforced live at request
 * time, so it doesn't matter whether a segment's stored ACL is public or private (and
 * a post's access can change after transcode without leaving playback broken). Local
 * dev serves segments directly (the /content route serves everything).
 */
function hlsStreamCtxFor(post: typeof posts.$inferSelect): HlsStreamCtx | null {
	if (isLocalStorage) return null;
	return { slug: post.slug, origin: publicOrigin() };
}

/** Short-lived signed-segment lifetime — must exceed a viewer's watch time (VOD). */
const HLS_SEGMENT_TTL_SECONDS = 6 * 60 * 60;

/**
 * Rewrite an HLS playlist for signed delivery. In the master, child variant playlists
 * are pointed back through this access-checked endpoint; in a variant playlist, each
 * segment (.ts) becomes a short-lived signed CDN URL. Comment/tag lines pass through.
 */
async function rewriteHlsPlaylist(
	text: string,
	opts: { isMaster: boolean; prefixKey: string; ctx: HlsStreamCtx; contentId: number },
): Promise<string> {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) {
			out.push(raw.trimEnd());
			continue;
		}
		if (opts.isMaster) {
			// A variant playlist (e.g. "720p.m3u8") → back through this endpoint.
			out.push(buildHlsManifestUrl(opts.ctx, opts.contentId, encodeURIComponent(line)));
		} else {
			// A segment (e.g. "720p_000.ts") → a short-lived signed CDN URL.
			out.push(
				await storage.getUrl(`${opts.prefixKey}/${line}`, {
					signed: true,
					expiresIn: HLS_SEGMENT_TTL_SECONDS,
				}),
			);
		}
	}
	return out.join("\n");
}

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
		const delivery = c.req.query("delivery"); // stream | download
		const tag = c.req.query("tag");
		const search = c.req.query("search");
		const sort = c.req.query("sort") ?? "newest";

		const conditions: SQL[] = [];

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

		// The public feed shows timeline posts only; a creator's own view or a
		// collection view shows everything (including off-timeline posts).
		if (mine !== "true" && !collection) {
			conditions.push(eq(posts.showOnTimeline, true));
		}

		if (delivery === "stream") conditions.push(eq(posts.streamEnabled, true));
		else if (delivery === "download") conditions.push(eq(posts.downloadEnabled, true));

		if (tag) conditions.push(sql`${posts.tags} @> ${JSON.stringify([tag])}::jsonb`);

		if (search) {
			conditions.push(or(like(posts.title, `%${search}%`), like(posts.body, `%${search}%`)) as SQL);
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

		// Latest transcoding status per post (across its content elements).
		const transcodingMap = new Map<number, { status: string; progress: number }>();
		if (postIds.length > 0) {
			const jobs = await db
				.select({
					postId: postContents.postId,
					status: transcodingJobs.status,
					progress: transcodingJobs.progress,
				})
				.from(transcodingJobs)
				.innerJoin(postContents, eq(transcodingJobs.contentId, postContents.id))
				.where(inArray(postContents.postId, postIds))
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
					publicId: p.publicId,
					slug: p.slug,
					creatorId: p.creatorId,
					title: p.title,
					contentType: p.contentType,
					streamEnabled: p.streamEnabled,
					downloadEnabled: p.downloadEnabled,
					thumbnail: p.thumbnail,
					showOnTimeline: p.showOnTimeline,
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

		const bodyHtml = sanitizePostHtml(data.bodyHtml);
		const contentType = deriveContentType(data.contents);
		const thumbnail = deriveThumbnail(data.contents);

		// Read time comes from the post body (the always-visible rich text).
		const readText = bodyHtml || data.body;
		const estimatedReadMinutes = readText ? estimateReadMinutes(readText) : null;

		const publicId = await makeUniquePublicId();

		const [post] = await db
			.insert(posts)
			.values({
				creatorId: user.id,
				publicId,
				slug,
				title: data.title,
				body: data.body,
				bodyHtml,
				contentType,
				thumbnail,
				streamEnabled: data.streamEnabled,
				downloadEnabled: data.downloadEnabled,
				anthersAccess: data.anthersAccess ?? defaultAnthersAccess(),
				boostAccess: data.boostAccess ?? defaultBoostAccess(),
				showOnTimeline: data.showOnTimeline,
				isPinned: data.isPinned,
				tags: data.tags,
				websiteUrl: data.websiteUrl,
				sourceUrl: data.sourceUrl,
				estimatedReadMinutes,
				isPublished: data.isPublished,
			})
			.returning();

		await insertContents(post.id, data.contents);

		// Optionally attach to a project (collection) the creator owns.
		if (data.projectId != null) {
			const [project] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.id, data.projectId), eq(projects.creatorId, user.id)))
				.limit(1);
			if (project) {
				const [maxRow] = await db
					.select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
					.from(projectPosts)
					.where(eq(projectPosts.projectId, project.id));
				await db
					.insert(projectPosts)
					.values({ projectId: project.id, postId: post.id, sortOrder: Number(maxRow.max) + 1 })
					.onConflictDoNothing({ target: [projectPosts.projectId, projectPosts.postId] });
			}
		}

		const contents = await loadPostContents(post.id, true, hlsStreamCtxFor(post));
		return c.json({ post: { ...post, contents } }, 201);
	})

	.get("/posts/:slug", async (c) => {
		const { slug } = c.req.param();
		const post = await findPostRow(slug);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const [creator] = await db
			.select({ username: users.username, displayName: users.displayName, avatar: users.avatar })
			.from(users)
			.where(eq(users.id, post.creatorId))
			.limit(1);

		const [agg] = await db
			.select({ average: avg(ratings.score), count: count(ratings.id) })
			.from(ratings)
			.where(eq(ratings.postId, post.id));

		// Fire-and-forget view count.
		db.update(posts)
			.set({ viewCount: sql`${posts.viewCount} + 1` })
			.where(eq(posts.id, post.id))
			.execute();

		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [post.id] });
		const access = resolveAccessSync(post as AccessiblePost, ctx);

		const contents = await loadPostContents(post.id, access.canAccess, hlsStreamCtxFor(post));

		return c.json({
			post: {
				...post,
				creator,
				ratingAverage: agg.average ? Number(agg.average) : null,
				ratingCount: Number(agg.count),
				contents,
				access,
			},
		});
	})

	.patch("/posts/:slug", requireAuth, zValidator("json", updatePostSchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const data = c.req.valid("json");

		const existing = await findPostRow(slug);
		if (!existing) return c.json({ error: "Post not found" }, 404);
		if (existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		if (data.slug && data.slug !== existing.slug) {
			if (await postSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		// Reconcile content elements first (if provided), then derive post-level fields.
		if (data.contents !== undefined) {
			await reconcileContents(existing.id, data.contents);
		}
		const currentContents = await db
			.select({
				contentType: postContents.contentType,
				thumbnail: postContents.thumbnail,
				images: postContents.images,
			})
			.from(postContents)
			.where(eq(postContents.postId, existing.id))
			.orderBy(asc(postContents.position));

		const updates: Record<string, unknown> = { updatedAt: new Date() };
		if (data.slug !== undefined) updates.slug = data.slug;
		if (data.title !== undefined) updates.title = data.title;
		if (data.body !== undefined) updates.body = data.body;
		if (data.bodyHtml !== undefined) updates.bodyHtml = sanitizePostHtml(data.bodyHtml);
		if (data.streamEnabled !== undefined) updates.streamEnabled = data.streamEnabled;
		if (data.downloadEnabled !== undefined) updates.downloadEnabled = data.downloadEnabled;
		if (data.anthersAccess !== undefined) updates.anthersAccess = data.anthersAccess;
		if (data.boostAccess !== undefined) updates.boostAccess = data.boostAccess;
		if (data.showOnTimeline !== undefined) updates.showOnTimeline = data.showOnTimeline;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.tags !== undefined) updates.tags = data.tags;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.sourceUrl !== undefined) updates.sourceUrl = data.sourceUrl;
		if (data.isPublished !== undefined) updates.isPublished = data.isPublished;

		// Keep the denormalized type/thumbnail + read time in sync.
		updates.contentType = deriveContentType(currentContents);
		updates.thumbnail = deriveThumbnail(currentContents);
		const readText =
			(data.bodyHtml !== undefined ? updates.bodyHtml : existing.bodyHtml) ||
			(data.body !== undefined ? data.body : existing.body) ||
			"";
		updates.estimatedReadMinutes = readText ? estimateReadMinutes(readText as string) : null;

		const [updated] = await db
			.update(posts)
			.set(updates)
			.where(eq(posts.id, existing.id))
			.returning();

		const contents = await loadPostContents(updated.id, true, hlsStreamCtxFor(updated));
		return c.json({ post: { ...updated, contents } });
	})

	.delete("/posts/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const existing = await findPostRow(slug);
		if (!existing || existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		await db.delete(posts).where(eq(posts.id, existing.id));
		return c.body(null, 204);
	})

	// ── Post Comments ──────────────────────────────────────────────────────────
	.get("/posts/:slug/comments", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
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

	.post(
		"/posts/:slug/comments",
		requireAuth,
		zValidator("json", createCommentSchema),
		async (c) => {
			const user = c.get("user");
			const post = await findPostRow(c.req.param("slug"));
			if (!post) return c.json({ error: "Post not found" }, 404);

			const { body } = c.req.valid("json");
			const [comment] = await db
				.insert(comments)
				.values({ userId: user.id, postId: post.id, body })
				.returning();

			return c.json({ comment: { ...comment, username: user.username } }, 201);
		},
	)

	// ── Post Ratings ───────────────────────────────────────────────────────────
	.get("/posts/:slug/ratings", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
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
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		const { score } = c.req.valid("json");
		const [rating] = await db
			.insert(ratings)
			.values({ userId: user.id, postId: post.id, score })
			.onConflictDoUpdate({ target: [ratings.userId, ratings.postId], set: { score } })
			.returning();

		return c.json({ rating }, 201);
	})

	// ── Content-element downloadable assets ──────────────────────────────────────
	.post(
		"/posts/:slug/contents/:contentId/assets",
		requireAuth,
		zValidator("json", createAssetSchema),
		async (c) => {
			const user = c.get("user");
			const post = await findPostRow(c.req.param("slug"));
			if (!post || post.creatorId !== user.id) return c.json({ error: "Post not found" }, 404);

			const contentId = Number(c.req.param("contentId"));
			const [element] = await db
				.select({ id: postContents.id })
				.from(postContents)
				.where(and(eq(postContents.id, contentId), eq(postContents.postId, post.id)))
				.limit(1);
			if (!element) return c.json({ error: "Content element not found" }, 404);

			const data = c.req.valid("json");
			const [asset] = await db
				.insert(assets)
				.values({ contentId, ...data })
				.returning();
			return c.json({ asset }, 201);
		},
	)

	.delete("/posts/:slug/contents/:contentId/assets/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const post = await findPostRow(c.req.param("slug"));
		if (!post || post.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		const contentId = Number(c.req.param("contentId"));
		const deleted = await db
			.delete(assets)
			.where(
				and(
					eq(assets.id, Number(c.req.param("id"))),
					eq(assets.contentId, contentId),
					sql`${contentId} IN (SELECT id FROM post_contents WHERE post_id = ${post.id})`,
				),
			)
			.returning({ id: assets.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	.post("/posts/:slug/assets/:id/download", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		// Resolve the asset via its content element, scoped to this post.
		const [row] = await db
			.select({ asset: assets })
			.from(assets)
			.innerJoin(postContents, eq(assets.contentId, postContents.id))
			.where(and(eq(assets.id, Number(c.req.param("id"))), eq(postContents.postId, post.id)))
			.limit(1);
		if (!row) return c.json({ error: "Asset not found" }, 404);

		// Enforce access server-side — the UI gate is not the source of truth.
		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [post.id] });
		const access = resolveAccessSync(post as AccessiblePost, ctx);
		if (!access.canAccess) {
			return c.json({ error: "Purchase or subscription required", access }, 403);
		}

		db.update(posts)
			.set({ downloadCount: sql`${posts.downloadCount} + 1` })
			.where(eq(posts.id, post.id))
			.execute();

		// Assets are stored private; hand back a short-lived signed URL (local mode
		// ignores signing and serves via /content).
		const url = await storage.getUrl(row.asset.file, { signed: true, expiresIn: 300 });
		return c.json({ url });
	})

	// ── Transcoding status (across the post's content elements) ──────────────────
	.get("/posts/:slug/transcoding", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		const jobs = await db
			.select({ job: transcodingJobs, contentId: postContents.id })
			.from(transcodingJobs)
			.innerJoin(postContents, eq(transcodingJobs.contentId, postContents.id))
			.where(eq(postContents.postId, post.id))
			.orderBy(desc(transcodingJobs.createdAt));

		return c.json({ jobs: jobs.map((j) => j.job) });
	})

	// ── Gated HLS delivery (access-checked, signed segments) ─────────────────────
	// Serves the master + variant playlists for a gated video, rewriting segment refs
	// to short-lived signed CDN URLs. Only reached for gated posts (free posts stream
	// the public CDN manifest directly); the player is pointed here by serializeContent.
	.get("/posts/:slug/hls/:contentId/:file", async (c) => {
		const file = c.req.param("file");
		// Playlists only — segments are fetched straight from the CDN via signed URLs.
		if (!/^[A-Za-z0-9_.-]+\.m3u8$/.test(file)) return c.json({ error: "Not found" }, 404);

		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		// Enforce access server-side — this is the gate for private segments.
		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [post.id] });
		const access = resolveAccessSync(post as AccessiblePost, ctx);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const contentId = Number(c.req.param("contentId"));
		const [row] = await db
			.select({ job: transcodingJobs })
			.from(transcodingJobs)
			.innerJoin(postContents, eq(transcodingJobs.contentId, postContents.id))
			.where(and(eq(transcodingJobs.contentId, contentId), eq(postContents.postId, post.id)))
			.orderBy(desc(transcodingJobs.createdAt))
			.limit(1);
		const manifestUrl = row?.job.hlsManifestUrl;
		if (!manifestUrl) return c.json({ error: "Not found" }, 404);

		// Storage key prefix = the directory of the master.m3u8 key (playlists are public,
		// so we fetch the requested one directly and rewrite it).
		const masterKey = decodeURIComponent(new URL(manifestUrl).pathname.replace(/^\/+/, ""));
		const prefixKey = masterKey.replace(/\/[^/]+$/, "");

		const res = await fetch(await storage.getUrl(`${prefixKey}/${file}`));
		if (!res.ok) return c.json({ error: "Not found" }, 404);

		const rewritten = await rewriteHlsPlaylist(await res.text(), {
			isMaster: file === "master.m3u8",
			prefixKey,
			ctx: { slug: post.slug, origin: publicOrigin() },
			contentId,
		});
		return c.body(rewritten, 200, {
			"Content-Type": "application/vnd.apple.mpegurl",
			"Cache-Control": "no-store",
		});
	})

	// ══════════════════════════════════════════════════════════════════════════
	// PROJECTS — collections that group posts
	// ══════════════════════════════════════════════════════════════════════════

	.get("/projects", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		const search = c.req.query("search");

		const conditions: SQL[] = [];
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
				or(like(projects.title, `%${search}%`), like(projects.description, `%${search}%`)) as SQL,
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
		const ctx = await buildAccessContext(viewerId, { postIds: memberRows.map((m) => m.post.id) });

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
					publicId: m.post.publicId,
					slug: m.post.slug,
					title: m.post.title,
					contentType: m.post.contentType,
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
	.post(
		"/projects/:slug/posts",
		requireAuth,
		zValidator("json", addToCollectionSchema),
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

			if (!link) return c.json({ error: "Post is already in this collection" }, 409);
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
	 * Direct multipart upload — local dev, and small files (avatars, covers, images)
	 * in all modes.
	 */
	.post("/media-upload/direct", requireAuth, async (c) => {
		const user = c.get("user");
		const formData = await c.req.formData();
		const file = formData.get("file");
		const mediaType = formData.get("mediaType") as string | null;
		const entityId = formData.get("entityId") as string | null;

		if (!(file instanceof File)) return c.json({ error: "No file provided" }, 400);

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
			case "thumbnail":
				key = `${prefix}/thumbnails/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "gallery":
			case "image":
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
				postPublicId: posts.publicId,
				postContentType: posts.contentType,
				postThumbnail: posts.thumbnail,
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
							publicId: r.postPublicId,
							contentType: r.postContentType,
							thumbnail: r.postThumbnail,
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

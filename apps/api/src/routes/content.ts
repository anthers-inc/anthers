// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content routes — the creator's **Catalog** of Works, and their feed of **Posts**.
 *
 * A **Work** (`works`) is the unit of published creative work: a game, a video, a track,
 * an image, an essay, software, a physical good, a service. It OWNS its source media,
 * downloadable variants (`assets`) and transcodes (`transcoding_jobs`), and it carries its
 * own visibility, dates, delivery switches and access gates. Processing runs once on
 * upload to the Catalog, before the Work is released or referenced anywhere. A Work can be
 * released, gated, purchased and consumed with **no Post ever existing**.
 *
 * A **Post** is an announcement — rich text, links and body-embedded images, and nothing
 * else. It may *reference* Works (`post_work_refs`), which renders as a card and gives the
 * Work its posting history in return, but **that reference is inert: it confers no access
 * whatsoever.** A Post may freely link a Work its reader cannot open. Projects are
 * collections that group posts (and, from stage 4, Works) via many-to-many joins.
 *
 * Both are addressed by a durable numeric `publicId`; the canonical URLs are
 * `/posts/{slug}-{publicId}` and `/works/{slug}-{publicId}`, and a route param of either
 * the bare publicId or the slug-publicId form resolves the same row (slug alone works too).
 *
 * See Architecture › "40.08 Catalog and Posts".
 */

import { db } from "@anthers/db/client";
import {
	assets,
	bookmarks,
	comments,
	inlineImages,
	postEdits,
	postWorkRefs,
	posts,
	projectPosts,
	projects,
	ratings,
	stripeAccounts,
	transcodingJobs,
	users,
	works,
} from "@anthers/db/schema";
import { COMMENT_MAX, REVIEW_MAX, REVIEW_MIN } from "@anthers/shared/content";
import { zValidator } from "@hono/zod-validator";
import { and, asc, avg, count, desc, eq, inArray, like, ne, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { requireAuth } from "../middleware/auth.js";
import {
	type AccessibleWork,
	buildAccessContext,
	defaultAnthersAccess,
	defaultSeedAccess,
	resolveAccessSync,
} from "../services/access.js";
import { validateSession } from "../services/auth.js";
import { sanitizePostHtml } from "../services/sanitize.js";
import { aclForMediaType } from "../services/storage/acl.js";
import { isLocalStorage, storage } from "../services/storage/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Moderation filters for public reads of user-generated rows.
 *
 * Hiding a comment or rating is a state transition (`moderation_status`), never a
 * delete — see `services/moderation.ts` — which means the row is still sitting in
 * the table and every read has to exclude it deliberately. These two predicates
 * are named so that stays one obvious thing to add rather than a literal string
 * copied into each new query; a read site that forgets one is a moderation leak,
 * not a cosmetic bug.
 *
 * Applied to: the comment list, the rating aggregate on the ratings endpoint, and
 * the rating aggregate embedded in post detail. Every public count of either is
 * derived from those. Deliberately NOT applied to a viewer's own `userRating` —
 * the star they see should be the star they actually submitted, and re-rating
 * only overwrites the score, so a hidden rating stays hidden.
 */
const visibleComment = eq(comments.moderationStatus, "visible");
const visibleRating = eq(ratings.moderationStatus, "visible");

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

async function workSlugExists(slug: string): Promise<boolean> {
	const [row] = await db.select({ id: works.id }).from(works).where(eq(works.slug, slug)).limit(1);
	return !!row;
}

/**
 * Allocate an unused 9-digit public id (Patreon-style durable key).
 *
 * Posts and Works keep separate id spaces — they are different things at different URLs,
 * and forcing one shared space would only add contention.
 */
async function makeUniquePublicId(table: typeof posts | typeof works): Promise<number> {
	for (let i = 0; i < 12; i++) {
		const id = 100_000_000 + Math.floor(Math.random() * 900_000_000);
		const [row] = await db
			.select({ id: table.id })
			.from(table)
			.where(eq(table.publicId, id))
			.limit(1);
		if (!row) return id;
	}
	throw new Error("Could not allocate a unique public id");
}

/**
 * Parse a route param that may be a bare publicId, a `slug-publicId`, or a
 * plain slug. publicIds are ≥6 digits, so a slug's trailing number rarely misfires
 * (and a miss just falls back to the slug lookup).
 */
function parsePublicParam(param: string): { publicId: number | null; slug: string } {
	if (/^\d+$/.test(param)) return { publicId: Number(param), slug: param };
	const m = param.match(/-(\d{6,})$/);
	if (m) return { publicId: Number(m[1]), slug: param };
	return { publicId: null, slug: param };
}

/** Resolve the full post row from a route param (publicId preferred, slug fallback). */
async function findPostRow(param: string): Promise<typeof posts.$inferSelect | null> {
	const { publicId, slug } = parsePublicParam(param);
	if (publicId != null) {
		const [byId] = await db.select().from(posts).where(eq(posts.publicId, publicId)).limit(1);
		if (byId) return byId;
	}
	const [bySlug] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
	return bySlug ?? null;
}

/**
 * Resolve a Work from a route param, which may be a numeric row id, a publicId, or a
 * slug/`slug-publicId`. The bare-number case checks the row id first because internal
 * callers (delivery URLs, pickers) address Works by id, while public URLs carry the
 * slug-publicId form.
 */
async function findWorkRow(param: string): Promise<typeof works.$inferSelect | null> {
	if (/^\d+$/.test(param)) {
		const n = Number(param);
		const [byId] = await db.select().from(works).where(eq(works.id, n)).limit(1);
		if (byId) return byId;
		const [byPublic] = await db.select().from(works).where(eq(works.publicId, n)).limit(1);
		return byPublic ?? null;
	}
	const { publicId, slug } = parsePublicParam(param);
	if (publicId != null) {
		const [byPublic] = await db.select().from(works).where(eq(works.publicId, publicId)).limit(1);
		if (byPublic) return byPublic;
	}
	const [bySlug] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
	return bySlug ?? null;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Work types. `text` is here now: prose is a Work, not post-native content. Under the old
 * model rich text was deliberately excluded from the library, which produced the strangest
 * rule in the system — prose in a post body earned nothing while the same prose as a
 * content element earned. The rule was right; the earning form just had no home.
 */
const WORK_TYPES = [
	"text",
	"video",
	"audio",
	"image",
	"game",
	"software",
	"physical",
	"service",
] as const;

/** Work types whose media is processed asynchronously before the Work can be released. */
const PROCESSED_WORK_TYPES = new Set(["video", "audio"]);

const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * Both access tables are the same row: a whole-Seed threshold, an allow flag, a price.
 * The Anthers table's threshold counts Anthers-Seeds held; the Seed table's counts Seeds
 * given to this creator. Integer-only — a gate sits at a whole Seed or nowhere, and
 * accepting 2.5 would let a row be written that no viewer can ever exactly meet.
 */
const accessRowSchema = z.object({
	threshold: z.number().int().nonnegative(),
	allow: z.boolean(),
	price: z.string().regex(MONEY),
});

const anthersAccessRowSchema = accessRowSchema;
const seedAccessRowSchema = accessRowSchema;

/**
 * The Works a post points at. A bare id list — there is nothing to configure, because
 * the reference carries no access, no caption-as-content and no ordering semantics beyond
 * display order. Anything richer would be the post owning the Work again.
 */
const postWorkRefsSchema = z.array(z.number().int()).max(50);

// ── Works (the Catalog) ──

/** A creator-asserted Created date: when the work was MADE, with the precision they claim. */
const authoredSchema = z.object({
	authoredAt: z.string().datetime().nullable().optional(),
	authoredPrecision: z.enum(["year", "month", "day"]).nullable().optional(),
});

const workBaseSchema = z
	.object({
		title: z.string().max(255).optional().default(""),
		slug: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens")
			.optional(),
		description: z.string().max(50000).optional().default(""),
		thumbnail: z.string().max(500).optional().default(""),
		sourceKey: z.string().max(500).optional().default(""),
		embedUrl: z.string().max(500).optional().default(""),
		durationSeconds: z.number().int().optional(),
		// type = "text": the prose itself.
		body: z.string().optional().default(""),
		bodyHtml: z.string().optional().default(""),
		metadata: z.record(z.unknown()).optional().default({}),

		// Visibility. `released` is public listing, NOT public access — the gates decide that.
		visibility: z.enum(["private", "released"]).optional(),

		// Delivery (≥1 enforced on release)
		streamEnabled: z.boolean().optional(),
		downloadEnabled: z.boolean().optional(),

		// Access tables (default "free but fully locked" applied server-side when omitted)
		anthersAccess: z.array(anthersAccessRowSchema).optional(),
		seedAccess: z.array(seedAccessRowSchema).optional(),

		// Presentation & metadata
		isPinned: z.boolean().optional(),
		tags: z.array(z.string()).optional(),
		websiteUrl: z.string().max(500).optional(),
		sourceUrl: z.string().max(500).optional(),
	})
	.merge(authoredSchema);

const createWorkSchema = workBaseSchema
	.extend({ type: z.enum(WORK_TYPES) })
	.refine((d) => d.authoredAt == null || d.authoredPrecision != null, {
		message: "A Created date needs its precision (year, month or day)",
		path: ["authoredPrecision"],
	});

const updateWorkSchema = workBaseSchema.partial();

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

	// Works this post points at. Inert references — they confer no access.
	workIds: postWorkRefsSchema.optional().default([]),

	// Presentation
	showOnTimeline: z.boolean().optional().default(true),
	isPinned: z.boolean().optional().default(false),

	// Metadata
	tags: z.array(z.string()).optional().default([]),
	isPublished: z.boolean().optional().default(false),
	// ISO datetime at which a still-unpublished draft should auto-publish; null clears the
	// schedule. Publishing now (isPublished=true) supersedes and clears any schedule.
	scheduledFor: z.string().datetime().nullable().optional(),

	// Optionally attach to a project (collection) on create.
	projectId: z.number().int().optional(),
});

const createPostSchema = postBaseSchema;

const updatePostSchema = postBaseSchema.partial();

/** Query flags for DELETE /posts/:slug — kept for API compatibility; a post owns no media now. */
const deletePostQuerySchema = z.object({ purgeMedia: z.enum(["true", "1"]).optional() });

/** Query flags for DELETE /works/:id — force opts into deleting a Work a post still references. */
const deleteWorkQuerySchema = z.object({ force: z.enum(["true", "1"]).optional() });

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

const createCommentSchema = z.object({ body: z.string().min(1).max(COMMENT_MAX) });
/**
 * A review: a score AND written text. The minimum is deliberately low — it's a
 * blunt instrument and "lol" clears it either way. The point of requiring text
 * isn't to filter by length, it's that a written verdict gives a reader something
 * to weigh and a moderator something to act on, where a bare score is
 * unmoderatable by construction. Plain text, no markup, so no sanitizer.
 */
const createRatingSchema = z.object({
	score: z.number().int().min(1).max(5),
	body: z.string().trim().min(REVIEW_MIN, "Please say a little about why").max(REVIEW_MAX),
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

const addToCollectionSchema = z.object({
	postId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

// ─── Content library items ────────────────────────────────────────────────────

type WorkRow = typeof works.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type TranscodingJobRow = typeof transcodingJobs.$inferSelect;

/**
 * Client-transcode transport: a browser upload may hand us a pre-encoded MP4 variant
 * ladder in the item's metadata (see apps/web/src/lib/transcode.ts). When present, the
 * server only remuxes to HLS (`package-video`) instead of re-encoding from source.
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

/** Drop internal-only keys (e.g. client-transcode variant storage keys) from metadata. */
function stripInternalMetadata(metadata: unknown): Record<string, unknown> {
	if (!metadata || typeof metadata !== "object") return {};
	const { clientVariants, ...rest } = metadata as Record<string, unknown>;
	void clientVariants;
	return rest;
}

/**
 * Queue processing for a library content item that has a source needing it. Video →
 * HLS transcode (or a cheap remux when the browser pre-encoded a variant ladder); audio
 * → normalize. Fired on library upload (POST /works) and when the source changes
 * (PATCH), NEVER on post save — processing is a library concern, not a post concern.
 *
 * Returns the queued job (null when the item needs no processing) so the caller can
 * serialize it into the response. The create response previously reported
 * `transcoding: null` for an item whose job had just been queued — which read as "no
 * processing" to the client, hiding the status badge AND leaving the library's
 * poll-while-processing loop switched off, so a freshly uploaded item sat unlabelled
 * until a manual refresh.
 */
async function queueTranscodeForWork(item: WorkRow): Promise<TranscodingJobRow | null> {
	if (item.type === "video" && item.sourceKey) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId: item.id, mediaType: "video", status: "pending" })
			.returning();
		// Browser-encoded ladder → cheap remux; otherwise the server encodes from source.
		const variants = readClientVariants(item.metadata);
		if (variants.length > 0) {
			await queue.send(
				QUEUES.PACKAGE_VIDEO,
				{ jobId: job.id, variants, duration: item.durationSeconds ?? undefined },
				JOB_OPTIONS[QUEUES.PACKAGE_VIDEO],
			);
		} else {
			await queue.send(
				QUEUES.TRANSCODE_VIDEO,
				{ jobId: job.id },
				JOB_OPTIONS[QUEUES.TRANSCODE_VIDEO],
			);
		}
		return job;
	}
	if (item.type === "audio" && item.sourceKey) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId: item.id, mediaType: "audio", status: "pending" })
			.returning();
		await queue.send(QUEUES.PROCESS_AUDIO, { jobId: job.id }, JOB_OPTIONS[QUEUES.PROCESS_AUDIO]);
		return job;
	}
	return null;
}

/**
 * Thumbnails render directly as <img src>; older rows stored a bare storage key instead
 * of a URL — resolve those to public URLs in place (new uploads already store URLs).
 */
async function resolveWorkThumbnail(item: WorkRow): Promise<void> {
	if (
		item.thumbnail &&
		!/^(https?:)?\/\//.test(item.thumbnail) &&
		!item.thumbnail.startsWith("/")
	) {
		item.thumbnail = await storage.getUrl(item.thumbnail);
	}
}

/** Serialize a library content item (owner-facing: full media keys + latest transcode). */
function serializeWork(
	item: WorkRow,
	workAssets: AssetRow[] = [],
	job: TranscodingJobRow | null = null,
) {
	return {
		id: item.id,
		publicId: item.publicId,
		slug: item.slug,
		creatorId: item.creatorId,
		type: item.type,
		title: item.title,
		description: item.description,
		thumbnail: item.thumbnail,
		sourceKey: item.sourceKey,
		embedUrl: item.embedUrl,
		durationSeconds: item.durationSeconds,
		body: item.body,
		bodyHtml: item.bodyHtml,
		estimatedReadMinutes: item.estimatedReadMinutes,
		metadata: stripInternalMetadata(item.metadata),
		visibility: item.visibility,
		releasedAt: item.releasedAt,
		authoredAt: item.authoredAt,
		authoredPrecision: item.authoredPrecision,
		streamEnabled: item.streamEnabled,
		downloadEnabled: item.downloadEnabled,
		anthersAccess: item.anthersAccess,
		seedAccess: item.seedAccess,
		isPinned: item.isPinned,
		tags: item.tags,
		websiteUrl: item.websiteUrl,
		sourceUrl: item.sourceUrl,
		viewCount: item.viewCount,
		downloadCount: item.downloadCount,
		/** The UPLOAD date. Creator-facing only — the public sees authoredAt and releasedAt. */
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		assets: workAssets,
		transcoding: job,
	};
}

/**
 * A storage URL or bare key → the storage key. Playlists/manifests, audio output, and
 * (sometimes) thumbnails are stored as URLs; source keys and asset files are bare keys.
 * Local-dev URLs carry a `/content/` path prefix that isn't part of the key.
 */
function urlToKey(urlOrKey: string): string {
	let path = urlOrKey;
	if (/^(https?:)?\/\//.test(urlOrKey)) {
		try {
			path = decodeURIComponent(new URL(urlOrKey).pathname);
		} catch {
			path = urlOrKey;
		}
	}
	path = path.replace(/^\/+/, "");
	if (path.startsWith("content/")) path = path.slice("content/".length);
	return path;
}

/**
 * Best-effort purge of a content item's stored media before the row (and its cascaded
 * assets/transcodes/post-refs) are deleted: the source, thumbnail, every asset file, each
 * completed video transcode's HLS output prefix, and any processed-audio output. Failures
 * are logged and swallowed so a storage hiccup never blocks the DB delete.
 */
async function purgeWorkMedia(
	item: WorkRow,
	workAssets: AssetRow[],
	jobRows: TranscodingJobRow[],
): Promise<void> {
	const keys = new Set<string>();
	const prefixes = new Set<string>();

	if (item.sourceKey) keys.add(urlToKey(item.sourceKey));
	if (item.thumbnail) keys.add(urlToKey(item.thumbnail));
	for (const a of workAssets) if (a.file) keys.add(urlToKey(a.file));
	for (const job of jobRows) {
		if (job.hlsManifestUrl) {
			const masterKey = urlToKey(job.hlsManifestUrl);
			const prefix = masterKey.replace(/\/[^/]+$/, "");
			if (prefix && prefix !== masterKey) prefixes.add(prefix);
		}
		if (job.outputFileUrl) keys.add(urlToKey(job.outputFileUrl));
	}

	for (const prefix of prefixes) {
		try {
			await storage.deletePrefix(prefix);
		} catch (err) {
			console.error(`[work delete] deletePrefix failed for ${prefix}:`, err);
		}
	}
	for (const key of keys) {
		if (!key) continue;
		try {
			await storage.delete(key);
		} catch (err) {
			console.error(`[work delete] delete failed for ${key}:`, err);
		}
	}
}

// ─── Publish / edit / delete helpers ────────────────────────────────────────────

/**
 * The release-readiness gate: given Work IDs, return the ones whose latest transcoding job
 * hasn't reached "completed" (still pending/processing, or failed). Works with no
 * transcoding job (text, images, games, software) are always ready and never appear here.
 *
 * This now gates **release**, not publish. Media readiness was always a property of the
 * media, and the media belongs to the Work — a post that merely links a Work has nothing
 * to wait for, and blocking it would be blocking an announcement on someone else's encode.
 */
async function unreadyWorks(workIds: number[]): Promise<Array<{ workId: number; status: string }>> {
	if (workIds.length === 0) return [];
	const jobs = await db
		.select({
			workId: transcodingJobs.workId,
			status: transcodingJobs.status,
			createdAt: transcodingJobs.createdAt,
		})
		.from(transcodingJobs)
		.where(inArray(transcodingJobs.workId, workIds))
		.orderBy(desc(transcodingJobs.createdAt));
	const latest = new Map<number, string>();
	for (const j of jobs) if (!latest.has(j.workId)) latest.set(j.workId, j.status);
	const unready: Array<{ workId: number; status: string }> = [];
	for (const [workId, status] of latest)
		if (status !== "completed") unready.push({ workId, status });
	return unready;
}

/**
 * Which content-bearing fields a PATCH actually changed, as human labels — this drives a
 * post's edit history. Publish/unpublish and schedule changes are actions, not content
 * edits, so they're deliberately excluded and never produce a history entry.
 *
 * Delivery and access are gone from this list because they are gone from the post: they
 * belong to the Work now, and a Work's own history is its own concern.
 */
function changedPostFields(
	existing: typeof posts.$inferSelect,
	data: z.infer<typeof updatePostSchema>,
	refsChanged: boolean,
): string[] {
	const changed: string[] = [];
	if (data.title !== undefined && data.title !== (existing.title ?? "")) changed.push("title");
	if (data.slug !== undefined && data.slug !== existing.slug) changed.push("slug");
	const bodyChanged =
		(data.body !== undefined && data.body !== (existing.body ?? "")) ||
		(data.bodyHtml !== undefined && sanitizePostHtml(data.bodyHtml) !== (existing.bodyHtml ?? ""));
	if (bodyChanged) changed.push("body");
	if (refsChanged) changed.push("linked works");
	if (data.showOnTimeline !== undefined && data.showOnTimeline !== existing.showOnTimeline)
		changed.push("timeline visibility");
	if (data.isPinned !== undefined && data.isPinned !== existing.isPinned) changed.push("pin");
	if (data.tags !== undefined && JSON.stringify(data.tags) !== JSON.stringify(existing.tags ?? []))
		changed.push("tags");
	return changed;
}

/**
 * Works referenced by this post and by no other — i.e. those left with no posting history
 * if the post is deleted. NOT orphaned in any meaningful sense any more: a Work stands on
 * its own in the Catalog whether or not a post ever pointed at it, so deleting a post
 * never proposes deleting a Work. Retained only to tell the creator what will lose its
 * link, which is why the delete route no longer purges anything.
 */
async function worksOnlyLinkedFrom(postId: number): Promise<number[]> {
	const mine = await db
		.select({ workId: postWorkRefs.workId })
		.from(postWorkRefs)
		.where(eq(postWorkRefs.postId, postId));
	const ids = [...new Set(mine.map((r) => r.workId))];
	if (ids.length === 0) return [];
	const others = await db
		.select({ workId: postWorkRefs.workId })
		.from(postWorkRefs)
		.where(and(inArray(postWorkRefs.workId, ids), ne(postWorkRefs.postId, postId)));
	const stillLinked = new Set(others.map((r) => r.workId));
	return ids.filter((id) => !stillLinked.has(id));
}

/**
 * A Work's posting history — where it has been announced, and when. This is the record
 * Parker asked for: "a clean record of when the content has been posted". Carries the
 * post date, since a Work may be posted many times over its life.
 */
async function postsUsingWork(workId: number): Promise<
	Array<{
		slug: string;
		title: string | null;
		isPublished: boolean;
		postedAt: Date | null;
	}>
> {
	return await db
		.selectDistinct({
			slug: posts.slug,
			title: posts.title,
			isPublished: posts.isPublished,
			postedAt: posts.publishedAt,
		})
		.from(postWorkRefs)
		.innerJoin(posts, eq(postWorkRefs.postId, posts.id))
		.where(eq(postWorkRefs.workId, workId));
}

// ─── Post → Work references ─────────────────────────────────────────────────────

/**
 * Verify the caller owns every Work they're linking. A post may only reference the
 * creator's own Works for now — cross-creator references are a real future feature
 * (collabs, bundles) but they need their own consent story first.
 */
async function ownedWorkIds(workIds: number[], creatorId: number): Promise<Set<number>> {
	if (workIds.length === 0) return new Set();
	const rows = await db
		.select({ id: works.id })
		.from(works)
		.where(and(inArray(works.id, workIds), eq(works.creatorId, creatorId)));
	return new Set(rows.map((r) => r.id));
}

/**
 * Replace a post's Work references wholesale. There is nothing to reconcile field-by-field
 * — a reference has no state of its own beyond its position, which is exactly the point of
 * keeping it inert. Returns true when the set actually changed, for the edit history.
 */
async function setPostWorkRefs(postId: number, workIds: number[]): Promise<boolean> {
	const existing = await db
		.select({ workId: postWorkRefs.workId, position: postWorkRefs.position })
		.from(postWorkRefs)
		.where(eq(postWorkRefs.postId, postId))
		.orderBy(asc(postWorkRefs.position));

	const wanted = [...new Set(workIds)];
	const before = existing.map((e) => e.workId).join(",");
	if (before === wanted.join(",")) return false;

	await db.delete(postWorkRefs).where(eq(postWorkRefs.postId, postId));
	for (let i = 0; i < wanted.length; i++) {
		await db.insert(postWorkRefs).values({ postId, workId: wanted[i], position: i });
	}
	return true;
}

/**
 * Where a Work's media should be delivered from. When set, a completed transcode's
 * stored URL is rewritten to the matching access-checked endpoint — signed HLS for
 * video, a signed redirect for audio — instead of a raw CDN URL. Stored media is
 * private, so the raw URL 403s; the endpoints are how an entitled viewer actually
 * plays it. Null in local dev, where /content serves everything unsigned.
 *
 * The post slug used to be part of this, because delivery was reached *through* a post
 * and each endpoint had to re-check that the item it was handed actually belonged to the
 * post being used to reach it — otherwise one accessible post unlocked every item on the
 * platform. Gates live on the Work now, so the Work addresses itself and that entire
 * class of cross-reference check disappears with the indirection that created it.
 */
interface DeliveryCtx {
	origin: string;
}

/** URL of the access-checked HLS master for a video Work. */
function buildHlsManifestUrl(ctx: DeliveryCtx, workId: number, file = "master.m3u8"): string {
	return `${ctx.origin}/api/content/works/${workId}/hls/${file}`;
}

/** URL of the access-checked audio endpoint for an audio Work. */
function buildAudioUrl(ctx: DeliveryCtx, workId: number): string {
	return `${ctx.origin}/api/content/works/${workId}/audio`;
}

/**
 * A transcode row as a *viewer* may see it.
 *
 * `hlsManifestUrl` and `outputFileUrl` point at the deliverable, so they follow the
 * same rule as `sourceKey` and asset files: handed out only when the viewer has
 * access. Everything else — status, progress, ETA, error, waveform — stays, so a
 * locked post still renders "Processing…" instead of an empty frame.
 *
 * For a viewer who *does* have access the URLs are rewritten to the access-checked
 * delivery routes. That rewrite is not a nicety: stored media is private, so a raw
 * CDN URL would 403 even for someone entitled to it.
 */
function viewerTranscoding(
	job: TranscodingJobRow | null,
	canAccess: boolean,
	delivery: DeliveryCtx | null,
): TranscodingJobRow | null {
	if (!job) return null;
	if (!canAccess) return { ...job, hlsManifestUrl: null, outputFileUrl: null };
	if (!delivery || job.status !== "completed") return job;

	if (job.mediaType === "video" && job.hlsManifestUrl) {
		return { ...job, hlsManifestUrl: buildHlsManifestUrl(delivery, job.workId) };
	}
	if (job.mediaType === "audio" && job.outputFileUrl) {
		return { ...job, outputFileUrl: buildAudioUrl(delivery, job.workId) };
	}
	return job;
}

/** Parse an `:id` path param, rejecting anything that isn't a positive integer. */
function parseNumericId(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the calling viewer's access to one Work.
 *
 * Every delivery endpoint goes through here, which is the point: access is re-resolved
 * live, per request, against the Work's own gates. Nothing is inherited from a post, a
 * project, or the URL that got the caller here.
 */
async function workAccessFor(
	c: Parameters<typeof getOptionalUserId>[0],
	work: WorkRow,
): Promise<AccessResultLike> {
	const viewerId = await getOptionalUserId(c);
	const ctx = await buildAccessContext(viewerId, { workIds: [work.id] });
	return resolveAccessSync(work as AccessibleWork, ctx);
}

/**
 * Serialize a Work for a viewer, withholding the deliverable when they lack access.
 *
 * The split is the load-bearing part. Everything a *listing* needs — title, type,
 * thumbnail, duration, dates, the access verdict itself — is always present, so a locked
 * Work still renders a proper card with a working unlock prompt. Everything that IS the
 * deliverable — source key, embed URL, asset files, playable media URLs — is handed out
 * only on access. A denied viewer gets no pointer at the payload at all: not a signed
 * one, not an expired one, none.
 */
function serializeWorkForViewer(
	work: WorkRow,
	workAssets: AssetRow[],
	job: TranscodingJobRow | null,
	access: AccessResultLike,
	delivery: DeliveryCtx | null,
) {
	const canAccess = access.canAccess;
	return {
		id: work.id,
		publicId: work.publicId,
		slug: work.slug,
		creatorId: work.creatorId,
		type: work.type,
		title: work.title,
		description: work.description,
		thumbnail: work.thumbnail,
		durationSeconds: work.durationSeconds,
		estimatedReadMinutes: work.estimatedReadMinutes,
		visibility: work.visibility,
		releasedAt: work.releasedAt,
		authoredAt: work.authoredAt,
		authoredPrecision: work.authoredPrecision,
		streamEnabled: work.streamEnabled,
		downloadEnabled: work.downloadEnabled,
		isPinned: work.isPinned,
		tags: work.tags,
		websiteUrl: work.websiteUrl,
		sourceUrl: work.sourceUrl,
		viewCount: work.viewCount,
		downloadCount: work.downloadCount,
		createdAt: work.createdAt,
		updatedAt: work.updatedAt,
		// `clientVariants` are an internal packaging detail (storage keys) — never expose.
		metadata: stripInternalMetadata(work.metadata),
		// Prose IS the deliverable for a text Work, so it is gated like any other payload.
		bodyHtml: work.type === "text" ? (canAccess ? work.bodyHtml : "") : undefined,
		sourceKey: canAccess ? work.sourceKey : "",
		embedUrl: canAccess ? work.embedUrl : "",
		// Download keys are only handed out through the access-checked download route.
		assets: workAssets.map((a) => ({ ...a, file: canAccess ? a.file : "" })),
		transcoding: viewerTranscoding(job, canAccess, delivery),
		access,
	};
}

/** The shape `resolveAccessSync` returns; declared structurally so serialization stays pure. */
type AccessResultLike = ReturnType<typeof resolveAccessSync>;

/** Load Works by id with their assets and latest transcode, ready for serialization. */
async function loadWorkBundles(workIds: number[]): Promise<{
	worksById: Map<number, WorkRow>;
	assetsByWork: Map<number, AssetRow[]>;
	jobByWork: Map<number, TranscodingJobRow>;
}> {
	const worksById = new Map<number, WorkRow>();
	const assetsByWork = new Map<number, AssetRow[]>();
	const jobByWork = new Map<number, TranscodingJobRow>();
	if (workIds.length === 0) return { worksById, assetsByWork, jobByWork };

	const [workRows, assetRows, jobRows] = await Promise.all([
		db.select().from(works).where(inArray(works.id, workIds)),
		db.select().from(assets).where(inArray(assets.workId, workIds)),
		db
			.select()
			.from(transcodingJobs)
			.where(inArray(transcodingJobs.workId, workIds))
			.orderBy(desc(transcodingJobs.createdAt)),
	]);

	await Promise.all(workRows.map(resolveWorkThumbnail));
	for (const w of workRows) worksById.set(w.id, w);
	for (const a of assetRows) {
		const list = assetsByWork.get(a.workId) ?? [];
		list.push(a);
		assetsByWork.set(a.workId, list);
	}
	for (const j of jobRows) {
		if (!jobByWork.has(j.workId)) jobByWork.set(j.workId, j);
	}
	return { worksById, assetsByWork, jobByWork };
}

/**
 * The Works a post references, each resolved against the viewer's own standing.
 *
 * Note what is NOT happening here: the post contributes nothing to access. Each Work is
 * resolved on its own gates, so one post can carry a free Work and a locked one side by
 * side, and a post the viewer can read may link a Work they cannot open.
 */
async function loadPostWorks(
	postId: number,
	viewerId: number | null,
	delivery: DeliveryCtx | null = null,
) {
	const refs = await db
		.select({ workId: postWorkRefs.workId, position: postWorkRefs.position })
		.from(postWorkRefs)
		.where(eq(postWorkRefs.postId, postId))
		.orderBy(asc(postWorkRefs.position));
	if (refs.length === 0) return [];

	const workIds = refs.map((r) => r.workId);
	const { worksById, assetsByWork, jobByWork } = await loadWorkBundles(workIds);
	const ctx = await buildAccessContext(viewerId, { workIds });

	return refs
		.map((ref) => {
			const work = worksById.get(ref.workId);
			if (!work) return null;
			return {
				position: ref.position,
				work: serializeWorkForViewer(
					work,
					assetsByWork.get(work.id) ?? [],
					jobByWork.get(work.id) ?? null,
					resolveAccessSync(work as AccessibleWork, ctx),
					delivery,
				),
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
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
 * Decide where a Work's media should be delivered from. In S3 mode ALL video and audio
 * goes through the access-checked endpoints, because access is enforced live at request
 * time — which is the only way it *can* work: media is processed when a Work is uploaded
 * to the Catalog, before it is released or gated, so there is no access table to consult
 * at upload time, and a Work's access can change after the transcode besides. That is
 * also why the stored objects are uniformly private and this layer signs per request,
 * rather than the jobs trying to bake an ACL. Local dev serves media directly (the
 * /content route serves everything, unsigned) — which is why a delivery leak cannot be
 * reproduced locally, and why the tests assert URLs rather than access reasons.
 */
function deliveryCtx(): DeliveryCtx | null {
	if (isLocalStorage) return null;
	return { origin: publicOrigin() };
}

/**
 * Lifetime of a signed media URL. Must exceed a viewer's watch/listen time, since the
 * URL is handed out once and used for the whole of a VOD playback.
 */
const SIGNED_MEDIA_TTL_SECONDS = 6 * 60 * 60;

/**
 * Rewrite an HLS playlist for signed delivery. In the master, child variant playlists
 * are pointed back through this access-checked endpoint; in a variant playlist, each
 * segment (.ts) becomes a short-lived signed CDN URL. Comment/tag lines pass through.
 */
async function rewriteHlsPlaylist(
	text: string,
	opts: { isMaster: boolean; prefixKey: string; ctx: DeliveryCtx; workId: number },
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
			out.push(buildHlsManifestUrl(opts.ctx, opts.workId, encodeURIComponent(line)));
		} else {
			// A segment (e.g. "720p_000.ts") → a short-lived signed CDN URL.
			out.push(
				await storage.getUrl(`${opts.prefixKey}/${line}`, {
					signed: true,
					expiresIn: SIGNED_MEDIA_TTL_SECONDS,
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

		// Content-type and delivery filters belong to the Catalog now — a post has neither a
		// type nor a delivery method. Filtering the feed by them would mean "posts that
		// mention a video", which is a different question from "videos", and the Catalog
		// answers the one people actually mean. Accepted and ignored so an older client
		// degrades to an unfiltered feed rather than a 400.
		void contentType;
		void delivery;

		// The public feed shows timeline posts only; a creator's own view or a
		// collection view shows everything (including off-timeline posts).
		if (mine !== "true" && !collection) {
			conditions.push(eq(posts.showOnTimeline, true));
		}

		if (tag) conditions.push(sql`${posts.tags} @> ${JSON.stringify([tag])}::jsonb`);

		if (search) {
			conditions.push(or(like(posts.title, `%${search}%`), like(posts.body, `%${search}%`)) as SQL);
		}

		// Sorted on publication, not on when the draft row appeared. `publishedAt` is null
		// for drafts (the creator's own view), so fall back to createdAt to keep them ordered.
		const feedOrder = sql`COALESCE(${posts.publishedAt}, ${posts.createdAt}) DESC`;
		let orderClause: SQL[];
		switch (sort) {
			case "popular":
				orderClause = [desc(posts.viewCount), feedOrder];
				break;
			default:
				orderClause = [feedOrder];
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

		// The Works each post links, for a card thumbnail and a count. Deliberately NOT
		// resolved for access here: the feed lists announcements, and a post's readability
		// has nothing to do with whether the Works it mentions are open.
		const refsByPost = new Map<number, Array<{ id: number; type: string; thumbnail: string }>>();
		if (postIds.length > 0) {
			const refRows = await db
				.select({
					postId: postWorkRefs.postId,
					workId: works.id,
					type: works.type,
					thumbnail: works.thumbnail,
					position: postWorkRefs.position,
				})
				.from(postWorkRefs)
				.innerJoin(works, eq(postWorkRefs.workId, works.id))
				.where(inArray(postWorkRefs.postId, postIds))
				.orderBy(asc(postWorkRefs.position));
			for (const r of refRows) {
				const list = refsByPost.get(r.postId) ?? [];
				list.push({ id: r.workId, type: r.type, thumbnail: r.thumbnail ?? "" });
				refsByPost.set(r.postId, list);
			}
		}

		return c.json({
			posts: result.map((r) => {
				const p = r.post;
				const linked = refsByPost.get(p.id) ?? [];
				return {
					id: p.id,
					publicId: p.publicId,
					slug: p.slug,
					creatorId: p.creatorId,
					title: p.title,
					showOnTimeline: p.showOnTimeline,
					isPinned: p.isPinned,
					tags: p.tags,
					isPublished: p.isPublished,
					publishedAt: p.publishedAt,
					scheduledFor: p.scheduledFor,
					viewCount: p.viewCount,
					createdAt: p.createdAt,
					updatedAt: p.updatedAt,
					creator: {
						username: r.creatorUsername,
						displayName: r.creatorDisplayName,
						avatar: r.creatorAvatar,
					},
					// A card image, if the post links anything. Thumbnails are public — they are
					// the preview a locked Work is *supposed* to show.
					thumbnail: linked[0]?.thumbnail ?? "",
					linkedWorkCount: linked.length,
				};
			}),
		});
	})

	.post("/posts", requireAuth, zValidator("json", createPostSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// A post may only link the caller's own Works. Cross-creator references are a real
		// future feature (collabs, bundles) but they need a consent story first.
		const owned = await ownedWorkIds(data.workIds, user.id);
		if (data.workIds.some((id) => !owned.has(id))) {
			return c.json({ error: "A linked Work was not found in your Catalog." }, 400);
		}

		// NOTE: publishing is deliberately NOT gated on media readiness any more. Readiness is
		// a property of the media, the media belongs to the Work, and a post that merely links
		// a Work has nothing to wait for — blocking an announcement on someone's encode was an
		// artefact of the post owning the media. The gate moved to RELEASE, on the Work.

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
		const publicId = await makeUniquePublicId(posts);

		const [post] = await db
			.insert(posts)
			.values({
				creatorId: user.id,
				publicId,
				slug,
				title: data.title,
				body: data.body,
				bodyHtml,
				showOnTimeline: data.showOnTimeline,
				isPinned: data.isPinned,
				tags: data.tags,
				isPublished: data.isPublished,
				// The feed's sort key. Set exactly when the post becomes live.
				publishedAt: data.isPublished ? new Date() : null,
				// Publishing now clears any schedule; otherwise store the requested publish time.
				scheduledFor: data.isPublished
					? null
					: data.scheduledFor
						? new Date(data.scheduledFor)
						: null,
			})
			.returning();

		await setPostWorkRefs(post.id, data.workIds);

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

		const linkedWorks = await loadPostWorks(post.id, user.id, deliveryCtx());
		return c.json({ post: { ...post, linkedWorks } }, 201);
	})

	.get("/posts/:slug", async (c) => {
		const { slug } = c.req.param();
		const post = await findPostRow(slug);
		if (!post) return c.json({ error: "Post not found" }, 404);

		// An unpublished post (draft / scheduled / unpublished) is visible only to its creator —
		// the permalink 404s for everyone else, matching how drafts are hidden from feeds.
		const viewerId = await getOptionalUserId(c);
		if (!post.isPublished && viewerId !== post.creatorId) {
			return c.json({ error: "Post not found" }, 404);
		}

		const [creator] = await db
			.select({ username: users.username, displayName: users.displayName, avatar: users.avatar })
			.from(users)
			.where(eq(users.id, post.creatorId))
			.limit(1);

		// Can the creator receive a direct-purchase payout? (Connected account, onboarded
		// and payouts-enabled.) Drives whether the buyer sees a live checkout.
		const [creatorStripe] = await db
			.select({
				payoutsEnabled: stripeAccounts.payoutsEnabled,
				onboardingComplete: stripeAccounts.onboardingComplete,
			})
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, post.creatorId))
			.limit(1);
		const creatorHasStripe = !!creatorStripe?.onboardingComplete && !!creatorStripe.payoutsEnabled;

		const [agg] = await db
			.select({ average: avg(ratings.score), count: count(ratings.id) })
			.from(ratings)
			.where(and(eq(ratings.postId, post.id), visibleRating));

		// Fire-and-forget view count.
		db.update(posts)
			.set({ viewCount: sql`${posts.viewCount} + 1` })
			.where(eq(posts.id, post.id))
			.execute();

		// A post has no gates of its own: it is an announcement, and announcements are for
		// the audience. Each Work it links resolves on its OWN gates, so this page can show
		// a readable post alongside a Work the viewer cannot open — which is exactly the
		// separation the model is for, and why there is no post-level `access` any more.
		const linkedWorks = await loadPostWorks(post.id, viewerId, deliveryCtx());

		// Transparent edit history — every content edit is logged with a timestamp.
		const edits = await db
			.select({
				editedAt: postEdits.editedAt,
				summary: postEdits.summary,
				changedFields: postEdits.changedFields,
			})
			.from(postEdits)
			.where(eq(postEdits.postId, post.id))
			.orderBy(desc(postEdits.editedAt));

		return c.json({
			post: {
				...post,
				creator: { ...creator, hasStripe: creatorHasStripe },
				ratingAverage: agg.average ? Number(agg.average) : null,
				ratingCount: Number(agg.count),
				linkedWorks,
				edits,
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

		// Linked Works must belong to the caller — validated before any writes so a bad
		// reference never partially applies.
		if (data.workIds !== undefined) {
			const owned = await ownedWorkIds(data.workIds, user.id);
			if (data.workIds.some((id) => !owned.has(id))) {
				return c.json({ error: "A linked Work was not found in your Catalog." }, 400);
			}
		}

		if (data.slug && data.slug !== existing.slug) {
			if (await postSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		// Replacing the reference set reports whether it actually changed, for the history.
		const refsChanged =
			data.workIds !== undefined ? await setPostWorkRefs(existing.id, data.workIds) : false;

		const updates: Record<string, unknown> = { updatedAt: new Date() };
		if (data.slug !== undefined) updates.slug = data.slug;
		if (data.title !== undefined) updates.title = data.title;
		if (data.body !== undefined) updates.body = data.body;
		if (data.bodyHtml !== undefined) updates.bodyHtml = sanitizePostHtml(data.bodyHtml);
		if (data.showOnTimeline !== undefined) updates.showOnTimeline = data.showOnTimeline;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.tags !== undefined) updates.tags = data.tags;
		if (data.isPublished !== undefined) updates.isPublished = data.isPublished;
		if (data.scheduledFor !== undefined)
			updates.scheduledFor = data.scheduledFor ? new Date(data.scheduledFor) : null;
		// Publishing now supersedes and clears any pending schedule.
		if (data.isPublished === true) updates.scheduledFor = null;
		// Stamp the publication time on the transition INTO published, and only then — a
		// re-publish of something already live must not rewrite its place in the feed.
		if (data.isPublished === true && !existing.isPublished) updates.publishedAt = new Date();

		const [updated] = await db
			.update(posts)
			.set(updates)
			.where(eq(posts.id, existing.id))
			.returning();

		// Record a timestamped edit-history entry when the post's content actually changed
		// (publish/unpublish/schedule toggles don't count — see changedPostFields).
		const editedFields = changedPostFields(existing, data, refsChanged);
		if (editedFields.length > 0) {
			await db.insert(postEdits).values({
				postId: existing.id,
				summary: editedFields.join(", "),
				changedFields: editedFields,
			});
		}

		const linkedWorks = await loadPostWorks(updated.id, user.id, deliveryCtx());
		return c.json({ post: { ...updated, linkedWorks } });
	})

	/**
	 * Which Works would be left with no posting history if this post went away. Nothing is
	 * deleted with the post any more — a Work stands on its own in the Catalog whether or
	 * not a post ever pointed at it — so this is informational only, and the delete route
	 * purges nothing. Owner-only.
	 */
	.get("/posts/:slug/orphaned-media", requireAuth, async (c) => {
		const user = c.get("user");
		const existing = await findPostRow(c.req.param("slug"));
		if (!existing || existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);
		const ids = await worksOnlyLinkedFrom(existing.id);
		if (ids.length === 0) return c.json({ items: [] });
		const items = await db
			.select({
				id: works.id,
				title: works.title,
				type: works.type,
				thumbnail: works.thumbnail,
			})
			.from(works)
			.where(inArray(works.id, ids));
		return c.json({ items });
	})

	.delete("/posts/:slug", requireAuth, zValidator("query", deletePostQuerySchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const { purgeMedia } = c.req.valid("query");
		const existing = await findPostRow(slug);
		if (!existing || existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		// `purgeMedia` is accepted and deliberately ignored — deleting an announcement must
		// never destroy the work it announced. Under the old model a post OWNED its content,
		// so an opt-in purge was the careful thing to offer; now a Work stands on its own in
		// the Catalog and is deleted from there, on purpose, by its own route. Kept in the
		// schema so an older client's `?purgeMedia=1` is a no-op rather than a 400.
		void purgeMedia;

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
			.where(and(eq(comments.postId, post.id), visibleComment))
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

	// ── Post Reviews ───────────────────────────────────────────────────────────
	// A review is a score plus written text — a score can't be left on its own.
	// The route path stays `/ratings` (and the table stays `ratings`): "review" is
	// a copy rule, not a schema rule, exactly like the Seed vocabulary changes.
	.get("/posts/:slug/ratings", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		const [agg] = await db
			.select({ average: avg(ratings.score), count: count(ratings.id) })
			.from(ratings)
			.where(and(eq(ratings.postId, post.id), visibleRating));

		// The written reviews themselves. Hidden ones are withheld here for the same
		// reason they're excluded from the aggregate — this is a public read.
		const reviewRows = await db
			.select({
				id: ratings.id,
				userId: ratings.userId,
				score: ratings.score,
				body: ratings.body,
				createdAt: ratings.createdAt,
				username: users.username,
				avatar: users.avatar,
			})
			.from(ratings)
			.innerJoin(users, eq(ratings.userId, users.id))
			.where(and(eq(ratings.postId, post.id), visibleRating))
			.orderBy(desc(ratings.createdAt));

		let userRating: number | null = null;
		let userReview: string | null = null;
		const currentUserId = await getOptionalUserId(c);
		if (currentUserId) {
			// Deliberately unfiltered by moderation status: the score and words a
			// viewer submitted shouldn't silently change under them. Their review
			// simply stops counting and stops appearing to everyone else.
			const [row] = await db
				.select({ score: ratings.score, body: ratings.body })
				.from(ratings)
				.where(and(eq(ratings.postId, post.id), eq(ratings.userId, currentUserId)))
				.limit(1);
			userRating = row?.score ?? null;
			userReview = row?.body ?? null;
		}

		return c.json({
			average: agg.average ? Number(agg.average) : null,
			count: Number(agg.count),
			userRating,
			userReview,
			// `body` is null on rows written before reviews required text. They still
			// render and still count; the client shows the score without a quote.
			reviews: reviewRows.map((r) => ({ ...r, body: r.body ?? "" })),
		});
	})

	.post("/posts/:slug/ratings", requireAuth, zValidator("json", createRatingSchema), async (c) => {
		const user = c.get("user");
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		const { score, body } = c.req.valid("json");
		// The conflict branch sets `score` and `body` and nothing else — notably not
		// `moderationStatus`. Re-reviewing changes the score and the words on a hidden
		// row without resurrecting it, so a user can't un-hide their own review by
		// submitting again. Adding a field here means adding it to BOTH the insert
		// and this set clause; forgetting the set clause silently makes edits no-ops.
		const [rating] = await db
			.insert(ratings)
			.values({ userId: user.id, postId: post.id, score, body: body.trim() })
			.onConflictDoUpdate({
				target: [ratings.userId, ratings.postId],
				set: { score, body: body.trim() },
			})
			.returning();

		return c.json({ rating }, 201);
	})

	// ── Access-checked asset download ─────────────────────────────────────────────
	// Assets belong to a Work, and the Work carries the gate. No post is involved: an
	// entitled viewer can download from the Catalog whether or not anything was announced.
	.post("/works/:id/assets/:assetId/download", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const [asset] = await db
			.select()
			.from(assets)
			.where(and(eq(assets.id, Number(c.req.param("assetId"))), eq(assets.workId, work.id)))
			.limit(1);
		if (!asset) return c.json({ error: "Asset not found" }, 404);

		// Enforce access server-side — the UI gate is not the source of truth.
		const access = await workAccessFor(c, work);
		if (!access.canAccess) {
			return c.json({ error: "Purchase or subscription required", access }, 403);
		}

		db.update(works)
			.set({ downloadCount: sql`${works.downloadCount} + 1` })
			.where(eq(works.id, work.id))
			.execute();

		// Assets are stored private; hand back a short-lived signed URL (local mode
		// ignores signing and serves via /content).
		const url = await storage.getUrl(asset.file, { signed: true, expiresIn: 300 });
		return c.json({ url });
	})

	// ── Transcoding status for a Work ────────────────────────────────────────────
	.get("/works/:id/transcoding", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const jobs = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.workId, work.id))
			.orderBy(desc(transcodingJobs.createdAt));

		// Serialized exactly as Work detail does — same helper, same rule. That matters:
		// this route is a second way to reach the same rows, so anything Work detail
		// withholds has to be withheld here too or the poller becomes the side channel
		// around it. Status still flows to a denied viewer; only the payload URLs don't.
		const access = await workAccessFor(c, work);
		return c.json({
			jobs: jobs.map((job) => viewerTranscoding(job, access.canAccess, deliveryCtx())),
		});
	})

	// ── Audio delivery (access-checked, signed) ──────────────────────────────────
	// The audio counterpart of the HLS endpoint below. Processed audio is stored private,
	// so this is the only way to reach it: access is re-checked here on every request,
	// then we redirect to a short-lived signed CDN URL. A redirect rather than a proxy so
	// range requests (seeking) go straight to the CDN instead of through the API.
	.get("/works/:id/audio", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const [job] = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.workId, work.id))
			.orderBy(desc(transcodingJobs.createdAt))
			.limit(1);
		if (!job?.outputFileUrl) return c.json({ error: "Not found" }, 404);

		const url = await storage.getUrl(urlToKey(job.outputFileUrl), {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		// no-store so the 302 (which carries a signed URL, and is access-dependent) is
		// never cached by a proxy and replayed at a viewer who shouldn't have it.
		c.header("Cache-Control", "no-store");
		return c.redirect(url, 302);
	})

	// ── HLS delivery (access-checked, signed segments) ───────────────────────────
	// Serves the master + variant playlists for a video Work, rewriting segment refs to
	// short-lived signed CDN URLs. Segments are always private, so EVERY accessible Work
	// (free or gated) is pointed here by serializeWorkForViewer; this check is the gate.
	.get("/works/:id/hls/:file", async (c) => {
		const file = c.req.param("file");
		// Playlists only — segments are fetched straight from the CDN via signed URLs.
		if (!/^[A-Za-z0-9_.-]+\.m3u8$/.test(file)) return c.json({ error: "Not found" }, 404);

		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		// Enforce access server-side — this is the gate for private segments.
		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const workId = work.id;
		const [job] = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.workId, workId))
			.orderBy(desc(transcodingJobs.createdAt))
			.limit(1);
		const manifestUrl = job?.hlsManifestUrl;
		if (!manifestUrl) return c.json({ error: "Not found" }, 404);

		// Storage key prefix = the directory of the master.m3u8 key. Playlists are stored
		// private alongside their segments, so fetch this one signed — a bare URL 403s.
		//
		// `urlToKey`, not a hand-rolled `new URL(...).pathname`: the two differ by the
		// `content/` prefix that local storage puts in its URLs and S3 does not. The inline
		// version was therefore correct against Spaces (bucket in the host, path IS the key)
		// and silently wrong in dev, where it produced `content/creators/…` and made every
		// HLS request 404. The audio endpoint above already used the helper, so the two
		// delivery routes disagreed about how to read the same kind of URL.
		const masterKey = urlToKey(manifestUrl);
		const prefixKey = masterKey.replace(/\/[^/]+$/, "");

		// Read the playlist straight out of storage rather than signing a URL and fetching
		// it. In local mode that fetch went to `localhost:8000/content/...` — the API
		// calling ITSELF from inside a request handler, which reset under CI's concurrency
		// and took the rest of the walk down with it. In S3 mode it was a needless
		// round-trip. Playlists are a few hundred bytes; segments still stream from the CDN.
		const bytes = await storage.read(`${prefixKey}/${file}`);
		if (!bytes) return c.json({ error: "Not found" }, 404);

		const rewritten = await rewriteHlsPlaylist(new TextDecoder().decode(bytes), {
			isMaster: file === "master.m3u8",
			prefixKey,
			ctx: { origin: publicOrigin() },
			workId,
		});
		return c.body(rewritten, 200, {
			"Content-Type": "application/vnd.apple.mpegurl",
			"Cache-Control": "no-store",
		});
	})

	// ══════════════════════════════════════════════════════════════════════════
	// CONTENT LIBRARY — creator-owned, reusable content items
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * Create a library content item owned by the caller. Media items with a source that
	 * needs processing are queued here (once, in the library) — never on post save.
	 */
	.post("/works", requireAuth, zValidator("json", createWorkSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// A Work is born private. Nothing is visible on upload — release is a separate,
		// deliberate act, which is the whole point of separating the Catalog from posting.
		const requestedVisibility = data.visibility ?? "private";
		if (requestedVisibility === "released") {
			return c.json(
				{
					error: "Create the Work first, then release it once its media is ready.",
					code: "release_on_create",
				},
				400,
			);
		}

		let slug: string;
		if (data.slug) {
			if (await workSlugExists(data.slug)) {
				return c.json({ error: "A Work with this slug already exists" }, 409);
			}
			slug = data.slug;
		} else {
			slug = await makeUniqueSlug(data.title || data.type, workSlugExists);
		}

		const bodyHtml = data.type === "text" ? sanitizePostHtml(data.bodyHtml ?? "") : "";
		const publicId = await makeUniquePublicId(works);

		const [work] = await db
			.insert(works)
			.values({
				creatorId: user.id,
				publicId,
				slug,
				type: data.type,
				title: data.title,
				description: data.description,
				thumbnail: data.thumbnail,
				sourceKey: data.sourceKey,
				embedUrl: data.embedUrl,
				durationSeconds: data.durationSeconds ?? null,
				body: data.body ?? "",
				bodyHtml,
				estimatedReadMinutes:
					data.type === "text" && (bodyHtml || data.body)
						? estimateReadMinutes(bodyHtml || (data.body ?? ""))
						: null,
				metadata: data.metadata ?? {},
				visibility: "private",
				authoredAt: data.authoredAt ? new Date(data.authoredAt) : null,
				authoredPrecision: data.authoredPrecision ?? null,
				streamEnabled: data.streamEnabled ?? true,
				downloadEnabled: data.downloadEnabled ?? false,
				anthersAccess: data.anthersAccess ?? defaultAnthersAccess(),
				seedAccess: data.seedAccess ?? defaultSeedAccess(),
				isPinned: data.isPinned ?? false,
				tags: data.tags ?? [],
				websiteUrl: data.websiteUrl ?? "",
				sourceUrl: data.sourceUrl ?? "",
			})
			.returning();

		const job = await queueTranscodeForWork(work);
		await resolveWorkThumbnail(work);
		return c.json({ work: serializeWork(work, [], job) }, 201);
	})

	/** The caller's own Catalog — every Work, private and released, with processing state. */
	.get("/works", requireAuth, async (c) => {
		const user = c.get("user");

		const items = await db
			.select()
			.from(works)
			.where(eq(works.creatorId, user.id))
			.orderBy(desc(works.createdAt));
		if (items.length === 0) return c.json({ works: [] });

		const ids = items.map((i) => i.id);
		const [assetRows, jobRows] = await Promise.all([
			db.select().from(assets).where(inArray(assets.workId, ids)),
			db
				.select()
				.from(transcodingJobs)
				.where(inArray(transcodingJobs.workId, ids))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		const assetsByWork = new Map<number, AssetRow[]>();
		for (const a of assetRows) {
			const list = assetsByWork.get(a.workId) ?? [];
			list.push(a);
			assetsByWork.set(a.workId, list);
		}
		const jobByWork = new Map<number, TranscodingJobRow>();
		for (const j of jobRows) {
			if (!jobByWork.has(j.workId)) jobByWork.set(j.workId, j);
		}

		await Promise.all(items.map(resolveWorkThumbnail));
		return c.json({
			works: items.map((i) =>
				serializeWork(i, assetsByWork.get(i.id) ?? [], jobByWork.get(i.id) ?? null),
			),
		});
	})

	/**
	 * One Work — the Catalog's public detail endpoint, and the owner's editor payload.
	 *
	 * Deliberately one route serving both. The owner gets the full row (including the
	 * access tables they edit); everyone else gets the viewer serialization, which withholds
	 * the deliverable unless their access resolves. Two routes would mean two places for
	 * "what may this viewer see?" to drift apart, and the whole point of this layer is that
	 * the question has one answer.
	 *
	 * A `private` Work 404s for everyone but its creator — not 403, because the existence
	 * of unreleased work is itself not public information.
	 */
	.get("/works/:id", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const viewerId = await getOptionalUserId(c);
		const isOwner = viewerId != null && viewerId === work.creatorId;
		if (work.visibility !== "released" && !isOwner) {
			return c.json({ error: "Work not found" }, 404);
		}

		const [workAssets, jobRows] = await Promise.all([
			db.select().from(assets).where(eq(assets.workId, work.id)),
			db
				.select()
				.from(transcodingJobs)
				.where(eq(transcodingJobs.workId, work.id))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		await resolveWorkThumbnail(work);

		if (isOwner) {
			return c.json({ work: serializeWork(work, workAssets, jobRows[0] ?? null) });
		}

		// Fire-and-forget view count, owners excluded.
		db.update(works)
			.set({ viewCount: sql`${works.viewCount} + 1` })
			.where(eq(works.id, work.id))
			.execute();

		const ctx = await buildAccessContext(viewerId, { workIds: [work.id] });
		const [creator] = await db
			.select({ username: users.username, displayName: users.displayName, avatar: users.avatar })
			.from(users)
			.where(eq(users.id, work.creatorId))
			.limit(1);

		return c.json({
			work: {
				...serializeWorkForViewer(
					work,
					workAssets,
					jobRows[0] ?? null,
					resolveAccessSync(work as AccessibleWork, ctx),
					deliveryCtx(),
				),
				creator,
				// Where this Work has been announced — the other half of the reference.
				postedIn: await postsUsingWork(work.id),
			},
		});
	})

	/**
	 * A creator's public Catalog — their released Works, newest-made first.
	 *
	 * Sorted by the creator-asserted **Created** date by default, so it reads as a body of
	 * work in the order it was made rather than the order it happened to be uploaded.
	 * `sort=released` gives "what's new here" instead. Works with no Created date fall back
	 * to their release date so they can't vanish to the bottom.
	 */
	.get("/catalog/:username", async (c) => {
		const username = c.req.param("username");
		const sort = c.req.query("sort") ?? "authored";
		const type = c.req.query("type");

		const [creator] = await db
			.select({ id: users.id, username: users.username, displayName: users.displayName })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);
		if (!creator) return c.json({ error: "Creator not found" }, 404);

		const viewerId = await getOptionalUserId(c);
		const conditions: SQL[] = [eq(works.creatorId, creator.id)];
		// A creator browsing their own Catalog sees drafts too; nobody else does.
		if (viewerId !== creator.id) conditions.push(eq(works.visibility, "released"));
		if (type) conditions.push(eq(works.type, type));

		const order =
			sort === "released"
				? sql`COALESCE(${works.releasedAt}, ${works.createdAt}) DESC`
				: sql`COALESCE(${works.authoredAt}, ${works.releasedAt}, ${works.createdAt}) DESC`;

		const rows = await db
			.select()
			.from(works)
			.where(and(...conditions))
			.orderBy(desc(works.isPinned), order)
			.limit(200);
		if (rows.length === 0) return c.json({ creator, works: [] });

		const ids = rows.map((r) => r.id);
		const { assetsByWork, jobByWork } = await loadWorkBundles(ids);
		const ctx = await buildAccessContext(viewerId, { workIds: ids });
		await Promise.all(rows.map(resolveWorkThumbnail));

		return c.json({
			creator,
			works: rows.map((w) =>
				serializeWorkForViewer(
					w,
					assetsByWork.get(w.id) ?? [],
					jobByWork.get(w.id) ?? null,
					resolveAccessSync(w as AccessibleWork, ctx),
					deliveryCtx(),
				),
			),
		});
	})

	/**
	 * Update a Work (owner-only) — including releasing it. Re-queues processing when the
	 * source changes.
	 *
	 * **Release is the gate that matters here.** A Work may only go public once its media
	 * is actually ready and it has some way to be consumed; this is where the readiness
	 * check that used to sit on post-publish now lives, because readiness was always a
	 * property of the media and the media belongs to the Work.
	 */
	.patch("/works/:id", requireAuth, zValidator("json", updateWorkSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!work || work.creatorId !== user.id) {
			return c.json({ error: "Work not found" }, 404);
		}

		const data = c.req.valid("json");

		if (data.slug && data.slug !== work.slug) {
			if (await workSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		// Delivery floor, evaluated on the state this edit RESULTS IN. `updateWorkSchema` is
		// `.partial()`, which silently drops any create-time refine, so a PATCH sending only
		// `streamEnabled: false` is valid or not depending on the STORED `downloadEnabled` —
		// something a schema refine cannot see.
		const willStream = data.streamEnabled ?? work.streamEnabled;
		const willDownload = data.downloadEnabled ?? work.downloadEnabled;
		if (!willStream && !willDownload) {
			return c.json({ error: "A Work must enable at least one of stream or download" }, 400);
		}

		const releasing = data.visibility === "released" && work.visibility !== "released";
		if (releasing && PROCESSED_WORK_TYPES.has(work.type)) {
			const unready = await unreadyWorks([work.id]);
			if (unready.length > 0) {
				return c.json(
					{
						error: "Can't release yet — the media is still processing.",
						code: "media_not_ready",
						unready,
					},
					409,
				);
			}
		}

		const updates: Record<string, unknown> = { updatedAt: new Date() };
		if (data.slug !== undefined) updates.slug = data.slug;
		if (data.title !== undefined) updates.title = data.title;
		if (data.description !== undefined) updates.description = data.description;
		if (data.thumbnail !== undefined) updates.thumbnail = data.thumbnail;
		if (data.embedUrl !== undefined) updates.embedUrl = data.embedUrl;
		if (data.durationSeconds !== undefined) updates.durationSeconds = data.durationSeconds;
		if (data.metadata !== undefined) updates.metadata = data.metadata;
		if (data.streamEnabled !== undefined) updates.streamEnabled = data.streamEnabled;
		if (data.downloadEnabled !== undefined) updates.downloadEnabled = data.downloadEnabled;
		if (data.anthersAccess !== undefined) updates.anthersAccess = data.anthersAccess;
		if (data.seedAccess !== undefined) updates.seedAccess = data.seedAccess;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.tags !== undefined) updates.tags = data.tags;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.sourceUrl !== undefined) updates.sourceUrl = data.sourceUrl;
		if (data.body !== undefined) updates.body = data.body;
		if (data.bodyHtml !== undefined && work.type === "text") {
			updates.bodyHtml = sanitizePostHtml(data.bodyHtml);
			updates.estimatedReadMinutes = estimateReadMinutes(updates.bodyHtml as string);
		}

		// The creator-asserted Created date. Clearing it clears its precision with it —
		// a precision without a date would claim accuracy about nothing.
		if (data.authoredAt !== undefined) {
			updates.authoredAt = data.authoredAt ? new Date(data.authoredAt) : null;
			if (!data.authoredAt) updates.authoredPrecision = null;
		}
		if (data.authoredPrecision !== undefined && data.authoredPrecision !== null) {
			updates.authoredPrecision = data.authoredPrecision;
		}

		if (data.visibility !== undefined) {
			updates.visibility = data.visibility;
			// Stamped on the FIRST release only. Un-releasing and re-releasing must not
			// rewrite a Work's place in the Catalog's "what's new" ordering.
			if (releasing && !work.releasedAt) updates.releasedAt = new Date();
		}

		const sourceChanged = data.sourceKey !== undefined && data.sourceKey !== work.sourceKey;
		if (data.sourceKey !== undefined) updates.sourceKey = data.sourceKey;

		const [updated] = await db.update(works).set(updates).where(eq(works.id, id)).returning();

		// A new source means the old transcode is stale — re-process.
		if (sourceChanged && updated.sourceKey) await queueTranscodeForWork(updated);

		const [workAssets, jobRows] = await Promise.all([
			db.select().from(assets).where(eq(assets.workId, id)),
			db
				.select()
				.from(transcodingJobs)
				.where(eq(transcodingJobs.workId, id))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		await resolveWorkThumbnail(updated);
		return c.json({ work: serializeWork(updated, workAssets, jobRows[0] ?? null) });
	})

	/**
	 * A Work's posting history — where it has been announced, and when. Doubles as the
	 * preview that has to exist before a delete can be an informed choice.
	 */
	.get("/works/:id/usage", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db
			.select({ id: works.id })
			.from(works)
			.where(and(eq(works.id, id), eq(works.creatorId, user.id)))
			.limit(1);
		if (!item) return c.json({ error: "Work not found" }, 404);

		return c.json({ posts: await postsUsingWork(id) });
	})

	.delete(
		"/works/:id",
		requireAuth,
		zValidator("query", deleteWorkQuerySchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
			if (!item || item.creatorId !== user.id) {
				return c.json({ error: "Work not found" }, 404);
			}

			// `post_work_refs.workId` cascades, so deleting a linked Work silently strips it
			// from every post referencing it — including published ones. Refuse unless the
			// caller has seen the damage and opted in, and hand back the list so a client can
			// show it. Failing closed is deliberate: the destructive reading of an ambiguous
			// request is the unrecoverable one.
			const force = c.req.valid("query").force;
			if (!force) {
				const inUse = await postsUsingWork(id);
				if (inUse.length > 0) {
					return c.json(
						{
							error: `This Work is linked from ${inUse.length} post${inUse.length === 1 ? "" : "s"}. Deleting it removes it from ${inUse.length === 1 ? "that post" : "those posts"}.`,
							code: "work_in_use",
							posts: inUse,
						},
						409,
					);
				}
			}

			const [workAssets, jobRows] = await Promise.all([
				db.select().from(assets).where(eq(assets.workId, id)),
				db.select().from(transcodingJobs).where(eq(transcodingJobs.workId, id)),
			]);
			await purgeWorkMedia(item, workAssets, jobRows);

			await db.delete(works).where(eq(works.id, id));
			return c.body(null, 204);
		},
	)

	// ── Content-item downloadable assets (builds/variants) ────────────────────────
	.post(
		"/works/:id/assets",
		requireAuth,
		zValidator("json", createAssetSchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [item] = await db
				.select({ id: works.id })
				.from(works)
				.where(and(eq(works.id, id), eq(works.creatorId, user.id)))
				.limit(1);
			if (!item) return c.json({ error: "Work not found" }, 404);

			const data = c.req.valid("json");
			const [asset] = await db
				.insert(assets)
				.values({ workId: id, ...data })
				.returning();
			return c.json({ asset }, 201);
		},
	)

	.delete("/works/:id/assets/:assetId", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db
			.select({ id: works.id })
			.from(works)
			.where(and(eq(works.id, id), eq(works.creatorId, user.id)))
			.limit(1);
		if (!item) return c.json({ error: "Not found" }, 404);

		const deleted = await db
			.delete(assets)
			.where(and(eq(assets.id, Number(c.req.param("assetId"))), eq(assets.workId, id)))
			.returning({ id: assets.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
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
		const viewerId = await getOptionalUserId(c);

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
			.where(
				and(
					eq(projectPosts.projectId, row.project.id),
					// Draft members are the creator's own business. This route is
					// unauthenticated and filtered neither the project's `isPublished` nor its
					// members', so a draft added to a project leaked its title, slug and
					// thumbnail to anyone holding the project URL. Metadata only — post detail
					// already 404'd and the delivery routes re-resolve — but a leak all the same.
					viewerId === row.project.creatorId ? undefined : eq(posts.isPublished, true),
				),
			)
			.orderBy(asc(projectPosts.sortOrder), asc(posts.createdAt));

		return c.json({
			project: {
				...row.project,
				creator: {
					username: row.creatorUsername,
					displayName: row.creatorDisplayName,
					avatar: row.creatorAvatar,
				},
				// No per-post access verdict: a post has no gates. The Works a member post
				// links resolve on their own gates, at the post's own endpoint.
				posts: memberRows.map((m) => ({
					id: m.post.id,
					publicId: m.post.publicId,
					slug: m.post.slug,
					title: m.post.title,
					isPublished: m.post.isPublished,
					publishedAt: m.post.publishedAt,
					sortOrder: m.sortOrder,
					creator: {
						username: m.creatorUsername,
						displayName: m.creatorDisplayName,
						avatar: m.creatorAvatar,
					},
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
					headers: {} as Record<string, string>,
					key,
				});
			}

			// Consult the same allowlist the direct route uses rather than restating it.
			// Every member of this route's enum is a deliverable, so this is "private"
			// today — the point is that it stays correct if the enum ever grows.
			const { url, headers } = await storage.getPresignedUploadUrl(
				key,
				contentType,
				aclForMediaType(mediaType),
				3600,
			);
			return c.json({ method: "presigned" as const, uploadUrl: url, headers, key });
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

		// Public ONLY for display chrome; everything else private, including any
		// mediaType this route doesn't recognise (it arrives unvalidated off the form).
		const acl = aclForMediaType(mediaType);

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
				workTitle: works.title,
				workSlug: works.slug,
				workPublicId: works.publicId,
				workType: works.type,
				workThumbnail: works.thumbnail,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(bookmarks)
			.leftJoin(projects, eq(bookmarks.projectId, projects.id))
			.leftJoin(posts, eq(bookmarks.postId, posts.id))
			.leftJoin(works, eq(bookmarks.workId, works.id))
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
					? { title: r.postTitle, slug: r.postSlug, publicId: r.postPublicId }
					: null,
				work: r.bookmark.workId
					? {
							title: r.workTitle,
							slug: r.workSlug,
							publicId: r.workPublicId,
							type: r.workType,
							thumbnail: r.workThumbnail,
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

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content routes — the unified Post model over a creator-owned content library.
 *
 * A **content item** (`content_items`) is a creator's first-class, reusable piece of
 * media/product — it OWNS its source media, downloadable variants (`assets`), and
 * transcodes (`transcoding_jobs`); processing runs once on upload to the library.
 * A **Post** is an ordered list of entries (`post_contents`): each entry is either an
 * inline TEXT block (post-native prose) or a REFERENCE to a library content item. The
 * post is the access point — a referenced item inherits the post's access rules — so a
 * post can be deleted without destroying content. Delivery (stream and/or download) and
 * access (the two OR-gated access tables) are orthogonal per-post switches. Projects are
 * collections that group posts via a many-to-many join — not a content type.
 *
 * Posts are addressed by a durable numeric `publicId`; the canonical URL is
 * `/posts/{slug}-{publicId}` and a route param of either the bare publicId or the
 * slug-publicId form resolves to the same post (slug alone still works too).
 *
 * See Architecture › "30.1 - Unified Post & Content Model".
 */

import { db } from "@anthers/db/client";
import {
	assets,
	bookmarks,
	comments,
	contentItems,
	inlineImages,
	postContents,
	postEdits,
	posts,
	projectPosts,
	projects,
	ratings,
	stripeAccounts,
	transcodingJobs,
	users,
} from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, asc, avg, count, desc, eq, inArray, like, ne, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { requireAuth } from "../middleware/auth.js";
import {
	type AccessiblePost,
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

/** A post entry — either an inline text block or a reference to a library content item. */
type PostEntryLike = { kind: string; contentItemId?: number | null };

/**
 * Post primary type for cards/badges/filter — derived from the FIRST content-ref's
 * item type. A post with only text blocks (no content refs) is "text".
 */
function deriveContentType(
	entries: PostEntryLike[],
	itemsById: Map<number, { type: string }>,
): string {
	const first = entries.find((e) => e.kind === "content" && e.contentItemId != null);
	if (!first || first.contentItemId == null) return "text";
	return itemsById.get(first.contentItemId)?.type ?? "text";
}

/** Denormalized card image: the FIRST content-ref item's thumbnail (text-only → ""). */
function deriveThumbnail(
	entries: PostEntryLike[],
	itemsById: Map<number, { thumbnail?: string | null }>,
): string {
	const first = entries.find((e) => e.kind === "content" && e.contentItemId != null);
	if (!first || first.contentItemId == null) return "";
	return itemsById.get(first.contentItemId)?.thumbnail ?? "";
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** Library content-item types (rich text/prose is NOT a library item — it stays post-native). */
const CONTENT_ITEM_TYPES = [
	"video",
	"audio",
	"image",
	"game",
	"software",
	"physical",
	"service",
] as const;

const MONEY = /^\d+(\.\d{1,2})?$/;

const anthersAccessRowSchema = z.object({
	tier: z.enum(["free", "root", "sprout", "petal", "blossom"]),
	allow: z.boolean(),
	price: z.string().regex(MONEY),
});

const seedAccessRowSchema = z.object({
	threshold: z.number().nonnegative(),
	allow: z.boolean(),
	price: z.string().regex(MONEY),
});

// A post's ordered content list is an array of entries: an inline text block, or a
// reference to a library content item. Each may carry an `id` for reconcile-by-id on patch.
const postEntrySchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("text"),
		id: z.number().int().optional(),
		bodyHtml: z.string().optional().default(""),
	}),
	z.object({
		kind: z.literal("content"),
		id: z.number().int().optional(),
		contentItemId: z.number().int(),
		caption: z.string().max(1000).optional().default(""),
	}),
]);

// ── Content library items ──
const createContentItemSchema = z.object({
	type: z.enum(CONTENT_ITEM_TYPES),
	title: z.string().max(255).optional().default(""),
	description: z.string().max(50000).optional().default(""),
	thumbnail: z.string().max(500).optional().default(""),
	sourceKey: z.string().max(500).optional().default(""),
	embedUrl: z.string().max(500).optional().default(""),
	durationSeconds: z.number().int().optional(),
	metadata: z.record(z.unknown()).optional().default({}),
});

const updateContentItemSchema = z.object({
	title: z.string().max(255).optional(),
	description: z.string().max(50000).optional(),
	thumbnail: z.string().max(500).optional(),
	sourceKey: z.string().max(500).optional(),
	embedUrl: z.string().max(500).optional(),
	durationSeconds: z.number().int().optional(),
	metadata: z.record(z.unknown()).optional(),
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
	seedAccess: z.array(seedAccessRowSchema).optional(),

	// The post's ordered content list: text blocks and/or references to library items.
	contents: z.array(postEntrySchema).optional().default([]),

	// Presentation
	showOnTimeline: z.boolean().optional().default(true),
	isPinned: z.boolean().optional().default(false),

	// Metadata
	tags: z.array(z.string()).optional().default([]),
	websiteUrl: z.string().max(500).optional().default(""),
	sourceUrl: z.string().max(500).optional().default(""),
	isPublished: z.boolean().optional().default(false),
	// ISO datetime at which a still-unpublished draft should auto-publish; null clears the
	// schedule. Publishing now (isPublished=true) supersedes and clears any schedule.
	scheduledFor: z.string().datetime().nullable().optional(),

	// Optionally attach to a project (collection) on create.
	projectId: z.number().int().optional(),
});

const createPostSchema = postBaseSchema.refine((d) => d.streamEnabled || d.downloadEnabled, {
	message: "A post must enable at least one access type (stream or download)",
	path: ["streamEnabled"],
});

const updatePostSchema = postBaseSchema.partial();

/** Query flags for DELETE /posts/:slug — purgeMedia opts into removing orphaned library media. */
const deletePostQuerySchema = z.object({ purgeMedia: z.enum(["true", "1"]).optional() });

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

// ─── Content library items ────────────────────────────────────────────────────

type ContentItemRow = typeof contentItems.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type TranscodingJobRow = typeof transcodingJobs.$inferSelect;
type PostEntryInput = z.infer<typeof postEntrySchema>;

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
 * → normalize. Fired on library upload (POST /content-items) and when the source changes
 * (PATCH), NEVER on post save — processing is a library concern, not a post concern.
 *
 * Returns the queued job (null when the item needs no processing) so the caller can
 * serialize it into the response. The create response previously reported
 * `transcoding: null` for an item whose job had just been queued — which read as "no
 * processing" to the client, hiding the status badge AND leaving the library's
 * poll-while-processing loop switched off, so a freshly uploaded item sat unlabelled
 * until a manual refresh.
 */
async function queueTranscodeForItem(item: ContentItemRow): Promise<TranscodingJobRow | null> {
	if (item.type === "video" && item.sourceKey) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ contentItemId: item.id, mediaType: "video", status: "pending" })
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
			.values({ contentItemId: item.id, mediaType: "audio", status: "pending" })
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
async function resolveItemThumbnail(item: ContentItemRow): Promise<void> {
	if (
		item.thumbnail &&
		!/^(https?:)?\/\//.test(item.thumbnail) &&
		!item.thumbnail.startsWith("/")
	) {
		item.thumbnail = await storage.getUrl(item.thumbnail);
	}
}

/** Serialize a library content item (owner-facing: full media keys + latest transcode). */
function serializeItem(
	item: ContentItemRow,
	itemAssets: AssetRow[] = [],
	job: TranscodingJobRow | null = null,
) {
	return {
		id: item.id,
		creatorId: item.creatorId,
		type: item.type,
		title: item.title,
		description: item.description,
		thumbnail: item.thumbnail,
		sourceKey: item.sourceKey,
		embedUrl: item.embedUrl,
		durationSeconds: item.durationSeconds,
		metadata: stripInternalMetadata(item.metadata),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		assets: itemAssets,
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
async function purgeItemMedia(
	item: ContentItemRow,
	itemAssets: AssetRow[],
	jobRows: TranscodingJobRow[],
): Promise<void> {
	const keys = new Set<string>();
	const prefixes = new Set<string>();

	if (item.sourceKey) keys.add(urlToKey(item.sourceKey));
	if (item.thumbnail) keys.add(urlToKey(item.thumbnail));
	for (const a of itemAssets) if (a.file) keys.add(urlToKey(a.file));
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
			console.error(`[content-item delete] deletePrefix failed for ${prefix}:`, err);
		}
	}
	for (const key of keys) {
		if (!key) continue;
		try {
			await storage.delete(key);
		} catch (err) {
			console.error(`[content-item delete] delete failed for ${key}:`, err);
		}
	}
}

// ─── Publish / edit / delete helpers ────────────────────────────────────────────

/** Distinct content-item IDs referenced by a set of validated post entries. */
function entryItemIds(entries: PostEntryInput[]): number[] {
	return [
		...new Set(
			entries
				.filter(
					(e): e is Extract<PostEntryInput, { kind: "content" }> =>
						e.kind === "content" && e.contentItemId != null,
				)
				.map((e) => e.contentItemId),
		),
	];
}

/**
 * The publish-readiness gate: given referenced content-item IDs, return the ones whose
 * latest transcoding job hasn't reached "completed" (still pending/processing, or failed).
 * Items with no transcoding job (images, games, software) are always ready and never
 * appear here. Publish is blocked while this is non-empty; save/draft is not.
 */
async function unreadyItems(itemIds: number[]): Promise<Array<{ itemId: number; status: string }>> {
	if (itemIds.length === 0) return [];
	const jobs = await db
		.select({
			itemId: transcodingJobs.contentItemId,
			status: transcodingJobs.status,
			createdAt: transcodingJobs.createdAt,
		})
		.from(transcodingJobs)
		.where(inArray(transcodingJobs.contentItemId, itemIds))
		.orderBy(desc(transcodingJobs.createdAt));
	const latest = new Map<number, string>();
	for (const j of jobs) if (!latest.has(j.itemId)) latest.set(j.itemId, j.status);
	const unready: Array<{ itemId: number; status: string }> = [];
	for (const [itemId, status] of latest)
		if (status !== "completed") unready.push({ itemId, status });
	return unready;
}

/**
 * Which content-bearing fields a PATCH actually changed, as human labels — this drives a
 * post's edit history. Publish/unpublish and schedule changes are actions, not content
 * edits, so they're deliberately excluded and never produce a history entry.
 */
function changedPostFields(
	existing: typeof posts.$inferSelect,
	data: z.infer<typeof updatePostSchema>,
	contentsChanged: boolean,
): string[] {
	const changed: string[] = [];
	if (data.title !== undefined && data.title !== (existing.title ?? "")) changed.push("title");
	if (data.slug !== undefined && data.slug !== existing.slug) changed.push("slug");
	const bodyChanged =
		(data.body !== undefined && data.body !== (existing.body ?? "")) ||
		(data.bodyHtml !== undefined && sanitizePostHtml(data.bodyHtml) !== (existing.bodyHtml ?? ""));
	if (bodyChanged) changed.push("body");
	if (contentsChanged) changed.push("content");
	if (
		(data.streamEnabled !== undefined && data.streamEnabled !== existing.streamEnabled) ||
		(data.downloadEnabled !== undefined && data.downloadEnabled !== existing.downloadEnabled)
	)
		changed.push("delivery");
	if (
		(data.anthersAccess !== undefined &&
			JSON.stringify(data.anthersAccess) !== JSON.stringify(existing.anthersAccess ?? [])) ||
		(data.seedAccess !== undefined &&
			JSON.stringify(data.seedAccess) !== JSON.stringify(existing.seedAccess ?? []))
	)
		changed.push("access");
	if (data.showOnTimeline !== undefined && data.showOnTimeline !== existing.showOnTimeline)
		changed.push("timeline visibility");
	if (data.isPinned !== undefined && data.isPinned !== existing.isPinned) changed.push("pin");
	if (data.tags !== undefined && JSON.stringify(data.tags) !== JSON.stringify(existing.tags ?? []))
		changed.push("tags");
	if (data.websiteUrl !== undefined && data.websiteUrl !== (existing.websiteUrl ?? ""))
		changed.push("website link");
	if (data.sourceUrl !== undefined && data.sourceUrl !== (existing.sourceUrl ?? ""))
		changed.push("source link");
	return changed;
}

/** A stable signature of a post's ordered entries, for cheap change detection. */
function entriesSignature(
	entries: {
		kind: string;
		contentItemId?: number | null;
		bodyHtml?: string | null;
		caption?: string | null;
	}[],
): string {
	return entries
		.map((e) =>
			e.kind === "content" ? `c:${e.contentItemId}:${e.caption ?? ""}` : `t:${e.bodyHtml ?? ""}`,
		)
		.join("|");
}

/**
 * Content-item IDs referenced by this post and by no other post — i.e. those left orphaned
 * if the post is deleted. Storage/media live on the item, so purging them is opt-in.
 */
async function orphanedItemIds(postId: number): Promise<number[]> {
	const mine = await db
		.select({ itemId: postContents.contentItemId })
		.from(postContents)
		.where(and(eq(postContents.postId, postId), eq(postContents.kind, "content")));
	const ids = [...new Set(mine.map((r) => r.itemId).filter((x): x is number => x != null))];
	if (ids.length === 0) return [];
	const others = await db
		.select({ itemId: postContents.contentItemId })
		.from(postContents)
		.where(and(inArray(postContents.contentItemId, ids), ne(postContents.postId, postId)));
	const stillUsed = new Set(others.map((r) => r.itemId));
	return ids.filter((id) => !stillUsed.has(id));
}

// ─── Post entry persistence ─────────────────────────────────────────────────────

/** Map a validated post entry to its post_contents column values. */
function entryValues(entry: PostEntryInput, postId: number, position: number) {
	if (entry.kind === "text") {
		return {
			postId,
			position,
			kind: "text",
			bodyHtml: entry.bodyHtml ? sanitizePostHtml(entry.bodyHtml) : "",
			contentItemId: null,
			caption: "",
		};
	}
	return {
		postId,
		position,
		kind: "content",
		bodyHtml: "",
		contentItemId: entry.contentItemId,
		caption: entry.caption ?? "",
	};
}

/**
 * Load the caller-owned content items referenced by a set of entries. `ok` is false when
 * any `content` entry points at an item the caller doesn't own (or that doesn't exist) —
 * the create/patch handlers turn that into a 400.
 */
async function loadOwnedItemsForEntries(
	entries: PostEntryInput[],
	creatorId: number,
): Promise<{ ok: boolean; itemsById: Map<number, ContentItemRow> }> {
	const ids = [
		...new Set(
			entries
				.filter((e): e is Extract<PostEntryInput, { kind: "content" }> => e.kind === "content")
				.map((e) => e.contentItemId),
		),
	];
	if (ids.length === 0) return { ok: true, itemsById: new Map() };
	const rows = await db
		.select()
		.from(contentItems)
		.where(and(inArray(contentItems.id, ids), eq(contentItems.creatorId, creatorId)));
	const itemsById = new Map(rows.map((r) => [r.id, r]));
	return { ok: ids.every((id) => itemsById.has(id)), itemsById };
}

/** Insert a fresh ordered set of post entries (create path). No transcode queueing. */
async function insertPostEntries(postId: number, entries: PostEntryInput[]): Promise<void> {
	for (let i = 0; i < entries.length; i++) {
		await db.insert(postContents).values(entryValues(entries[i], postId, i));
	}
}

/**
 * Reconcile a post's entries against a submitted array (update path): keep+update entries
 * referenced by id, insert new ones, and delete those dropped — preserving order via
 * `position`. Processing is a library concern, so nothing is queued here.
 */
async function reconcilePostEntries(postId: number, entries: PostEntryInput[]): Promise<void> {
	const existing = await db.select().from(postContents).where(eq(postContents.postId, postId));
	const existingById = new Map(existing.map((e) => [e.id, e]));
	const keep = new Set<number>();

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const prev = entry.id != null ? existingById.get(entry.id) : undefined;
		if (prev) {
			keep.add(prev.id);
			await db
				.update(postContents)
				.set({ ...entryValues(entry, postId, i), updatedAt: new Date() })
				.where(eq(postContents.id, prev.id));
		} else {
			await db.insert(postContents).values(entryValues(entry, postId, i));
		}
	}

	const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
	if (toDelete.length > 0) {
		await db.delete(postContents).where(inArray(postContents.id, toDelete));
	}
}

/**
 * Where a post's media should be delivered from. When set, a completed transcode's
 * stored URL is rewritten to the matching access-checked endpoint — signed HLS for
 * video, a signed redirect for audio — instead of a raw CDN URL. Stored media is
 * private, so the raw URL 403s; the endpoints are how an entitled viewer actually
 * plays it. Null in local dev, where /content serves everything unsigned.
 */
interface DeliveryCtx {
	slug: string;
	origin: string;
}

/** URL of the access-checked HLS master for a video item referenced by a post. */
function buildHlsManifestUrl(
	ctx: DeliveryCtx,
	contentItemId: number,
	file = "master.m3u8",
): string {
	return `${ctx.origin}/api/content/posts/${encodeURIComponent(ctx.slug)}/hls/${contentItemId}/${file}`;
}

/** URL of the access-checked audio endpoint for an audio item referenced by a post. */
function buildAudioUrl(ctx: DeliveryCtx, contentItemId: number): string {
	return `${ctx.origin}/api/content/posts/${encodeURIComponent(ctx.slug)}/audio/${contentItemId}`;
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
		return { ...job, hlsManifestUrl: buildHlsManifestUrl(delivery, job.contentItemId) };
	}
	if (job.mediaType === "audio" && job.outputFileUrl) {
		return { ...job, outputFileUrl: buildAudioUrl(delivery, job.contentItemId) };
	}
	return job;
}

/** Parse a `:contentId` path param, rejecting anything that isn't a positive integer. */
function parseContentId(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** Serialize one post entry for a response, blanking the referenced item's media when gated. */
function serializeEntry(
	entry: typeof postContents.$inferSelect,
	item: ContentItemRow | null,
	itemAssets: AssetRow[],
	job: TranscodingJobRow | null,
	canAccess: boolean,
	delivery: DeliveryCtx | null,
) {
	if (entry.kind === "text") {
		return {
			kind: "text" as const,
			id: entry.id,
			postId: entry.postId,
			position: entry.position,
			// Inline prose is part of the post's gated deliverable — blanked when locked.
			bodyHtml: canAccess ? entry.bodyHtml : "",
		};
	}

	// Media URLs are the deliverable: rewritten to the access-checked delivery routes for
	// a viewer with access, and withheld entirely from one without. Library content is
	// processed before it is attached to any post, so access isn't knowable at upload
	// time — every accessible post, free or gated, routes through the signing endpoints
	// in S3 mode; local dev serves the stored URLs directly (no ACLs).
	const transcoding = viewerTranscoding(job, canAccess, delivery);

	const contentItem = item
		? {
				id: item.id,
				type: item.type,
				title: item.title,
				thumbnail: item.thumbnail,
				durationSeconds: item.durationSeconds,
				// `clientVariants` are an internal packaging detail (storage keys) — never expose.
				metadata: stripInternalMetadata(item.metadata),
				// Media payload is the deliverable — only handed out when the viewer has access.
				sourceKey: canAccess ? item.sourceKey : "",
				embedUrl: canAccess ? item.embedUrl : "",
				// Download keys are only handed out through the access-checked download route.
				assets: itemAssets.map((a) => ({ ...a, file: canAccess ? a.file : "" })),
				transcoding,
			}
		: null;

	return {
		kind: "content" as const,
		id: entry.id,
		postId: entry.postId,
		position: entry.position,
		caption: entry.caption,
		contentItem,
	};
}

/** Load a post's entries, resolving each content ref to its item + assets + latest job, gated. */
async function loadPostContents(
	postId: number,
	canAccess: boolean,
	delivery: DeliveryCtx | null = null,
) {
	const entries = await db
		.select()
		.from(postContents)
		.where(eq(postContents.postId, postId))
		.orderBy(asc(postContents.position));
	if (entries.length === 0) return [];

	const itemIds = [
		...new Set(
			entries
				.filter((e) => e.kind === "content" && e.contentItemId != null)
				.map((e) => e.contentItemId as number),
		),
	];

	const itemsById = new Map<number, ContentItemRow>();
	const assetsByItem = new Map<number, AssetRow[]>();
	const jobByItem = new Map<number, TranscodingJobRow>();

	if (itemIds.length > 0) {
		const [itemRows, assetRows, jobRows] = await Promise.all([
			db.select().from(contentItems).where(inArray(contentItems.id, itemIds)),
			db.select().from(assets).where(inArray(assets.contentItemId, itemIds)),
			db
				.select()
				.from(transcodingJobs)
				.where(inArray(transcodingJobs.contentItemId, itemIds))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		await Promise.all(itemRows.map(resolveItemThumbnail));
		for (const item of itemRows) itemsById.set(item.id, item);
		for (const a of assetRows) {
			const list = assetsByItem.get(a.contentItemId) ?? [];
			list.push(a);
			assetsByItem.set(a.contentItemId, list);
		}
		for (const j of jobRows) {
			if (!jobByItem.has(j.contentItemId)) jobByItem.set(j.contentItemId, j);
		}
	}

	return entries.map((entry) => {
		const item = entry.contentItemId != null ? (itemsById.get(entry.contentItemId) ?? null) : null;
		return serializeEntry(
			entry,
			item,
			item ? (assetsByItem.get(item.id) ?? []) : [],
			item ? (jobByItem.get(item.id) ?? null) : null,
			canAccess,
			delivery,
		);
	});
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
 * Decide where a post's media should be delivered from. In S3 mode ALL video and audio
 * goes through the access-checked endpoints, because access is enforced live at request
 * time — which is the only way it *can* work: media is processed in the library before
 * it is attached to any post, so there is no access table to consult at upload time, and
 * a post's access can change after the transcode besides. That is also why the stored
 * objects are uniformly private and this layer signs per request, rather than the jobs
 * trying to bake an ACL. Local dev serves media directly (the /content route serves
 * everything, unsigned).
 */
function deliveryCtxFor(post: typeof posts.$inferSelect): DeliveryCtx | null {
	if (isLocalStorage) return null;
	return { slug: post.slug, origin: publicOrigin() };
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
	opts: { isMaster: boolean; prefixKey: string; ctx: DeliveryCtx; contentItemId: number },
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
			out.push(buildHlsManifestUrl(opts.ctx, opts.contentItemId, encodeURIComponent(line)));
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

		// Latest transcoding status per post (across the items its content entries reference).
		const transcodingMap = new Map<number, { status: string; progress: number }>();
		if (postIds.length > 0) {
			const jobs = await db
				.select({
					postId: postContents.postId,
					status: transcodingJobs.status,
					progress: transcodingJobs.progress,
				})
				.from(transcodingJobs)
				.innerJoin(postContents, eq(transcodingJobs.contentItemId, postContents.contentItemId))
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
					scheduledFor: p.scheduledFor,
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

		// Every content ref must point at a library item the caller owns (a ref inherently
		// points at an already-uploaded item, so there are no "empty media slots").
		const { ok, itemsById } = await loadOwnedItemsForEntries(data.contents, user.id);
		if (!ok) {
			return c.json({ error: "A referenced content item was not found in your library." }, 400);
		}

		// Publish is gated on media readiness: a post can't go live while a referenced item is
		// still transcoding (it would render with no playable media). Draft/save stays free.
		if (data.isPublished) {
			const unready = await unreadyItems(entryItemIds(data.contents));
			if (unready.length > 0) {
				return c.json(
					{
						error: "Can't publish yet — referenced media is still processing.",
						code: "media_not_ready",
						unready,
					},
					409,
				);
			}
		}

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
		const contentType = deriveContentType(data.contents, itemsById);
		const thumbnail = deriveThumbnail(data.contents, itemsById);

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
				seedAccess: data.seedAccess ?? defaultSeedAccess(),
				showOnTimeline: data.showOnTimeline,
				isPinned: data.isPinned,
				tags: data.tags,
				websiteUrl: data.websiteUrl,
				sourceUrl: data.sourceUrl,
				estimatedReadMinutes,
				isPublished: data.isPublished,
				// Publishing now clears any schedule; otherwise store the requested publish time.
				scheduledFor: data.isPublished
					? null
					: data.scheduledFor
						? new Date(data.scheduledFor)
						: null,
			})
			.returning();

		await insertPostEntries(post.id, data.contents);

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

		const contents = await loadPostContents(post.id, true, deliveryCtxFor(post));
		return c.json({ post: { ...post, contents } }, 201);
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
			.where(eq(ratings.postId, post.id));

		// Fire-and-forget view count.
		db.update(posts)
			.set({ viewCount: sql`${posts.viewCount} + 1` })
			.where(eq(posts.id, post.id))
			.execute();

		const ctx = await buildAccessContext(viewerId, { postIds: [post.id] });
		const access = resolveAccessSync(post as AccessiblePost, ctx);

		const contents = await loadPostContents(post.id, access.canAccess, deliveryCtxFor(post));

		// When the post is locked to this viewer, the WHOLE post locks: the body (like
		// the content elements) is gated content, not a teaser. Only the title, cover
		// thumbnail, and meta remain so the client can render a "locked post" preview.
		const gatedBody = access.canAccess ? {} : { bodyHtml: "", body: "" };

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
				...gatedBody,
				creator: { ...creator, hasStripe: creatorHasStripe },
				ratingAverage: agg.average ? Number(agg.average) : null,
				ratingCount: Number(agg.count),
				contents,
				access,
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

		// When entries are provided, every content ref must belong to the caller — validate
		// before any writes so a bad ref never partially applies.
		if (data.contents !== undefined) {
			const { ok } = await loadOwnedItemsForEntries(data.contents, user.id);
			if (!ok) {
				return c.json({ error: "A referenced content item was not found in your library." }, 400);
			}
		}

		// Capture whether this edit actually changes the content list (before reconcile) so the
		// edit-history entry below only records real content changes, not no-op re-saves.
		let contentsChanged = false;
		if (data.contents !== undefined) {
			const before = await db
				.select({
					kind: postContents.kind,
					contentItemId: postContents.contentItemId,
					bodyHtml: postContents.bodyHtml,
					caption: postContents.caption,
				})
				.from(postContents)
				.where(eq(postContents.postId, existing.id))
				.orderBy(asc(postContents.position));
			contentsChanged = entriesSignature(before) !== entriesSignature(data.contents);
		}

		// Publish-readiness gate: block going (or staying) published while a referenced item is
		// still transcoding. Save/draft and scheduling stay free.
		const willPublish = data.isPublished ?? existing.isPublished;
		if (willPublish) {
			const intendedItemIds =
				data.contents !== undefined
					? entryItemIds(data.contents)
					: (
							await db
								.select({ itemId: postContents.contentItemId })
								.from(postContents)
								.where(and(eq(postContents.postId, existing.id), eq(postContents.kind, "content")))
						)
							.map((r) => r.itemId)
							.filter((x): x is number => x != null);
			const unready = await unreadyItems(intendedItemIds);
			if (unready.length > 0) {
				return c.json(
					{
						error: "Can't publish yet — referenced media is still processing.",
						code: "media_not_ready",
						unready,
					},
					409,
				);
			}
		}

		if (data.slug && data.slug !== existing.slug) {
			if (await postSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		// Reconcile content entries first (if provided), then derive post-level fields.
		if (data.contents !== undefined) {
			await reconcilePostEntries(existing.id, data.contents);
		}
		const currentEntries = await db
			.select({ kind: postContents.kind, contentItemId: postContents.contentItemId })
			.from(postContents)
			.where(eq(postContents.postId, existing.id))
			.orderBy(asc(postContents.position));
		// Denormalized type/thumbnail derive from the first content ref's item.
		const currentItemIds = [
			...new Set(
				currentEntries
					.filter((e) => e.kind === "content" && e.contentItemId != null)
					.map((e) => e.contentItemId as number),
			),
		];
		const currentItems = currentItemIds.length
			? await db
					.select({
						id: contentItems.id,
						type: contentItems.type,
						thumbnail: contentItems.thumbnail,
					})
					.from(contentItems)
					.where(inArray(contentItems.id, currentItemIds))
			: [];
		const currentItemsById = new Map(currentItems.map((i) => [i.id, i]));

		const updates: Record<string, unknown> = { updatedAt: new Date() };
		if (data.slug !== undefined) updates.slug = data.slug;
		if (data.title !== undefined) updates.title = data.title;
		if (data.body !== undefined) updates.body = data.body;
		if (data.bodyHtml !== undefined) updates.bodyHtml = sanitizePostHtml(data.bodyHtml);
		if (data.streamEnabled !== undefined) updates.streamEnabled = data.streamEnabled;
		if (data.downloadEnabled !== undefined) updates.downloadEnabled = data.downloadEnabled;
		if (data.anthersAccess !== undefined) updates.anthersAccess = data.anthersAccess;
		if (data.seedAccess !== undefined) updates.seedAccess = data.seedAccess;
		if (data.showOnTimeline !== undefined) updates.showOnTimeline = data.showOnTimeline;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.tags !== undefined) updates.tags = data.tags;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.sourceUrl !== undefined) updates.sourceUrl = data.sourceUrl;
		if (data.isPublished !== undefined) updates.isPublished = data.isPublished;
		if (data.scheduledFor !== undefined)
			updates.scheduledFor = data.scheduledFor ? new Date(data.scheduledFor) : null;
		// Publishing now supersedes and clears any pending schedule.
		if (data.isPublished === true) updates.scheduledFor = null;

		// Keep the denormalized type/thumbnail + read time in sync.
		updates.contentType = deriveContentType(currentEntries, currentItemsById);
		updates.thumbnail = deriveThumbnail(currentEntries, currentItemsById);
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

		// Record a timestamped edit-history entry when the post's content actually changed
		// (publish/unpublish/schedule toggles don't count — see changedPostFields).
		const editedFields = changedPostFields(existing, data, contentsChanged);
		if (editedFields.length > 0) {
			await db.insert(postEdits).values({
				postId: existing.id,
				summary: editedFields.join(", "),
				changedFields: editedFields,
			});
		}

		const contents = await loadPostContents(updated.id, true, deliveryCtxFor(updated));
		return c.json({ post: { ...updated, contents } });
	})

	// Preview which library items would be orphaned by deleting this post — powers the
	// "also remove now-unused media?" prompt on the delete confirmation. Owner-only.
	.get("/posts/:slug/orphaned-media", requireAuth, async (c) => {
		const user = c.get("user");
		const existing = await findPostRow(c.req.param("slug"));
		if (!existing || existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);
		const ids = await orphanedItemIds(existing.id);
		if (ids.length === 0) return c.json({ items: [] });
		const items = await db
			.select({
				id: contentItems.id,
				title: contentItems.title,
				type: contentItems.type,
				thumbnail: contentItems.thumbnail,
			})
			.from(contentItems)
			.where(inArray(contentItems.id, ids));
		return c.json({ items });
	})

	.delete("/posts/:slug", requireAuth, zValidator("query", deletePostQuerySchema), async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();
		const { purgeMedia } = c.req.valid("query");
		const existing = await findPostRow(slug);
		if (!existing || existing.creatorId !== user.id) return c.json({ error: "Not found" }, 404);

		// Optionally purge library media left orphaned by this delete (opt-in via ?purgeMedia=1).
		// Media lives on reusable content items, not the post, so purging is deliberately explicit.
		// Compute orphans BEFORE deleting the post (the query reads its post_contents rows).
		const purge = purgeMedia === "true" || purgeMedia === "1";
		const orphanIds = purge ? await orphanedItemIds(existing.id) : [];

		await db.delete(posts).where(eq(posts.id, existing.id));

		if (orphanIds.length > 0) {
			const [orphanRows, orphanAssets, orphanJobs] = await Promise.all([
				db.select().from(contentItems).where(inArray(contentItems.id, orphanIds)),
				db.select().from(assets).where(inArray(assets.contentItemId, orphanIds)),
				db.select().from(transcodingJobs).where(inArray(transcodingJobs.contentItemId, orphanIds)),
			]);
			for (const item of orphanRows) {
				await purgeItemMedia(
					item,
					orphanAssets.filter((a) => a.contentItemId === item.id),
					orphanJobs.filter((j) => j.contentItemId === item.id),
				);
			}
			await db.delete(contentItems).where(inArray(contentItems.id, orphanIds));
		}
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

	// ── Access-checked asset download ─────────────────────────────────────────────
	// Assets belong to content items; a post can deliver an item's asset only while it
	// references that item. Access is enforced at the post level (the access point).
	.post("/posts/:slug/assets/:id/download", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		// Resolve the asset via its content item, and confirm the item is referenced by
		// this post (a post_contents row with that contentItemId).
		const [row] = await db
			.select({ asset: assets })
			.from(assets)
			.innerJoin(postContents, eq(postContents.contentItemId, assets.contentItemId))
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

	// ── Transcoding status (across the items the post's content entries reference) ──
	.get("/posts/:slug/transcoding", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		const jobs = await db
			.select({ job: transcodingJobs })
			.from(transcodingJobs)
			.innerJoin(postContents, eq(transcodingJobs.contentItemId, postContents.contentItemId))
			.where(eq(postContents.postId, post.id))
			.orderBy(desc(transcodingJobs.createdAt));

		// Serialized exactly as post detail does — same helper, same rule. That matters:
		// this route is a second way to reach the same rows, so anything post detail
		// withholds has to be withheld here too or the poller becomes the side channel
		// around it. Status still flows to a denied viewer; only the payload URLs don't.
		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [post.id] });
		const canAccess = resolveAccessSync(post as AccessiblePost, ctx).canAccess;
		const delivery = deliveryCtxFor(post);
		return c.json({ jobs: jobs.map(({ job }) => viewerTranscoding(job, canAccess, delivery)) });
	})

	// ── Audio delivery (access-checked, signed) ──────────────────────────────────
	// The audio counterpart of the HLS endpoint below. Processed audio is stored private,
	// so this is the only way to reach it: access is re-checked here on every request,
	// then we redirect to a short-lived signed CDN URL. A redirect rather than a proxy so
	// range requests (seeking) go straight to the CDN instead of through the API.
	.get("/posts/:slug/audio/:contentId", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);

		const viewerId = await getOptionalUserId(c);
		const ctx = await buildAccessContext(viewerId, { postIds: [post.id] });
		const access = resolveAccessSync(post as AccessiblePost, ctx);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const contentItemId = parseContentId(c.req.param("contentId"));
		if (contentItemId == null) return c.json({ error: "Not found" }, 404);

		// Confirm the item is referenced by this post before serving its audio — otherwise
		// any post the viewer can reach would unlock every item on the platform.
		const [ref] = await db
			.select({ id: postContents.id })
			.from(postContents)
			.where(and(eq(postContents.contentItemId, contentItemId), eq(postContents.postId, post.id)))
			.limit(1);
		if (!ref) return c.json({ error: "Not found" }, 404);

		const [job] = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.contentItemId, contentItemId))
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
	// Serves the master + variant playlists for a video, rewriting segment refs to
	// short-lived signed CDN URLs. `:contentId` is a content-item id referenced by the
	// post. Library segments are always private, so EVERY accessible post (free or gated)
	// is pointed here by serializeEntry; the access check below is the gate.
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

		const contentItemId = parseContentId(c.req.param("contentId"));
		if (contentItemId == null) return c.json({ error: "Not found" }, 404);
		// Confirm the item is referenced by this post before serving its transcode.
		const [ref] = await db
			.select({ id: postContents.id })
			.from(postContents)
			.where(and(eq(postContents.contentItemId, contentItemId), eq(postContents.postId, post.id)))
			.limit(1);
		if (!ref) return c.json({ error: "Not found" }, 404);

		const [job] = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.contentItemId, contentItemId))
			.orderBy(desc(transcodingJobs.createdAt))
			.limit(1);
		const manifestUrl = job?.hlsManifestUrl;
		if (!manifestUrl) return c.json({ error: "Not found" }, 404);

		// Storage key prefix = the directory of the master.m3u8 key. Playlists are stored
		// private alongside their segments, so fetch this one signed — a bare URL 403s.
		const masterKey = decodeURIComponent(new URL(manifestUrl).pathname.replace(/^\/+/, ""));
		const prefixKey = masterKey.replace(/\/[^/]+$/, "");

		const res = await fetch(
			await storage.getUrl(`${prefixKey}/${file}`, { signed: true, expiresIn: 300 }),
		);
		if (!res.ok) return c.json({ error: "Not found" }, 404);

		const rewritten = await rewriteHlsPlaylist(await res.text(), {
			isMaster: file === "master.m3u8",
			prefixKey,
			ctx: { slug: post.slug, origin: publicOrigin() },
			contentItemId,
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
	.post("/content-items", requireAuth, zValidator("json", createContentItemSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		const [item] = await db
			.insert(contentItems)
			.values({
				creatorId: user.id,
				type: data.type,
				title: data.title,
				description: data.description,
				thumbnail: data.thumbnail,
				sourceKey: data.sourceKey,
				embedUrl: data.embedUrl,
				durationSeconds: data.durationSeconds ?? null,
				metadata: data.metadata ?? {},
			})
			.returning();

		const job = await queueTranscodeForItem(item);
		await resolveItemThumbnail(item);
		return c.json({ item: serializeItem(item, [], job) }, 201);
	})

	/** The caller's library, each item with its latest transcode + assets for the UI. */
	.get("/content-items", requireAuth, async (c) => {
		const user = c.get("user");

		const items = await db
			.select()
			.from(contentItems)
			.where(eq(contentItems.creatorId, user.id))
			.orderBy(desc(contentItems.createdAt));
		if (items.length === 0) return c.json({ items: [] });

		const ids = items.map((i) => i.id);
		const [assetRows, jobRows] = await Promise.all([
			db.select().from(assets).where(inArray(assets.contentItemId, ids)),
			db
				.select()
				.from(transcodingJobs)
				.where(inArray(transcodingJobs.contentItemId, ids))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		const assetsByItem = new Map<number, AssetRow[]>();
		for (const a of assetRows) {
			const list = assetsByItem.get(a.contentItemId) ?? [];
			list.push(a);
			assetsByItem.set(a.contentItemId, list);
		}
		const jobByItem = new Map<number, TranscodingJobRow>();
		for (const j of jobRows) {
			if (!jobByItem.has(j.contentItemId)) jobByItem.set(j.contentItemId, j);
		}

		await Promise.all(items.map(resolveItemThumbnail));
		return c.json({
			items: items.map((i) =>
				serializeItem(i, assetsByItem.get(i.id) ?? [], jobByItem.get(i.id) ?? null),
			),
		});
	})

	/** One library item (owner-only) with its assets + latest transcode. */
	.get("/content-items/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) {
			return c.json({ error: "Content item not found" }, 404);
		}

		const [itemAssets, jobRows] = await Promise.all([
			db.select().from(assets).where(eq(assets.contentItemId, id)),
			db
				.select()
				.from(transcodingJobs)
				.where(eq(transcodingJobs.contentItemId, id))
				.orderBy(desc(transcodingJobs.createdAt)),
		]);

		await resolveItemThumbnail(item);
		return c.json({ item: serializeItem(item, itemAssets, jobRows[0] ?? null) });
	})

	/** Update a library item (owner-only). Re-queues processing when the source changes. */
	.patch(
		"/content-items/:id",
		requireAuth,
		zValidator("json", updateContentItemSchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
			if (!item || item.creatorId !== user.id) {
				return c.json({ error: "Content item not found" }, 404);
			}

			const data = c.req.valid("json");
			const updates: Record<string, unknown> = { updatedAt: new Date() };
			if (data.title !== undefined) updates.title = data.title;
			if (data.description !== undefined) updates.description = data.description;
			if (data.thumbnail !== undefined) updates.thumbnail = data.thumbnail;
			if (data.embedUrl !== undefined) updates.embedUrl = data.embedUrl;
			if (data.durationSeconds !== undefined) updates.durationSeconds = data.durationSeconds;
			if (data.metadata !== undefined) updates.metadata = data.metadata;
			const sourceChanged = data.sourceKey !== undefined && data.sourceKey !== item.sourceKey;
			if (data.sourceKey !== undefined) updates.sourceKey = data.sourceKey;

			const [updated] = await db
				.update(contentItems)
				.set(updates)
				.where(eq(contentItems.id, id))
				.returning();

			// A new source means the old transcode is stale — re-process from the library.
			if (sourceChanged && updated.sourceKey) await queueTranscodeForItem(updated);

			const [itemAssets, jobRows] = await Promise.all([
				db.select().from(assets).where(eq(assets.contentItemId, id)),
				db
					.select()
					.from(transcodingJobs)
					.where(eq(transcodingJobs.contentItemId, id))
					.orderBy(desc(transcodingJobs.createdAt)),
			]);

			await resolveItemThumbnail(updated);
			return c.json({ item: serializeItem(updated, itemAssets, jobRows[0] ?? null) });
		},
	)

	/**
	 * Delete a library item (owner-only). Best-effort purges its stored media first, then
	 * deletes the row — cascade removes its assets, transcodes, and any post_contents refs.
	 */
	.delete("/content-items/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) {
			return c.json({ error: "Content item not found" }, 404);
		}

		const [itemAssets, jobRows] = await Promise.all([
			db.select().from(assets).where(eq(assets.contentItemId, id)),
			db.select().from(transcodingJobs).where(eq(transcodingJobs.contentItemId, id)),
		]);
		await purgeItemMedia(item, itemAssets, jobRows);

		await db.delete(contentItems).where(eq(contentItems.id, id));
		return c.body(null, 204);
	})

	// ── Content-item downloadable assets (builds/variants) ────────────────────────
	.post(
		"/content-items/:id/assets",
		requireAuth,
		zValidator("json", createAssetSchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [item] = await db
				.select({ id: contentItems.id })
				.from(contentItems)
				.where(and(eq(contentItems.id, id), eq(contentItems.creatorId, user.id)))
				.limit(1);
			if (!item) return c.json({ error: "Content item not found" }, 404);

			const data = c.req.valid("json");
			const [asset] = await db
				.insert(assets)
				.values({ contentItemId: id, ...data })
				.returning();
			return c.json({ asset }, 201);
		},
	)

	.delete("/content-items/:id/assets/:assetId", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db
			.select({ id: contentItems.id })
			.from(contentItems)
			.where(and(eq(contentItems.id, id), eq(contentItems.creatorId, user.id)))
			.limit(1);
		if (!item) return c.json({ error: "Not found" }, 404);

		const deleted = await db
			.delete(assets)
			.where(and(eq(assets.id, Number(c.req.param("assetId"))), eq(assets.contentItemId, id)))
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

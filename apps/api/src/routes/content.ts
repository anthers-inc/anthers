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
 * Projects that group Works and Posts via many-to-many joins.
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
	libraryItems,
	postEdits,
	posts,
	postWorkRefs,
	projectItems,
	projectPosts,
	projects,
	purchases,
	ratings,
	stripeAccounts,
	transcodingJobs,
	users,
	workPages,
	works,
} from "@anthers/db/schema";
import {
	COMMENT_MAX,
	type CommentSubjectType,
	REVIEW_MAX,
	REVIEW_MIN,
} from "@anthers/shared/content";
import {
	type MaturityRating,
	maturityLabel,
	normalizeContentNotes,
	RATING_APPEAL_STATEMENT_MAX,
	releaseRatingRefusal,
} from "@anthers/shared/content-rating";
import type { PublicAccessBudget } from "@anthers/shared/public-access";
import { zValidator } from "@hono/zod-validator";
import {
	and,
	asc,
	avg,
	count,
	countDistinct,
	desc,
	eq,
	inArray,
	like,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { embedCreator } from "../lib/handles.js";
import { getOptionalUserId, requireAuth } from "../middleware/auth.js";
import {
	type AccessContext,
	type AccessibleWork,
	buildAccessContext,
	buildPreviewContext,
	defaultSeedAccess,
	isOpenToEveryoneFree,
	resolveAccessSync,
} from "../services/access.js";
import { adultVisibility } from "../services/adult-access.js";
import { validateSession } from "../services/auth.js";
import { notBlockedBy } from "../services/blocks.js";
import { appealsForWork, declareRating, fileRatingAppeal } from "../services/content-rating.js";
import {
	permanentWorkIds,
	removeItem,
	saveProject,
	saveWork,
	setHidden,
} from "../services/library.js";
import { purgeWorkMedia, urlToKey } from "../services/media-purge.js";
import { loadPublicAccessBudget } from "../services/public-access.js";
import { markPurchaseDownloaded } from "../services/refunds.js";
import { beginScans, scanReleaseGate } from "../services/safety-scan.js";
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

/**
 * A subject's visible comments, newest first.
 *
 * One function for both subject types — the Post thread and the Work thread differ only in
 * which `(subject_type, subject_id)` pair is asked about, so they cannot drift apart in how
 * they filter. That matters here more than most places: `visibleComment` is the whole of
 * moderation at read time, and a second copy of this query is a second place to forget it.
 */
async function listComments(
	subjectType: CommentSubjectType,
	subjectId: number,
	viewerId: number | null = null,
) {
	// LEFT join, not inner. A **tombstoned** comment has a null author — its writer
	// deleted their account and the comment stayed so the conversation around it still
	// reads. An inner join would silently drop exactly those rows, which is the
	// tombstone promise failing in the one place it is supposed to hold: the thread.
	const rows = await db
		.select({ comment: comments, username: users.username, avatar: users.avatar })
		.from(comments)
		.leftJoin(users, eq(comments.userId, users.id))
		.where(
			and(
				eq(comments.subjectType, subjectType),
				eq(comments.subjectId, subjectId),
				visibleComment,
				// A blocked pair does not meet in a thread, in either direction. This is the
				// densest contact surface in the app, and it is one function precisely so
				// there is one place to apply it — the same argument `visibleComment` makes.
				notBlockedBy(viewerId, comments.userId),
			),
		)
		.orderBy(desc(comments.createdAt));
	return rows.map((r) => ({
		...r.comment,
		username: r.username,
		avatar: r.avatar,
		// 🚨 Says only WHO, never WHY. A moderation removal is `moderation_status` and
		// never reaches here at all; this flag means the author left. Conflating the two
		// would have us telling readers a user deleted something they didn't.
		deletedByAuthor: r.comment.userId === null,
	}));
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
	// A packaged multi-page document — a comic, a graphic novel, a prose book. The
	// creator uploads ONE file (a PDF); `rasterize-ebook` renders it to private per-page
	// images, because a single-file deliverable cannot be access-checked page by page.
	"ebook",
	"game",
	"software",
	"physical",
	"service",
] as const;

/** Work types whose media is processed asynchronously before the Work can be released. */
const PROCESSED_WORK_TYPES = new Set(["video", "audio", "ebook"]);

const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * One row shape for the Work's one access table: a monthly-dollar threshold, an allow
 * flag, and a price. The threshold is what the viewer has given this Work's creator
 * this cycle. (An Anthers table sat beside it, counting the viewer's own Badge, until
 * migration `0029` folded it in when Anthers Gates retired on 2026-08-12.)
 *
 * 🚨 **`z.number().int()` until 2026-08-16, and the justification inverted.** It read
 * *"a gate sits at a whole Seed or nowhere, and accepting 2.5 would let a row be written
 * that no viewer can ever exactly meet"* — true while Seeds were indivisible, and exactly
 * backwards once they retired: $2.50 is now an ordinary thing to give, so refusing it
 * writes off the amounts a creator is most likely to choose.
 *
 * Two cents of precision, because that is what can be charged and what `amountMeets`
 * compares in. Finer would be a threshold nobody could pay to the cent.
 */
const accessRowSchema = z.object({
	threshold: z
		.number()
		.nonnegative()
		.refine(
			(v) =>
				Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
			{
				message: "Threshold must be a whole number of cents",
			},
		),
	allow: z.boolean(),
	price: z.string().regex(MONEY),
});

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
		// type = "audio": the song's words, plain text and untimestamped. Bounded generously
		// — a long song with repeats runs to a few thousand characters, and an epic runs to
		// more. No sanitizer, because nothing here is ever rendered as HTML.
		lyrics: z.string().max(20_000).optional(),
		metadata: z.record(z.unknown()).optional().default({}),

		// Visibility. `released` is public listing, NOT public access — the gates decide that.
		visibility: z.enum(["private", "released"]).optional(),

		// The content rating. `unrated` is accepted from nobody: it is the state a Work is
		// born in and leaves, never a value a client sets, and release is refused while it
		// holds. `services/content-rating.ts` decides whether the change is allowed — an
		// operator's correction can only be raised, not lowered, by the creator.
		maturity: z.enum(["general", "mature", "adult"]).optional(),
		maturityNotes: z.array(z.string()).max(20).optional(),

		// Delivery (≥1 enforced on release)
		streamEnabled: z.boolean().optional(),
		downloadEnabled: z.boolean().optional(),

		// Access table (default "free but fully locked" applied server-side when omitted)
		seedAccess: z.array(seedAccessRowSchema).optional(),

		// Presentation & metadata
		isPinned: z.boolean().optional(),
		tags: z.array(z.string()).optional(),
		websiteUrl: z.string().max(500).optional(),
		sourceUrl: z.string().max(500).optional(),
	})
	.merge(authoredSchema);

/**
 * A creator's appeal against an operator's rating correction.
 *
 * The statement is required and has a floor, because an appeal is an argument: a queue of
 * empty appeals is a queue an operator learns to clear without reading, which costs the
 * creators with something to say.
 */
const ratingAppealSchema = z.object({
	requestedMaturity: z.enum(["general", "mature", "adult"]),
	statement: z.string().trim().min(10).max(RATING_APPEAL_STATEMENT_MAX),
});

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

	// Optionally attach to a Project on create.
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

const addWorkToProjectSchema = z.object({
	workId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

const addPostToProjectSchema = z.object({
	postId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

// ─── Content library items ────────────────────────────────────────────────────

/**
 * `projects.id`, QUALIFIED, for the correlated subquery below.
 *
 * ⚠️ **This is hardening, not a bug fix — the query was never wrong.** Drizzle renders an
 * interpolated `${table.id}` as bare `"id"` **only when the query has a single table in
 * its FROM**; the moment a join is present it qualifies, and this query joins `users`.
 * Verified with `toSQL()` in both shapes rather than assumed.
 *
 * It is written explicitly anyway because the correctness is currently a *side effect of
 * the join*: remove or restructure that join — denormalize the creator name, say — and the
 * identifier silently goes bare, binding project_posts.id, which exists. Postgres raises
 * nothing and every count becomes a plausible constant. That is exactly what happened in
 * `routes/accounts.ts`, whose listings had no join and read 0 for months (PR #223).
 */
const projectsId = sql`${sql.identifier("projects")}.${sql.identifier("id")}`;

type WorkRow = typeof works.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type TranscodingJobRow = typeof transcodingJobs.$inferSelect;

/**
 * Drop internal-only keys from metadata before it reaches a client.
 *
 * 🚨 **`clientVariants` is retired but this must keep stripping it.** It was the
 * client-transcode transport — a pre-encoded MP4 ladder the browser or desktop uploaded
 * for `package-video` to remux — removed on 2026-08-17 with the on-device encoders.
 * Nothing writes it any more, but it lives in the `metadata` jsonb of every Work uploaded
 * that way, and the values are **storage keys**. Deleting this strip because the producer
 * is gone would start leaking them from existing rows; the guard outlives the feature.
 */
function stripInternalMetadata(metadata: unknown): Record<string, unknown> {
	if (!metadata || typeof metadata !== "object") return {};
	const { clientVariants, ...rest } = metadata as Record<string, unknown>;
	void clientVariants;
	return rest;
}

/**
 * Queue processing for a library content item that has a source needing it. Video →
 * HLS transcode; audio → normalize. Fired on library upload (POST /works) and when the
 * source changes (PATCH), NEVER on post save — processing is a library concern, not a
 * post concern.
 *
 * There is one video path now. It used to branch on a browser-supplied variant ladder,
 * remuxing instead of encoding; that transport went with the on-device encoders on
 * 2026-08-17. When on-device returns as the desktop's pre-process pack, the branch it
 * needs is a decision to make then, against whatever the pack format turns out to be —
 * not this one revived.
 *
 * Returns the queued job (null when the item needs no processing) so the caller can
 * serialize it into the response. The create response previously reported
 * `transcoding: null` for an item whose job had just been queued — which read as "no
 * processing" to the client, hiding the status badge AND leaving the library's
 * poll-while-processing loop switched off, so a freshly uploaded item sat unlabelled
 * until a manual refresh.
 */
/**
 * Queue a detection scan for whatever of a Work's objects can be fingerprinted today.
 *
 * ⭐ **Enqueued at the same point as transcoding, deliberately** — the moment a source key
 * or asset key is first attached to a Work is when the object is known to exist and known
 * to belong to somebody, and having one trigger point rather than two is what keeps a new
 * upload route from acquiring transcoding while quietly skipping detection.
 *
 * ⚠️ **Only images are scanned in this pass, and a video's frames are not yet.** PDQ is an
 * image hash, so video coverage means extracting keyframes inside `transcode-video.ts`,
 * which already decodes every frame — the correct method and the correct place, but a
 * separate integration. **A video's thumbnail IS scanned here**, since it is an extracted
 * frame and therefore new image bytes. Audio has no coverage under a perceptual image hash
 * at all. The current coverage map stays in wiki 40.12 and off the public safety page.
 */
async function queueScanForWork(item: WorkRow): Promise<void> {
	// `beginScans` decides which objects are scannable and starts the Work's clock; this
	// only sends the jobs. The key set has to be the same one the release gate waits on, so
	// it lives in the service that owns both rather than being computed again here.
	const keys = await beginScans(item);
	for (const storageKey of keys) {
		await queue.send(
			QUEUES.SCAN_MEDIA,
			{ storageKey, workId: item.id },
			JOB_OPTIONS[QUEUES.SCAN_MEDIA],
		);
	}
}

async function queueTranscodeForWork(item: WorkRow): Promise<TranscodingJobRow | null> {
	if (item.type === "video" && item.sourceKey) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId: item.id, mediaType: "video", status: "pending" })
			.returning();
		await queue.send(
			QUEUES.TRANSCODE_VIDEO,
			{ jobId: job.id },
			JOB_OPTIONS[QUEUES.TRANSCODE_VIDEO],
		);
		return job;
	}
	if (item.type === "ebook" && item.sourceKey) {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId: item.id, mediaType: "ebook", status: "pending" })
			.returning();
		await queue.send(
			QUEUES.RASTERIZE_EBOOK,
			{ jobId: job.id },
			JOB_OPTIONS[QUEUES.RASTERIZE_EBOOK],
		);
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
		// Owner-facing, so ungated — this is the shape the Studio editor loads to edit.
		lyrics: item.lyrics,
		estimatedReadMinutes: item.estimatedReadMinutes,
		metadata: stripInternalMetadata(item.metadata),
		visibility: item.visibility,
		releasedAt: item.releasedAt,
		maturity: item.maturity,
		maturityNotes: item.maturityNotes ?? [],
		/** Whether an operator set the rating — what tells the creator an appeal is the route. */
		maturityLocked: item.maturitySource === "operator",
		authoredAt: item.authoredAt,
		authoredPrecision: item.authoredPrecision,
		streamEnabled: item.streamEnabled,
		downloadEnabled: item.downloadEnabled,
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
 *
 * 🚨 **Exported only so the round-trip invariant can be tested.** `storage.getUrl(key)` and
 * this function are inverses, and they live in different modules — a storage service and a
 * route file — so nothing in either one fails when they stop agreeing. What they agree on
 * is that the **pathname is the key**, which holds for virtual-hosted URLs and breaks for
 * path-style ones, where the bucket name is prepended. That is not hypothetical: R2's S3
 * API endpoint is path-style, and pointing `STORAGE_PUBLIC_BASE_URL` at it would corrupt
 * every URL written afterwards while leaving older rows working.
 * `__tests__/storage-url-roundtrip.test.ts` is the thing that notices.
 */
export { urlToKey };

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
 * A creator's **preview** request, if they made one.
 *
 * `?previewAs=out` for signed-out, `?previewAs=<amount>` for a viewer giving that much a
 * month, plus
 * `?previewOwned=1` for one who bought it outright. Absent or malformed → null, and the
 * viewer sees the truth, which is the only safe way for this to fail.
 */
/**
 * The preview parameters, declared for the RPC client.
 *
 * ⚠️ This exists to publish the *types*, not to parse: `previewRequest` below still reads
 * the raw query, because three routes accept a preview and only one of them can carry this
 * validator without changing its own signature. Everything is optional and unconstrained
 * here, so it can never reject a request — the real validation is `previewRequest`, which
 * fails back to "no preview" on anything it doesn't recognise.
 */
const previewQuerySchema = z.object({
	previewAs: z.string().optional(),
	previewOwned: z.string().optional(),
});

/** The Catalog's own filters, plus a preview. Same "publish the types" purpose. */
const catalogQuerySchema = previewQuerySchema.extend({
	sort: z.string().optional(),
	type: z.string().optional(),
});

function previewRequest(c: {
	req: { query: (k: string) => string | undefined };
}): { given: number | null; owned: boolean } | null {
	// 🚨 `?previewAs=` gives an EMPTY STRING, not undefined — and `Number("")` is **0**,
	// which passes every range check below. So the obvious `raw == null` guard alone reads
	// a blank parameter as "preview as a viewer giving nothing" and quietly locks a
	// creator out of their own page. Second time this exact trap has bitten; the first was
	// `Number(localStorage.getItem(...))` defaulting the remembered volume to silence.
	// Treat empty as absent, always.
	const raw = c.req.query("previewAs")?.trim();
	if (!raw) return null;
	if (raw === "out") return { given: null, owned: false };
	// ⚠️ NOT `Number.isInteger` any more. Amounts carry cents since the Seed retired as a
	// unit, so an integer check would silently refuse to preview any creator whose own
	// ladder sits at $2.50 — the exact case a preview exists to let them see.
	const given = Number(raw);
	if (!Number.isFinite(given) || given < 0 || given > 999) return null;
	return { given, owned: c.req.query("previewOwned") === "1" };
}

/**
 * The context to resolve one Work with — the real one, or the creator's preview.
 *
 * 🚨 **The ownership guard is here, per Work, and is the whole safety argument.** A
 * preview only ever subtracts access *because* it is only ever applied to a Work the
 * requester created, and a creator already sees everything of theirs. Guarding per Work
 * rather than per request means a Work that somehow isn't theirs — on a shared shelf, in
 * a future collab — silently resolves normally instead of resolving as somebody with a
 * different amount of access.
 */
function contextFor(
	work: { id: number; creatorId: number | null },
	viewerId: number | null,
	real: AccessContext,
	preview: { given: number | null; owned: boolean } | null,
): AccessContext {
	if (!preview || viewerId == null || work.creatorId !== viewerId) return real;
	return buildPreviewContext({
		creatorId: viewerId,
		given: preview.given,
		owned: preview.owned,
		workIds: [work.id],
	});
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
 * Whether this request may be served *bytes*, once access says yes.
 *
 * 🚨 **A second, account-level check that deliberately does NOT live in `resolveAccess`.**
 * A free account watches 10 hours of Public Access a month; the Public Access price
 * given to Anthers removes the limit. That is a property of the **account**, not of the Work — the
 * Work stays free to everyone either way — so encoding it as a Work-level denial is how
 * the commons quietly re-stratifies, which is exactly what retiring Anthers Gates was
 * for. `resolveAccessSync` also has to stay pure and synchronous so a Catalog page
 * resolves a batch without an N+1, and this needs a query.
 *
 * So it sits here, at the two endpoints that actually hand over media, and only for
 * Public Access work: a gated Work the viewer cleared, one they bought, and their own
 * catalogue are all `isFree: false` and never reach the meter.
 *
 * Returns null when delivery may proceed, or the 402 body when the allowance is spent.
 */
async function publicAccessGate(
	c: Parameters<typeof getOptionalUserId>[0],
	work: WorkRow,
	access: AccessResultLike,
): Promise<{ error: string; reason: string; budget: PublicAccessBudget } | null> {
	// Only the commons is metered. Anything reached by paying — a gate cleared, a
	// purchase — or a creator's own work is not Public Access and draws nothing.
	if (!(access.isFree && work.streamEnabled)) return null;

	const viewerId = await getOptionalUserId(c);
	const budget = await loadPublicAccessBudget(viewerId);
	if (budget.allowed) return null;

	return {
		error: "You have used this month's free Public Access hours",
		reason: "public_access_limit",
		budget,
	};
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
	/**
	 * Whether this viewer has spent their monthly Public Access allowance.
	 *
	 * 🚨 **Required, not optional, and that is the point.** Video and audio are metered at
	 * their own delivery endpoints, which a text Work and a browser game do not have —
	 * their deliverable rides inside this payload, so this function is the only choke
	 * point they pass through. An optional parameter would default to "not spent" and the
	 * fifth call site anyone adds would silently serve the commons for free forever, which
	 * is exactly the bug this exists to close.
	 */
	allowanceSpent: boolean,
	/**
	 * How many pages an ebook has, or 0.
	 *
	 * ⚠️ The COUNT is public even when the Work is locked, and the page *keys* never are.
	 * "48 pages" is the sort of thing a locked Work has to be able to say — it is the
	 * shape of the thing, like a video's duration, which this serializer has always sent
	 * regardless of access. What it must not leak is a pointer at any page.
	 */
	pageCount = 0,
) {
	const canAccess = access.canAccess;

	/**
	 * Whether this Work is the commons — see the `publicAccess` field below for why this
	 * is derived rather than stored. Computed up here because the deliverable depends on
	 * it: only Public Access work draws an allowance, so only Public Access work can be
	 * withheld by one running out.
	 */
	const publicAccess = access.isFree && work.streamEnabled && work.visibility === "released";

	/**
	 * Whether to hand over the thing itself.
	 *
	 * Two independent reasons to withhold, and they must not be conflated: **access**
	 * (this is gated and you have not cleared it) and **allowance** (it is free to you and
	 * always will be, but you have used your hours this month). The second never touches
	 * `access` below — the Work still reports itself free, because it *is* free. What ran
	 * out belongs to the account, and a Work that described itself as gated by someone
	 * else's meter would re-stratify the commons the retirement of Anthers Gates removed.
	 */
	const deliverable = canAccess && !(publicAccess && allowanceSpent);

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
		// A buyer of a withdrawn Work needs the date to know how long the rescue window
		// has left — it is the only warning they currently get, and it was reaching the
		// old Library through the purchases endpoint rather than through the Work.
		withdrawnAt: work.withdrawnAt,
		// The rating and its notes travel with the blurb rather than with the payload, and
		// have to: a warning that only appears once you already have the thing is not a
		// warning. `maturitySource` stays behind — who set the rating is between the
		// creator and an operator, and a viewer able to read it could tell a corrected Work
		// from a self-declared one.
		maturity: work.maturity,
		maturityNotes: work.maturityNotes ?? [],
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
		// The creator's prose. For a text Work this IS the deliverable; for any other type
		// it is the notes that come with it. Either way it rides with the payload and is
		// gated — `description` is the public blurb that stays visible when locked.
		//
		// These four are the ones with no delivery endpoint of their own, so `deliverable`
		// is where the meter actually bites for reading, playing and looking.
		bodyHtml: deliverable ? work.bodyHtml : "",
		body: deliverable ? work.body : "",
		sourceKey: deliverable ? work.sourceKey : "",
		embedUrl: deliverable ? work.embedUrl : "",
		// 🚨 Lyrics ride WITH the payload, not with the blurb. A gated track's words are as
		// much the deliverable as its audio, and the two failure directions are not
		// symmetric: a creator who wants them public can put them in `description`, which
		// stays visible when locked, while a creator who wanted them private has no way to
		// un-serve words already handed out. Same branch as `body`, deliberately — a third
		// rule here ("gated by access but not by the meter") would be a second mechanism
		// for something already enforced once.
		lyrics: deliverable ? work.lyrics : "",
		pageCount,
		// ⚠️ Downloads stay on `canAccess` alone, deliberately. **The meter measures
		// attention to the commons, not bytes** — delivery is free at any volume since R2,
		// and a spent allowance has never had anything to do with a file you are entitled
		// to. Metering these would invent a limit the model does not have.
		assets: workAssets.map((a) => ({ ...a, file: canAccess ? a.file : "" })),
		// Video and audio keep `canAccess` too: their bytes are refused at
		// `/works/:id/audio` and `/works/:id/hls/:file`, which return a real 402 with the
		// budget attached. Withholding the URL here as well would be a second, weaker
		// mechanism for something already enforced — and the player decides what to render
		// from the budget it holds, not from a missing URL.
		transcoding: viewerTranscoding(job, canAccess, delivery),
		access,
		/**
		 * Whether this Work is **Public Access** — ungated, streaming, free to everyone.
		 *
		 * 🚨 **Derived, never stored, and never a flag a creator sets.** Public Access is
		 * what a Work *is* when there is nothing on it, not a category opted into: leave
		 * the baseline row allowed at $0 on a streaming Work and it is the commons. A
		 * boolean column here would be a second source of truth that could disagree with
		 * the access table, and a creator-facing toggle would invite the question "what
		 * happens if I turn it off but leave it ungated?" — which has no answer.
		 *
		 * Note this is a fact about the WORK and says nothing about whether a given viewer
		 * may watch more of it this month. That is the account-level meter, which is
		 * deliberately not expressed here — see `publicAccessGate`.
		 */
		publicAccess,
	};
}

/**
 * Whether this viewer has spent their monthly Public Access allowance.
 *
 * One read per request, not per Work: the allowance belongs to the **account**, so a
 * page listing forty Works asks once. That is the same reason the meter could never live
 * inside `resolveAccessSync` — which is pure and synchronous precisely so a batch
 * resolves without an N+1.
 *
 * A logged-out viewer is never spent: the server hands anonymous callers the full
 * allowance on purpose, because anonymous streaming of the commons is the shop window.
 */
async function allowanceSpent(viewerId: number | null): Promise<boolean> {
	const budget = await loadPublicAccessBudget(viewerId);
	return !budget.allowed;
}

/** The shape `resolveAccessSync` returns; declared structurally so serialization stays pure. */
type AccessResultLike = ReturnType<typeof resolveAccessSync>;

/** Load Works by id with their assets and latest transcode, ready for serialization. */
async function loadWorkBundles(workIds: number[]): Promise<{
	worksById: Map<number, WorkRow>;
	assetsByWork: Map<number, AssetRow[]>;
	jobByWork: Map<number, TranscodingJobRow>;
	/** Page count per ebook Work. A COUNT, never the keys — see `serializeWorkForViewer`. */
	pagesByWork: Map<number, number>;
}> {
	const worksById = new Map<number, WorkRow>();
	const assetsByWork = new Map<number, AssetRow[]>();
	const jobByWork = new Map<number, TranscodingJobRow>();
	const pagesByWork = new Map<number, number>();
	if (workIds.length === 0) return { worksById, assetsByWork, jobByWork, pagesByWork };

	const [workRows, assetRows, jobRows, pageRows] = await Promise.all([
		db.select().from(works).where(inArray(works.id, workIds)),
		db.select().from(assets).where(inArray(assets.workId, workIds)),
		db
			.select()
			.from(transcodingJobs)
			.where(inArray(transcodingJobs.workId, workIds))
			.orderBy(desc(transcodingJobs.createdAt)),
		db
			.select({ workId: workPages.workId, count: sql<number>`count(*)::int` })
			.from(workPages)
			.where(inArray(workPages.workId, workIds))
			.groupBy(workPages.workId),
	]);
	for (const p of pageRows) pagesByWork.set(p.workId, p.count);

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
	return { worksById, assetsByWork, jobByWork, pagesByWork };
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
	const { worksById, assetsByWork, jobByWork, pagesByWork } = await loadWorkBundles(workIds);
	const [ctx, spent] = await Promise.all([
		buildAccessContext(viewerId, { workIds }),
		allowanceSpent(viewerId),
	]);

	return refs
		.map((ref) => {
			const work = worksById.get(ref.workId);
			if (!work) return null;
			// 🚨 A post announcing an Adult Work does not announce it to somebody who has
			// not opted in. The reference is dropped rather than serialized as locked,
			// because the invisibility rule covers the title and cover art and a locked
			// card is made of both. `ctx` already carries the viewer's adult access, so
			// this costs no extra query — and reading it from the same context the access
			// verdict comes from is what keeps the two from disagreeing.
			if (work.maturity === "adult" && !ctx.adultAccess && ctx.userId !== work.creatorId) {
				return null;
			}
			return {
				position: ref.position,
				work: serializeWorkForViewer(
					work,
					assetsByWork.get(work.id) ?? [],
					jobByWork.get(work.id) ?? null,
					resolveAccessSync(work as AccessibleWork, ctx),
					delivery,
					spent,
					pagesByWork.get(work.id) ?? 0,
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
		const projectSlug = c.req.query("project"); // Project slug
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

		if (projectSlug) {
			const [row] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.slug, projectSlug))
				.limit(1);
			if (!row) return c.json({ posts: [] });
			conditions.push(
				sql`${posts.id} IN (SELECT post_id FROM project_posts WHERE project_id = ${row.id})`,
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
		// Project view shows everything (including off-timeline posts).
		if (mine !== "true" && !projectSlug) {
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
					creator: embedCreator({
						username: r.creatorUsername,
						displayName: r.creatorDisplayName,
						avatar: r.creatorAvatar,
					}),
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

		// Optionally attach to a Project the creator owns.
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

		// A tombstoned post has no creator (the account was deleted; the thread stays
		// readable). Everything downstream already tolerates an absent creator, so the
		// lookups are simply skipped rather than defaulted to somebody.
		const [creator] = post.creatorId
			? await db
					.select({
						username: users.username,
						displayName: users.displayName,
						avatar: users.avatar,
					})
					.from(users)
					.where(eq(users.id, post.creatorId))
					.limit(1)
			: [undefined];

		// Can the creator receive a direct-purchase payout? (Connected account, onboarded
		// and payouts-enabled.) Drives whether the buyer sees a live checkout.
		const [creatorStripe] = post.creatorId
			? await db
					.select({
						payoutsEnabled: stripeAccounts.payoutsEnabled,
						onboardingComplete: stripeAccounts.onboardingComplete,
					})
					.from(stripeAccounts)
					.where(eq(stripeAccounts.userId, post.creatorId))
					.limit(1)
			: [undefined];
		const creatorHasStripe = !!creatorStripe?.onboardingComplete && !!creatorStripe.payoutsEnabled;

		// No review aggregate here: a review is a verdict on a WORK, and a post is an
		// announcement. The Works this post links carry their own.

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

		// Transparent edit history — every content edit is logged with a timestamp, and it
		// carries no viewer predicate **on purpose** (settled 2026-08-09).
		//
		// It used to want one. Before migration `0010` a post carried its own gates, so a
		// viewer denied the body still got the full timestamped list of what changed and
		// when — the shape of gated content, leaked by a query nobody had thought about.
		// The Catalog separation dissolved that rather than fixing it: a post is an
		// announcement and has no gates at all, so there is no hidden body here whose
		// edits could describe it. Publishing the history of a public thing is just
		// Building in the Open.
		//
		// **This is load-bearing for whoever adds an edit log to a Work.** A Work IS
		// gated, and the same query written against it would recreate the original leak
		// exactly — so it needs the viewer predicate this one doesn't.
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

		// Comments are polymorphic, so there is no FK to cascade them — the price the
		// moderation tables already pay for the same shape. Removing them explicitly is
		// what keeps a deleted post from leaving a thread nothing can reach and nothing
		// will ever clean up. (Their moderation reports survive on purpose: a report is a
		// record, and `subjectStillExists` filters them out of the queue and the counts.)
		await db
			.delete(comments)
			.where(and(eq(comments.subjectType, "post"), eq(comments.subjectId, existing.id)));

		await db.delete(posts).where(eq(posts.id, existing.id));
		return c.body(null, 204);
	})

	// ── Comments (polymorphic: a Post or a Work) ───────────────────────────────
	//
	// Both surfaces are the same three queries over `(subject_type, subject_id)`, so they
	// share them. A Work needed its own thread because it can be released, consumed and
	// paid for with no post in sight — under the old model there was nowhere to say
	// anything about it.

	.get("/posts/:slug/comments", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);
		return c.json({ comments: await listComments("post", post.id, await getOptionalUserId(c)) });
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
				.values({ userId: user.id, subjectType: "post", subjectId: post.id, body })
				.returning();

			return c.json({ comment: { ...comment, username: user.username } }, 201);
		},
	)

	.get("/works/:id/comments", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);
		return c.json({ comments: await listComments("work", work.id, await getOptionalUserId(c)) });
	})

	.post("/works/:id/comments", requireAuth, zValidator("json", createCommentSchema), async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		// Discussion follows access. Commenting on a Work you cannot open would be talking
		// about something you have not seen, and it would leak the existence of a thread
		// to people the gate is keeping out.
		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const { body } = c.req.valid("json");
		const [comment] = await db
			.insert(comments)
			.values({ userId: user.id, subjectType: "work", subjectId: work.id, body })
			.returning();

		return c.json({ comment: { ...comment, username: user.username } }, 201);
	})

	// ── Reviews (Works only) ───────────────────────────────────────────────────
	//
	// A review is "a reader's verdict on a work" (63.01), and reviews are floor-level
	// moderation because "a creator moderating reviews of their own work is the conflict
	// reviews exist to avoid" (40.06). Both are about works, so unlike comments this is
	// NOT polymorphic — reviewing an announcement is a category error.
	//
	// The route path stays `/ratings` (and the table stays `ratings`): "review" is a copy
	// rule, not a schema rule, exactly like the Seed vocabulary changes.
	.get("/works/:id/ratings", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const currentUserId = await getOptionalUserId(c);

		// The aggregate is deliberately NOT filtered by blocks, unlike the review list
		// below. A score is a fact about the Work, not about who is reading it: making it
		// viewer-dependent would mean two people see different ratings for the same thing,
		// and it would let one user move a creator's public average by blocking a
		// reviewer. The small honest cost is that a blocker can see "4.2 from 10" over
		// nine listed reviews — which is already true of a hidden review, and is the right
		// side of the trade.
		const [agg] = await db
			.select({ average: avg(ratings.score), count: count(ratings.id) })
			.from(ratings)
			.where(and(eq(ratings.workId, work.id), visibleRating));

		// The written reviews themselves. Hidden ones are withheld here for the same
		// reason they're excluded from the aggregate — this is a public read. Blocked
		// pairs are withheld for a different reason: a review carries a name and words,
		// so it is a place two people meet.
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
			.where(
				and(
					eq(ratings.workId, work.id),
					visibleRating,
					notBlockedBy(currentUserId, ratings.userId),
				),
			)
			.orderBy(desc(ratings.createdAt));

		let userRating: number | null = null;
		let userReview: string | null = null;
		if (currentUserId) {
			// Deliberately unfiltered by moderation status: the score and words a
			// viewer submitted shouldn't silently change under them. Their review
			// simply stops counting and stops appearing to everyone else.
			const [row] = await db
				.select({ score: ratings.score, body: ratings.body })
				.from(ratings)
				.where(and(eq(ratings.workId, work.id), eq(ratings.userId, currentUserId)))
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

	.post("/works/:id/ratings", requireAuth, zValidator("json", createRatingSchema), async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		// You may only review what you can actually consume. This is stricter than the old
		// post route, which let anyone who could reach the page leave a verdict on content
		// they had never seen.
		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const { score, body } = c.req.valid("json");
		// The conflict branch sets `score` and `body` and nothing else — notably not
		// `moderationStatus`. Re-reviewing changes the score and the words on a hidden
		// row without resurrecting it, so a user can't un-hide their own review by
		// submitting again. Adding a field here means adding it to BOTH the insert
		// and this set clause; forgetting the set clause silently makes edits no-ops.
		const [rating] = await db
			.insert(ratings)
			.values({ userId: user.id, workId: work.id, score, body: body.trim() })
			.onConflictDoUpdate({
				target: [ratings.userId, ratings.workId],
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

		// Stamp the buyer's own purchase the first time they take the bytes. That
		// column is what the refund cap turns on — refunds *after download* are the
		// capped ones, because an un-sendable file is the loss the cap bounds — and
		// `works.download_count` above cannot answer it, being a Work-wide counter
		// with no idea who pulled. Fire-and-forget for the same reason the counter
		// is: nothing about bookkeeping may stand between a buyer and their file.
		// (This route has no `requireAuth` — access can be free or entitled — so the
		// viewer comes from the optional session, and a signed-out one stamps
		// nothing because there is no purchase of theirs to stamp.)
		const viewerId = await getOptionalUserId(c);
		if (viewerId) void markPurchaseDownloaded(viewerId, work.id);

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
		// 402, not 403: the viewer is not forbidden, they have spent a monthly allowance
		// that the Public Access price removes. The status code is the difference between "you may not"
		// and "you may, and here is how".
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);

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

	// ── Ebook page delivery (access-checked, signed) ─────────────────────────────
	//
	// The reason `work_pages` exists, in one endpoint: a book is served ONE PAGE AT A TIME,
	// through a check, rather than as a single file whose URL is the whole book. Same shape
	// as the audio route above — re-resolve access, meter the commons, redirect to a
	// short-lived signed URL.
	.get("/works/:id/pages/:page", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const pageNumber = parseNumericId(c.req.param("page"));
		if (pageNumber == null) return c.json({ error: "Not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		// 402, not 403: the reader is not forbidden, they have spent a monthly allowance
		// that the Public Access price removes. Reading the commons draws it exactly as watching does —
		// the equal-time principle is about what a minute IS, not about which medium.
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);

		const [page] = await db
			.select()
			.from(workPages)
			.where(and(eq(workPages.workId, work.id), eq(workPages.pageNumber, pageNumber)))
			.limit(1);
		if (!page) return c.json({ error: "Not found" }, 404);

		const url = await storage.getUrl(page.file, {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		// no-store, for the same reason as the audio redirect: this 302 carries a signed
		// URL and is access-dependent, so a proxy must never replay it at somebody else.
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
		// And the account-level Public Access meter. Checked on the PLAYLIST rather than
		// per segment: segments are fetched straight from the CDN with signed URLs and
		// never touch the API, so the playlist is the last point at which we can decline —
		// and refusing it is what stops playback continuing.
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);

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

		// The same rule the PATCH handler enforces, at the other door a Work's rating and
		// access table can be set together. A Work created Adult and free would be a
		// violation from birth, and the creator should be told at the moment they wrote it
		// rather than at release.
		if (data.maturity === "adult" && isOpenToEveryoneFree(data.seedAccess ?? defaultSeedAccess())) {
			return c.json(
				{
					error:
						"Adult work can't be free to everyone. Put it behind a Badge or set a price, and it can stay Adult.",
					code: "adult_must_be_paid",
				},
				409,
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
				lyrics: data.lyrics ?? "",
				estimatedReadMinutes:
					data.type === "text" && (bodyHtml || data.body)
						? estimateReadMinutes(bodyHtml || (data.body ?? ""))
						: null,
				metadata: data.metadata ?? {},
				visibility: "private",
				// Declared here or left `unrated` for the editor to ask about. Either way it
				// is the creator's own word, so the source says so — nothing here can be an
				// operator's correction, because the Work did not exist a moment ago.
				maturity: data.maturity ?? "unrated",
				maturityNotes: data.maturity ? normalizeContentNotes(data.maturityNotes ?? []) : [],
				maturitySource: data.maturity ? "creator" : null,
				maturitySetAt: data.maturity ? new Date() : null,
				authoredAt: data.authoredAt ? new Date(data.authoredAt) : null,
				authoredPrecision: data.authoredPrecision ?? null,
				streamEnabled: data.streamEnabled ?? true,
				downloadEnabled: data.downloadEnabled ?? false,
				seedAccess: data.seedAccess ?? defaultSeedAccess(),
				isPinned: data.isPinned ?? false,
				tags: data.tags ?? [],
				websiteUrl: data.websiteUrl ?? "",
				sourceUrl: data.sourceUrl ?? "",
			})
			.returning();

		const job = await queueTranscodeForWork(work);
		await queueScanForWork(work);
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
	.get("/works/:id", zValidator("query", previewQuerySchema), async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const viewerId = await getOptionalUserId(c);
		const isOwner = viewerId != null && viewerId === work.creatorId;
		if (work.visibility !== "released" && !isOwner) {
			// A withdrawn Work is out of public circulation but still owed to the people
			// who bought it — that is the whole point of the state, so this is the one
			// place a non-released Work is served to someone other than its creator.
			// `private` still 404s for everyone else: it was never anyone's to buy.
			const stillOwed =
				work.visibility === "withdrawn" &&
				viewerId != null &&
				(
					await db
						.select({ id: purchases.id })
						.from(purchases)
						.where(
							and(
								eq(purchases.workId, work.id),
								eq(purchases.buyerId, viewerId),
								eq(purchases.status, "completed"),
							),
						)
						.limit(1)
				).length > 0;
			if (!stillOwed) return c.json({ error: "Work not found" }, 404);
		}

		// 🚨 **404, not 403, and the difference is the whole rule.** Adult work is invisible
		// to anyone who has not opted in and verified — its existence, title and cover art
		// included — so a response saying "this exists and you may not have it" would leak
		// exactly what the rung withholds. This is also the surface a share link arrives at,
		// and 40.13 is explicit that a share link is a locator and never an entitlement: the
		// person following one has no setting for the opt-in to consult, so they meet the
		// same absence a search would have given them.
		//
		// ⚠️ Placed after the owner and withdrawn-purchaser branches deliberately. A creator
		// reaches their own Work whatever their setting says, and this must not become the
		// reason somebody cannot see a thing they made.
		if (!isOwner && work.maturity === "adult") {
			const { access } = await adultVisibility(viewerId);
			if (!access.canReach) return c.json({ error: "Work not found" }, 404);
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

		/*
		 * The owner short-circuit — and the one place creator preview has to interrupt it.
		 *
		 * A creator's own Work comes back through `serializeWork`, the owner-facing shape:
		 * full media keys, the editable access table, and **no `access` verdict at all**,
		 * because an owner has never needed one. That is exactly what a preview is asking
		 * for, so a preview request falls through to the viewer path below rather than
		 * being applied here — which is why `contextFor` can substitute a context and get
		 * a real answer out of the real resolver.
		 *
		 * ⚠️ Missing this branch is why the first cut of the preview did nothing at all for
		 * the person it exists for: the parameter was parsed, the context was built, and
		 * the request never reached the code that used it.
		 */
		if (isOwner && previewRequest(c) === null) {
			return c.json({ work: serializeWork(work, workAssets, jobRows[0] ?? null) });
		}

		// Fire-and-forget view count, owners excluded.
		db.update(works)
			.set({ viewCount: sql`${works.viewCount} + 1` })
			.where(eq(works.id, work.id))
			.execute();

		const ctx = await buildAccessContext(viewerId, { workIds: [work.id] });
		// A withdrawn Work can outlive its creator's account — see `works.creator_id`.
		const [creator] = work.creatorId
			? await db
					.select({
						username: users.username,
						displayName: users.displayName,
						avatar: users.avatar,
					})
					.from(users)
					.where(eq(users.id, work.creatorId))
					.limit(1)
			: [undefined];

		// Can the creator actually receive a direct-purchase payout? Drives whether the
		// buyer is offered a live checkout or told the creator can't take payments yet.
		const [creatorStripe] = work.creatorId
			? await db
					.select({
						payoutsEnabled: stripeAccounts.payoutsEnabled,
						onboardingComplete: stripeAccounts.onboardingComplete,
					})
					.from(stripeAccounts)
					.where(eq(stripeAccounts.userId, work.creatorId))
					.limit(1)
			: [undefined];

		// This endpoint does not go through `loadWorkBundles`, so the page count is counted
		// here. It is the ONE page a reader actually opens a book from, and leaving it on
		// the parameter default would have reported every ebook as zero pages — with no
		// error, and a reader that renders nothing.
		const [pageRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(workPages)
			.where(eq(workPages.workId, work.id));

		return c.json({
			work: {
				...serializeWorkForViewer(
					work,
					workAssets,
					jobRows[0] ?? null,
					resolveAccessSync(
						work as AccessibleWork,
						contextFor(work, viewerId, ctx, previewRequest(c)),
					),
					deliveryCtx(),
					await allowanceSpent(viewerId),
					pageRow?.count ?? 0,
				),
				creator,
				creatorHasStripe: !!creatorStripe?.onboardingComplete && !!creatorStripe.payoutsEnabled,
				// Where this Work has been announced — the other half of the reference.
				postedIn: await postsUsingWork(work.id),
			},
		});
	})

	/**
	 * Works anyone can open — released, streamable, and free to everyone.
	 *
	 * The predicate is deliberately the **viewer-independent** one: a Work qualifies when
	 * one of its access rows opens it at threshold 0 for no money, which is exactly what a
	 * signed-out visitor having given nothing resolves `free` against in `resolveAccessSync`.
	 * It asks only "is anything in the way", so it needs no opinion about *which* gate
	 * kinds exist — which is why it stays correct across the Public Access revamp rather
	 * than encoding a model that hasn't propagated yet.
	 *
	 * Streaming only, because the surface this feeds is a press-play strip and a
	 * downloadable file is a promise about bytes rather than about access.
	 *
	 * Read the two access tables in SQL rather than resolving in JS: the alternative is
	 * pulling every released Work into memory to filter a handful out of it.
	 */
	.get("/open-works", async (c) => {
		const limit = Math.min(24, Math.max(1, Number(c.req.query("limit") ?? 12)));
		const viewerId = await getOptionalUserId(c);

		/** True when this access table has a row opening the Work to everyone, for free. */
		const openToEveryone = (column: SQL | unknown) => sql`EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(${column}, '[]'::jsonb)) AS access_row
			WHERE (access_row->>'threshold')::numeric = 0
			  AND (access_row->>'allow')::boolean IS TRUE
			  AND COALESCE((access_row->>'price')::numeric, 0) = 0
		)`;

		const rows = await db
			.select({ work: works, username: users.username, displayName: users.displayName })
			.from(works)
			.innerJoin(users, eq(works.creatorId, users.id))
			.where(
				and(
					eq(works.visibility, "released"),
					eq(works.streamEnabled, true),
					openToEveryone(works.seedAccess),
					notBlockedBy(viewerId, works.creatorId),
					// ✅ **Belt and braces, and both belts are real.** Adult work cannot be
					// Public Access by the access rule alone — `openToEveryone` above needs a
					// baseline row that is allowed and free, and Adult work may not be free —
					// so this condition should never remove a row from this particular query.
					// It is here because that argument is a chain of two other rules, and a
					// listing whose correctness depends on somebody remembering the chain is
					// one relaxation away from being wrong. Wiki 40.09: the rule is enforced
					// twice over, and if either half were relaxed the other still holds.
					(await adultVisibility(viewerId)).hidden,
				),
			)
			.orderBy(sql`COALESCE(${works.releasedAt}, ${works.createdAt}) DESC`)
			.limit(limit);

		await Promise.all(rows.map((r) => resolveWorkThumbnail(r.work)));

		return c.json({
			works: rows.map(({ work, username, displayName }) => ({
				publicId: work.publicId,
				slug: work.slug,
				title: work.title,
				type: work.type,
				thumbnail: work.thumbnail,
				durationSeconds: work.durationSeconds,
				estimatedReadMinutes: work.estimatedReadMinutes,
				creator: { username, displayName },
			})),
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
	.get("/catalog/:username", zValidator("query", catalogQuerySchema), async (c) => {
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
		// 🚨 A creator profile is one of the non-feed surfaces 40.09 left open, and it is
		// settled: a reader who has not opted in meets nothing at all rather than an
		// interstitial. The accepted cost is that this Catalog is silently incomplete for
		// them — the alternative was announcing the existence and usually the title of work
		// the rung specifically does not give an existence to.
		const adultHidden = (await adultVisibility(viewerId)).hidden;
		if (adultHidden) conditions.push(adultHidden);

		const preview = previewRequest(c);
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
		const { assetsByWork, jobByWork, pagesByWork } = await loadWorkBundles(ids);
		const [ctx, catalogSpent] = await Promise.all([
			buildAccessContext(viewerId, { workIds: ids }),
			allowanceSpent(viewerId),
		]);
		await Promise.all(rows.map(resolveWorkThumbnail));

		return c.json({
			creator,
			works: rows.map((w) =>
				serializeWorkForViewer(
					w,
					assetsByWork.get(w.id) ?? [],
					jobByWork.get(w.id) ?? null,
					resolveAccessSync(w as AccessibleWork, contextFor(w, viewerId, ctx, preview)),
					deliveryCtx(),
					catalogSpent,
					pagesByWork.get(w.id) ?? 0,
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
		// Reassigned below when the rating service rewrites the row, so the rest of the
		// handler edits what is actually stored rather than what was loaded first.
		let [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
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

		// 🚨 A quarantined Work is not editable by its creator at all, and a 404 rather than
		// a 403 is deliberate. Delivery is already denied and the media already moved, so
		// nothing here could put it back — but a creator who could still rename it, re-gate
		// it or flip it back to `released` would be operating on material under a
		// preservation hold, and telling them *why* the Work has become untouchable hands a
		// signal to exactly the account we would least like to have one. `requireAdmin`
		// 404s rather than 403s for the same reason.
		if (work.quarantineStatus === "quarantined") {
			return c.json({ error: "Work not found" }, 404);
		}

		const releasing = data.visibility === "released" && work.visibility !== "released";

		// 🚨 **A LIVE Work may not be moved to a closed rung, and this is checked before the
		// rating is written rather than after.** Everywhere else on this route the
		// declaration is stored first and the release refused second, so a refusal never
		// costs the creator their answer — but that trade only works while the Work is
		// private. Applied here it would write the rating onto a Work that is already
		// public and then refuse, leaving it released *at* the closed rung: the one state
		// the whole guard exists to prevent. So this case refuses and stores nothing, and
		// the message says what to do — make it private, and the declaration will stick.
		//
		// Scoped to a request that names a rating, so a Work sitting at a rung that closed
		// after it was released stays editable in every other respect.
		if (
			work.visibility === "released" &&
			data.visibility !== "private" &&
			data.maturity !== undefined &&
			releaseRatingRefusal(data.maturity) === "closed"
		) {
			const rung = maturityLabel(data.maturity);
			return c.json(
				{
					error: `Anthers isn't accepting ${rung} work at the moment, so a released Work can't be rated ${rung}. Make this Work private and the rating will save — it will keep it until ${rung} reopens.`,
					code: "maturity_rung_closed",
					rung: data.maturity,
				},
				409,
			);
		}

		// 🚨 **The rating is otherwise written BEFORE the release gates, and the order is
		// the design rather than tidiness.** A creator who declares a rating and ticks
		// release in one request — the ordinary flow from the editor, which sends the whole
		// form — must not lose the declaration when the release is refused. It ran after the
		// gates until 2026-08-28, so declaring Adult and releasing together answered 409 and
		// left the Work `unrated`: the creator's honest answer was discarded, and the
		// cheapest way out was to pick a lower rung and have it work. That is exactly the
		// under-declaration pressure wiki 40.13 exists to remove, produced by the gate meant
		// to enforce it. Every readiness refusal below now leaves the rating stored, so a
		// creator whose media is still encoding keeps their answer too.
		//
		// It goes through its own service because it is the one field on this route another
		// party can have decided. A creator lowering an operator's correction is refused
		// here rather than silently dropped — and told where the appeal is, since the
		// refusal is otherwise indistinguishable from the edit not having saved.
		if (data.maturity !== undefined || data.maturityNotes !== undefined) {
			const declared = await declareRating(work, {
				maturity: data.maturity,
				notes: data.maturityNotes,
			});
			if (declared === "locked") {
				return c.json(
					{
						error:
							"An operator set this Work's rating. You can make it more cautious at any time; to lower it, appeal.",
						code: "maturity_locked",
					},
					409,
				);
			}
			// Re-read, so the gates below and the rest of this handler read the row the
			// service just wrote rather than the one loaded before it.
			work = declared;
		}

		// 🚨 **Adult work may not be free**, so it may not carry a baseline row opening it to
		// everyone at no cost — which is what Public Access is. Wiki 40.09 stacks three
		// reasons: under distributor-pays a free Work makes the **Time Pool** the payer,
		// which is a materially worse position with processors and regulators than a creator
		// selling their own work; it would pay creators per minute for adult content, an
		// attention-maximizing incentive on the one category where that is least wanted; and
		// it would make supporting Anthers a route to adult content, turning the pitch into
		// *"give Anthers $3, watch unlimited adult content"* — Anthers selling access rather
		// than facilitating a creator's sale.
		//
		// ✅ **Evaluated on the state this edit RESULTS IN**, because either half can move in
		// this request: a creator can rate a free Work Adult, or open a paid Adult Work up,
		// and each is the same violation arrived at from a different side. Checked here
		// rather than only on release, since a private Work in this state is a release away
		// from being live and the creator should learn now rather than then.
		const resultingAccess = data.seedAccess !== undefined ? data.seedAccess : work.seedAccess;
		if (work.maturity === "adult" && isOpenToEveryoneFree(resultingAccess)) {
			return c.json(
				{
					error:
						"Adult work can't be free to everyone. Put it behind a Badge or set a price, and it can stay Adult.",
					code: "adult_must_be_paid",
				},
				409,
			);
		}

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

		// The third readiness condition, and the only one a creator can satisfy instantly.
		// A Work is born `unrated` and release is what makes it somebody else's business,
		// so this is the moment to have asked. It reads the STORED rating because the block
		// above has already written whatever this request declared — which is what lets the
		// refusal keep the creator's answer instead of costing them it.
		//
		// 🚨 **It asks two questions rather than one, and the second is not the same
		// question later.** Whether a rating has been *declared* is about the creator;
		// whether the declared rung is one Anthers currently *accepts* is about Anthers, and
		// a Work can fail the second while answering the first perfectly. Wiki 40.13 §
		// Classifying a Work Is Not the Same as Accepting It is why they are separate: a
		// Work at a closed rung is rated correctly and refused, rather than pushed into
		// under-declaring one rung down.
		//
		// ⚠️ **This half asks only about a Work being released NOW**, and the already-live
		// case is handled above, before anything is written. Refusing every edit to a Work
		// whose stored rating is `unrated` or at a closed rung would make Works released
		// before the rating existed — and Works caught by a rung closing — uneditable.
		const nextRating = work.maturity as MaturityRating;
		if (releasing) {
			const refusal = releaseRatingRefusal(nextRating);
			if (refusal === "undeclared") {
				return c.json(
					{
						error: "Say how this Work is rated before releasing it.",
						code: "maturity_undeclared",
					},
					409,
				);
			}
			if (refusal === "closed") {
				const rung = maturityLabel(nextRating);
				return c.json(
					{
						// Names the rung, and says the rating is right rather than wrong.
						// A creator who reads this as an error to retry will lower the
						// rating until it goes away, which is the one outcome this refusal
						// exists to prevent. The rating is already stored, so "leave it as
						// it is" is a description of what just happened rather than a
						// request.
						error: `Anthers isn't accepting ${rung} work at the moment, so this Work can't be released. The rating is right and has been saved — you'll be able to release when ${rung} reopens.`,
						code: "maturity_rung_closed",
						rung: nextRating,
					},
					409,
				);
			}
		}

		// Detection is the second readiness condition, and it is the same kind of thing as
		// the first: 40.08 settles that publishing is not gated on encoding but release is
		// gated on readiness, and an image whose scan has not come back is not ready. It is
		// checked here rather than on the queued job because release is the moment the object
		// becomes reachable by somebody other than its uploader.
		//
		// 🚨 **It gives way rather than blocking, and that is deliberate.** The window is two
		// minutes from when the scans were queued; past it the creator releases and the scan
		// stays owed, because a detection vendor's outage must not stop everyone on Anthers
		// from publishing. `services/safety-scan.ts` carries the full reasoning, including
		// why quarantine reaching a released Work is what makes the trade honest.
		if (releasing) {
			const gate = await scanReleaseGate(work);
			if (gate.blocked) {
				return c.json(
					{
						error: "Almost — we're still checking this Work's images. Try again in a moment.",
						code: "scan_pending",
						// A count rather than the keys. A storage key is not the creator's
						// business, and neither is which of their objects we are still asking
						// about.
						pending: gate.pending.length,
						retryAfter: gate.waitUntil?.toISOString() ?? null,
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
		if (data.seedAccess !== undefined) updates.seedAccess = data.seedAccess;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.tags !== undefined) updates.tags = data.tags;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.sourceUrl !== undefined) updates.sourceUrl = data.sourceUrl;
		if (data.body !== undefined) updates.body = data.body;
		// Not gated on `work.type === "audio"`, unlike bodyHtml below. Only audio Works show
		// lyrics, but refusing the write for any other type would silently discard what a
		// creator typed if they ever changed the type — and the column is inert everywhere
		// else, so there is nothing to protect against.
		if (data.lyrics !== undefined) updates.lyrics = data.lyrics;
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
		// A replaced thumbnail is new bytes from the same uploader, so it owes its own scan.
		const thumbnailChanged = data.thumbnail !== undefined && data.thumbnail !== work.thumbnail;
		if (data.sourceKey !== undefined) updates.sourceKey = data.sourceKey;

		const [updated] = await db.update(works).set(updates).where(eq(works.id, id)).returning();

		// A new source means the old transcode is stale — re-process.
		if (sourceChanged && updated.sourceKey) await queueTranscodeForWork(updated);
		if (sourceChanged || thumbnailChanged) await queueScanForWork(updated);

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
	 * A Work's rating appeals — the creator's own record of what they contested and how it
	 * was answered.
	 *
	 * Owner-only, and it returns the operator's resolution note rather than only the
	 * outcome. An appeal refused with no answer is the version of this feature that teaches
	 * creators not to bother filing one.
	 */
	.get("/works/:id/rating-appeals", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db
			.select({ id: works.id })
			.from(works)
			.where(and(eq(works.id, id), eq(works.creatorId, user.id)))
			.limit(1);
		if (!item) return c.json({ error: "Work not found" }, 404);
		return c.json({ appeals: await appealsForWork(id) });
	})

	/**
	 * Appealing an operator's correction of a Work's rating.
	 *
	 * 🚨 **This is part of the rating feature rather than a later refinement**, on 40.09's
	 * reasoning: because the Adult rung is payment-gated, an over-cautious call
	 * does not merely add a warning to a work, it puts it behind a paywall — and for a queer
	 * coming-of-age story wrongly flagged, that is exactly the harm the category exists to
	 * prevent, produced by the mechanism meant to prevent it. Shipping the correction
	 * without the contest would build only the half that can do damage.
	 */
	.post(
		"/works/:id/rating-appeals",
		requireAuth,
		zValidator("json", ratingAppealSchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [work] = await db
				.select()
				.from(works)
				.where(and(eq(works.id, id), eq(works.creatorId, user.id)))
				.limit(1);
			if (!work) return c.json({ error: "Work not found" }, 404);

			const { requestedMaturity, statement } = c.req.valid("json");
			const result = await fileRatingAppeal({
				work,
				creatorId: user.id,
				requestedMaturity,
				statement,
			});

			// Each refusal is something the creator can act on, so each gets its own
			// sentence rather than one generic 400. "Nobody corrected this" in particular
			// has a better answer than an appeal: edit the field.
			if (result === "not-locked") {
				return c.json(
					{
						error:
							"This Work's rating is your own — change it in the editor rather than appealing.",
						code: "not_locked",
					},
					409,
				);
			}
			if (result === "not-a-change") {
				return c.json({ error: "That is the rating it already has.", code: "not_a_change" }, 400);
			}
			if (result === "already-open") {
				return c.json(
					{ error: "You already have an appeal open on this Work.", code: "already_open" },
					409,
				);
			}
			return c.json({ appeal: result }, 201);
		},
	)

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

		// Sold count rides along so the delete dialog can warn about the irreversible
		// half — taking away something people paid for — before the creator commits,
		// rather than bouncing them off a 409 after they've already decided.
		const [{ count: purchaseCount } = { count: 0 }] = await db
			.select({ count: countDistinct(purchases.id) })
			.from(purchases)
			.where(and(eq(purchases.workId, id), eq(purchases.status, "completed")));

		return c.json({ posts: await postsUsingWork(id), purchaseCount });
	})

	.delete("/works/:id", requireAuth, zValidator("query", deleteWorkQuerySchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) {
			return c.json({ error: "Work not found" }, 404);
		}

		// 🚨 A quarantined Work cannot be deleted by anybody, and this is the sharpest
		// version of that rule: deletion here calls `purgeWorkMedia`, which destroys the
		// objects. Everything quarantined is under a § 2258A(h) preservation hold, so
		// running this path would be destroying evidence under a statutory hold — a
		// federal offense under 18 U.S.C. § 1519, committed by a cron job on a creator's
		// button press. 404 rather than 403, on the same reasoning as the PATCH above.
		if (item.quarantineStatus === "quarantined") {
			return c.json({ error: "Work not found" }, 404);
		}

		// Read once: it decides both whether to stop and ask, and — below — whether this
		// is a deletion at all or a withdrawal.
		const [{ count: soldCount } = { count: 0 }] = await db
			.select({ count: countDistinct(purchases.id) })
			.from(purchases)
			.where(and(eq(purchases.workId, id), eq(purchases.status, "completed")));

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

			// Someone paid for this. Say so before doing anything — removing it from
			// public circulation is still a decision worth confirming, even though
			// forcing it no longer strands the buyer (see the withdrawal below).
			if (soldCount > 0) {
				return c.json(
					{
						error: `${soldCount} ${soldCount === 1 ? "person has" : "people have"} bought this Work. It will be removed from public view; ${soldCount === 1 ? "they keep" : "they keep"} access to what ${soldCount === 1 ? "they" : "they"} paid for.`,
						code: "work_purchased",
						purchaseCount: soldCount,
					},
					409,
				);
			}
		}

		// ── Purchased: withdraw, never destroy ──────────────────────────────────────
		//
		// The ruling this implements: *if a user purchases something, they own it,
		// regardless of what the creator does down the line.* Hard-deleting a purchased
		// Work took the thing away from everyone who had paid for it — the `0016` work
		// kept their *receipt*, which is not the same as keeping what they bought.
		//
		// So a forced delete on a purchased Work is a WITHDRAWAL: out of the Catalog, out
		// of the feeds, unpurchasable — every public listing filters *for* `released`, so
		// they exclude it with no change of their own — while the row, the media and the
		// buyers' access all stay. Delivery gates on `resolveAccess`, which reads
		// purchases and never visibility, so their downloads and streams keep working.
		//
		// Deliberately NOT built here: the rescue window's expiry. The retention model
		// gives buyers a notified, funded grace period and then removes the Work for
		// real, but both its duration and the notification mechanism are open questions
		// in the privacy-policy work. `withdrawn_at` is stamped so that sweep is a later
		// job rather than a later migration — and until it exists, erring toward keeping
		// a buyer's purchase alive is the right way to be wrong.
		if (soldCount > 0) {
			await db
				.update(works)
				.set({ visibility: "withdrawn", withdrawnAt: new Date(), updatedAt: new Date() })
				.where(eq(works.id, id));
			return c.json({ withdrawn: true, purchaseCount: soldCount }, 200);
		}

		const [workAssets, jobRows] = await Promise.all([
			db.select().from(assets).where(eq(assets.workId, id)),
			db.select().from(transcodingJobs).where(eq(transcodingJobs.workId, id)),
		]);
		await purgeWorkMedia(item, workAssets, jobRows);

		await db.delete(works).where(eq(works.id, id));
		return c.body(null, 204);
	})

	// ── Content-item downloadable assets (builds/variants) ────────────────────────
	.post("/works/:id/assets", requireAuth, zValidator("json", createAssetSchema), async (c) => {
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
	})

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
	// PROJECTS — they group Works and Posts
	// ══════════════════════════════════════════════════════════════════════════

	.get("/projects", async (c) => {
		const mine = c.req.query("mine");
		const creator = c.req.query("creator");
		const search = c.req.query("search");
		// Discover's sidebar has always sent these; until now the handler read none of
		// them, so every filter control on the page did nothing while looking like it
		// worked. They key on the project's **Works**, because a project is a collection
		// and has no type, tags or price of its own.
		const mediaType = c.req.query("media_type");
		const tag = c.req.query("tag");
		const pricing = c.req.query("pricing");
		const sort = c.req.query("sort") ?? "newest";
		const minPrice = c.req.query("min_price");
		const maxPrice = c.req.query("max_price");
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

		/** Any allowed row on the Work's access table. (There were two tables to concatenate
		 * here until Anthers Gates were retired on 2026-08-12.) */
		const anyAccessRow = (predicate: SQL) => sql`EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(w.seed_access, '[]'::jsonb)) r
			WHERE (r->>'allow')::boolean AND (${predicate})
		)`;

		/** The cheapest allowed offer on a Work, for the price-range filter. */
		const cheapestPrice = sql`(
			SELECT MIN((r->>'price')::numeric)
			FROM jsonb_array_elements(COALESCE(w.seed_access, '[]'::jsonb)) r
			WHERE (r->>'allow')::boolean
		)`;

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
			// this viewer can actually open. That needs the access rules in SQL rather
			// than the usual `resolveAccessSync` pass, because filtering in memory would
			// run AFTER `LIMIT 100` and silently return fewer rows to some viewers than
			// others — a filter whose result depends on who is asking is exactly the kind
			// that has to be part of the query.
			//
			// Signed-out viewers are exempt: everything gated is locked to them, so the
			// filter would empty the list every time and read as a broken page rather than
			// as a filter doing its job. "Hide what I can't open" only means something
			// once there is something you can.
			const viewerId = await getOptionalUserId(c);
			if (showLocked !== "true" && viewerId != null) {
				const ctx = await buildAccessContext(viewerId);
				// The access table compares against what the viewer gives *that Work's creator*,
				// a different number per row, so the viewer's allocations travel as a jsonb map
				// keyed by creator id and are looked up per row.
				const seedMap = JSON.stringify(Object.fromEntries(ctx.supportByCreator));
				// Coerced explicitly because the ids are inlined rather than bound: they
				// come from our own `purchases` rows and are integers already, and this is
				// what keeps that true if the source ever changes.
				const purchased = [...ctx.purchasedWorkIds].map(Number).filter(Number.isInteger);
				conditions.push(
					containsWork(sql`(
						${viewerId} = w.creator_id
						OR w.id = ANY(${sql.raw(`ARRAY[${purchased.length ? purchased.join(",") : ""}]::int[]`)})
						OR EXISTS (
							SELECT 1 FROM jsonb_array_elements(COALESCE(w.seed_access, '[]'::jsonb)) r
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
					sql`EXISTS (SELECT 1 FROM assets a WHERE a.work_id = w.id AND a.platform = ${platform})`,
				),
			);
		}

		// Duration bands differ by medium — half an hour is a long track and a short film —
		// so they are read against the media type the viewer has already selected, and
		// ignored without one rather than guessing which scale was meant.
		// `null` upper bound means unbounded — not a sentinel, because `duration_seconds`
		// is int4 and any "very large" stand-in either overflows the column type or
		// invites someone to pick one that doesn't.
		const BANDS: Record<string, Record<string, [number, number | null]>> = {
			audio: { short: [0, 300], medium: [300, 1800], long: [1800, null] },
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

		// Summed views and mean score both range over the project's released Works, for the
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
			case "top_rated":
				orderClause = [
					sql`(SELECT AVG(rt.score) FROM project_items pi JOIN ratings rt ON rt.work_id = pi.work_id
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
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
				postCount: sql<number>`(SELECT COUNT(*)::int FROM project_posts WHERE project_id = ${projectsId})`,
			})
			.from(projects)
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(...orderClause)
			.limit(100);

		return c.json({
			projects: result.map((r) => ({
				...r.project,
				postCount: Number(r.postCount),
				creator: embedCreator({
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				}),
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

		// The Works in this Project, each resolved on its own gates. A Project is a
		// shelf: putting a Work on it changes nothing about who can open it.
		const itemRows = await db
			.select({ work: works, sortOrder: projectItems.sortOrder })
			.from(projectItems)
			.innerJoin(works, eq(projectItems.workId, works.id))
			.where(
				and(
					eq(projectItems.projectId, row.project.id),
					// A creator browsing their own project sees drafts; nobody else does.
					viewerId === row.project.creatorId ? undefined : eq(works.visibility, "released"),
					// A project is a listing like any other, so an Adult member is absent
					// from it rather than present and locked.
					(await adultVisibility(viewerId)).hidden,
				),
			)
			.orderBy(asc(projectItems.sortOrder));

		const memberWorkIds = itemRows.map((r) => r.work.id);
		const { assetsByWork, jobByWork, pagesByWork } = await loadWorkBundles(memberWorkIds);
		const [workCtx, projectSpent] = await Promise.all([
			buildAccessContext(viewerId, { workIds: memberWorkIds }),
			allowanceSpent(viewerId),
		]);
		await Promise.all(itemRows.map((r) => resolveWorkThumbnail(r.work)));

		return c.json({
			project: {
				...row.project,
				creator: embedCreator({
					username: row.creatorUsername,
					displayName: row.creatorDisplayName,
					avatar: row.creatorAvatar,
				}),
				works: itemRows.map((m) => ({
					sortOrder: m.sortOrder,
					...serializeWorkForViewer(
						m.work,
						assetsByWork.get(m.work.id) ?? [],
						jobByWork.get(m.work.id) ?? null,
						resolveAccessSync(
							m.work as AccessibleWork,
							contextFor(m.work, viewerId, workCtx, previewRequest(c)),
						),
						deliveryCtx(),
						projectSpent,
						pagesByWork.get(m.work.id) ?? 0,
					),
				})),
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
					creator: embedCreator({
						username: m.creatorUsername,
						displayName: m.creatorDisplayName,
						avatar: m.creatorAvatar,
					}),
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

	// ── Project membership (Works) ────────────────────────────────────────────
	//
	// The half that was always missing. A project could only hold announcements, which
	// meant an album could not hold its tracks — 40.02's own worked example ("a track in
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
		// Catalog, released, with its gates — a Project is a shelf, not an owner.
		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
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
	// BOOKMARKS — a user-ordered list of posts, Projects, and creators
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
	})

	// ── The Library ──────────────────────────────────────────────────────────────
	//
	// What a user has KEPT: everything they bought, plus everything free they chose to
	// save. Curation, never entitlement — `services/library.ts` and the table's own doc
	// comment carry the reasoning, and `resolveAccess` does not read any of it.

	/**
	 * The user's shelf.
	 *
	 * Access is resolved per item exactly as the Catalog resolves it, because a shelf can
	 * hold a Work its owner cannot currently open: a free Work they saved and its creator
	 * later gated, or a refunded purchase. Those render locked with the route to unlock,
	 * which is the same behaviour a gated track gets in the play queue.
	 *
	 * `?hidden=1` includes tidied-away entries — the "show hidden" toggle. They are
	 * excluded by default and never deleted.
	 */
	.get("/library", requireAuth, async (c) => {
		const user = c.get("user");
		const includeHidden = c.req.query("hidden") === "1";

		const conditions: SQL[] = [eq(libraryItems.userId, user.id)];
		if (!includeHidden) conditions.push(eq(libraryItems.hidden, false));

		const rows = await db
			.select()
			.from(libraryItems)
			.where(and(...conditions))
			.orderBy(asc(libraryItems.sortOrder))
			.limit(500);

		const workIds = rows.map((r) => r.workId).filter((id): id is number => id != null);
		const projectIds = rows.map((r) => r.projectId).filter((id): id is number => id != null);

		const workRows = workIds.length
			? await db.select().from(works).where(inArray(works.id, workIds))
			: [];
		const projectRows = projectIds.length
			? await db
					.select({
						id: projects.id,
						slug: projects.slug,
						title: projects.title,
						coverImage: projects.coverImage,
						creatorId: projects.creatorId,
						creatorUsername: users.username,
						creatorDisplayName: users.displayName,
					})
					.from(projects)
					.leftJoin(users, eq(projects.creatorId, users.id))
					.where(inArray(projects.id, projectIds))
			: [];

		/*
		 * How many released Works a saved Project holds, and how many of those are audio.
		 *
		 * Enough for a shelf to render a saved Project *as an album* — cover, artist, track
		 * count — without fetching each Project's detail, which is an N+1 on a page that
		 * exists to show a collection. Deliberately a count rather than the members: the
		 * tracks themselves are fetched when somebody actually presses play, and shipping
		 * every member of every saved album on a shelf request would be the opposite trade.
		 *
		 * `audioCount === workCount` is what makes it a record rather than a folder — the
		 * same rule `isAlbum` applies on a Project page, kept in step by both being about
		 * "every member is audio" rather than by sharing code across the boundary.
		 */
		const memberCounts = projectIds.length
			? await db
					.select({
						projectId: projectItems.projectId,
						workCount: sql<number>`count(*)::int`,
						audioCount: sql<number>`count(*) filter (where ${works.type} = 'audio')::int`,
					})
					.from(projectItems)
					.innerJoin(works, eq(projectItems.workId, works.id))
					.where(and(inArray(projectItems.projectId, projectIds), eq(works.visibility, "released")))
					.groupBy(projectItems.projectId)
			: [];
		const countsByProject = new Map(memberCounts.map((m) => [m.projectId, m]));

		const { assetsByWork, jobByWork, pagesByWork } = await loadWorkBundles(workIds);
		const [ctx, spent, permanent] = await Promise.all([
			buildAccessContext(user.id, { workIds }),
			allowanceSpent(user.id),
			permanentWorkIds(user.id),
		]);
		await Promise.all(workRows.map(resolveWorkThumbnail));

		const workById = new Map(workRows.map((w) => [w.id, w]));
		const projectById = new Map(projectRows.map((p) => [p.id, p]));

		return c.json({
			items: rows
				.map((row) => {
					const base = {
						id: row.id,
						hidden: row.hidden,
						sortOrder: row.sortOrder,
						savedAt: row.savedAt,
					};
					if (row.workId != null) {
						const w = workById.get(row.workId);
						if (!w) return null;
						return {
							...base,
							kind: "work" as const,
							// Derived from `purchases` on every read, never stamped on the row —
							// so a refund releases the entry with nothing to keep in step.
							purchased: permanent.has(w.id),
							work: serializeWorkForViewer(
								w,
								assetsByWork.get(w.id) ?? [],
								jobByWork.get(w.id) ?? null,
								resolveAccessSync(w as AccessibleWork, ctx),
								deliveryCtx(),
								spent,
								pagesByWork.get(w.id) ?? 0,
							),
						};
					}
					const p = row.projectId != null ? projectById.get(row.projectId) : null;
					if (!p) return null;
					// A Project is a shelf, not a payload: it has no gates of its own and
					// nothing to withhold. Its members resolve their own access when opened.
					const counts = countsByProject.get(p.id);
					return {
						...base,
						kind: "project" as const,
						purchased: false,
						project: {
							...p,
							trackCount: counts?.workCount ?? 0,
							// Every released member is audio — i.e. this is a record, not a
							// folder that happens to contain some music.
							isAlbum: (counts?.workCount ?? 0) > 0 && counts?.workCount === counts?.audioCount,
						},
					};
				})
				.filter((x) => x != null),
		});
	})

	/** Save a Work or a Project. Idempotent, and un-hides one that was tidied away. */
	.post(
		"/library",
		requireAuth,
		zValidator(
			"json",
			z
				.object({
					workId: z.number().int().positive().optional(),
					projectId: z.number().int().positive().optional(),
				})
				// Exactly one — the same shape `bookmarks` uses, checked here rather than by
				// a database constraint so the error is a sentence instead of a 500.
				.refine((d) => (d.workId == null) !== (d.projectId == null), {
					message: "Save either a Work or a Project, not both and not neither",
				}),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

			const result =
				data.workId != null
					? await saveWork(user.id, data.workId)
					: await saveProject(user.id, data.projectId as number);

			if (!result.ok) {
				return c.json(
					{
						error:
							result.reason === "not_released" ? "That isn't released yet." : "That doesn't exist.",
					},
					404,
				);
			}
			return c.json({ id: result.id }, 201);
		},
	)

	/**
	 * Tidy an entry off the shelf, or bring it back.
	 *
	 * Separate from DELETE on purpose: for a purchased Work this is the *only* control,
	 * and conflating the two would put "remove" on a button that must never remove.
	 */
	.patch(
		"/library/:id",
		requireAuth,
		zValidator("json", z.object({ hidden: z.boolean() })),
		async (c) => {
			const user = c.get("user");
			const id = parseNumericId(c.req.param("id"));
			if (id == null) return c.json({ error: "Not found" }, 404);
			const ok = await setHidden(user.id, id, c.req.valid("json").hidden);
			return ok ? c.json({ success: true }) : c.json({ error: "Not found" }, 404);
		},
	)

	/**
	 * Un-save.
	 *
	 * 🚨 **Refuses a purchased Work**, with `409` and the alternative named. Somebody who
	 * tidies a purchase off their shelf and cannot work out how to get it back has
	 * effectively lost the thing they paid for, so the control they get is *hide*, which
	 * is reversible and loses nothing.
	 */
	.delete("/library/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = parseNumericId(c.req.param("id"));
		if (id == null) return c.json({ error: "Not found" }, 404);

		const result = await removeItem(user.id, id);
		if (result.ok) return c.body(null, 204);
		if (result.reason === "purchased") {
			return c.json(
				{
					error: "You bought this, so it stays in your Library. You can hide it instead.",
					reason: "purchased",
				},
				409,
			);
		}
		return c.json({ error: "Not found" }, 404);
	});

export { contentRoutes };

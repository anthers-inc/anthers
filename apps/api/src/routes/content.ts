// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes — the creator's **Catalog** of Works, and their feed of **Posts**.
 *
 * A **Work** (`works`) is the unit of published creative work: a game, a video, a track,
 * an image, an essay, software, a physical good, a service. It OWNS its source media,
 * downloadable variants (`work_assets`) and transcodes (`work_transcoding_jobs`), and it carries its
 * own visibility, dates, delivery switches and access gates. Processing runs once on
 * upload to the Catalog, before the Work is released or referenced anywhere. A Work can be
 * released, gated, purchased and consumed with **no Post ever existing**.
 *
 * A **Post** is an announcement — rich text, links and body-embedded images, and nothing
 * else. It **embeds** Works by carrying their public link in the body (nothing is stored;
 * the card derives from the body at read time — `lib/post-work-links.ts`), and the embed
 * is **inert: it confers no access whatsoever.** A Post may freely embed a Work its user
 * cannot open, and one another creator made. Projects are Projects that group Works and
 * Posts via many-to-many joins.
 *
 * Both are addressed by a durable numeric `publicId`; the canonical URLs are
 * `/posts/{slug}-{publicId}` and `/works/{slug}-{publicId}`, and a route param of either
 * the bare publicId or the slug-publicId form resolves the same row (slug alone works too).
 *
 * See the wiki's *Publishing*.
 */

import { db } from "@anthers/db/client";
import {
	comments,
	posts,
	projectItems,
	purchases,
	reviews,
	votes,
	workAssets,
	workBuildFiles,
	workBuilds,
	workCaptionTracks,
	workPages,
	workSections,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import {
	embedUrlProblem,
	isListened,
	processingFor,
	supportsPreviewMedia,
} from "@anthers/shared/content";
import { requiresAdultVerification } from "@anthers/shared/content-rating";
import { dailyCapFor, type LimitWindow, spentWindow } from "@anthers/shared/parental-controls";
import type { PublicAccessBudget } from "@anthers/shared/public-access";
import {
	isVoteDirection,
	VOTE_MAX_PER_WINDOW,
	VOTE_WINDOW_MS,
	type VoteDirection,
	type VoteTally,
} from "@anthers/shared/votes";
import { and, desc, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { JOB_OPTIONS, QUEUE_BY_MEDIA_TYPE, QUEUES, queue } from "../jobs/queue.js";
import { refreshQueuePositions } from "../jobs/queue-position.js";
import { routePagedIngest } from "../lib/paged-ingest.js";
import { pgWorkEmbedPattern } from "../lib/post-work-links.js";
import { getOptionalUserId } from "../middleware/auth.js";
import {
	type AccessContext,
	type AccessibleWork,
	buildAccessContext,
	buildPreviewContext,
	resolveAccessSync,
} from "../services/access.js";
import { isSuspendedAccount } from "../services/account-visibility.js";
import { recordUrlFor } from "../services/atproto-repo.js";
import type { CaptionTrackRow, PreviewCaptionTrackRow } from "../services/captions.js";
import { adultVisibility, maturityHiddenFrom } from "../services/content-preferences.js";
import { creditsForOwner, creditsForUser } from "../services/credit-acceptance.js";
import {
	consumedSeconds,
	parentalHiddenFrom,
	parentalPolicyFor,
	parentalVisibility,
} from "../services/parental-controls.js";
import { loadPublicAccessBudget, loadShareLinkBudget } from "../services/public-access.js";
import { resolveShareToken } from "../services/share-links.js";
import { isLocalStorage, storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";
import { resolveThumbnailUrl } from "../services/thumbnails.js";
import type { PreviewMediaRow } from "../services/work-preview-media.js";
import { listSourceFiles } from "../services/work-source-files.js";

import { requireUserOrShareLink } from "./content/access.js";

export { requireUserOrShareLink };

import type {
	AssetRow,
	TranscodingJobRow,
	VoteSubject,
	WebBuildWithFiles,
	WorkRow,
} from "./content/schemas.js";

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
 * Applied to: whether a comment can be voted on or replied to, the rating aggregate on
 * the reviews endpoint, and the rating aggregate embedded in post detail. Every public
 * count of either is derived from those. ⚠️ **The comment thread is the exception**: it
 * reads hidden rows too, because a removed comment with replies beneath it is drawn as
 * a gap, and `listComments` builds that gap from the id, subject and time alone. Deliberately NOT applied to a user's own `userRating` —
 * the star they see should be the star they actually submitted, and re-rating
 * only overwrites the score, so a hidden rating stays hidden.
 */
export const visibleComment = eq(comments.moderationStatus, "visible");
export const visibleReview = eq(reviews.moderationStatus, "visible");

/**
 * A per-account cap on how fast votes can be cast.
 *
 * ⚠️ **Best-effort, in-memory and per-instance, exactly as the abuse-report cap is.** What
 * it buys is that one scripted account cannot walk a whole thread in a second. 🚨 **It does
 * nothing about the threat that actually matters** — many accounts arriving together — and
 * saying so is better than a number that implies brigading was handled. The unique index
 * bounds one person on one item; the collapse threshold is the only place a coordinated
 * group can do lasting damage, and that is where the defense has to get real.
 *
 * It fails CLOSED, unlike the abuse-report cap: the cost of dropping a like is nothing, and
 * this route is authenticated so there is always a key.
 */
export const REACTION_CAPS = new Map<number, number[]>();

export function tooManyVotesFrom(userId: number): boolean {
	const now = Date.now();
	const recent = (REACTION_CAPS.get(userId) ?? []).filter((at) => now - at < VOTE_WINDOW_MS);
	if (recent.length >= VOTE_MAX_PER_WINDOW) {
		REACTION_CAPS.set(userId, recent);
		return true;
	}
	recent.push(now);
	REACTION_CAPS.set(userId, recent);
	// Bounded, so a long-running process cannot keep a key per account ever seen. Dropping
	// the map only ever forgives.
	if (REACTION_CAPS.size > 5000) {
		for (const [key, at] of REACTION_CAPS) {
			if (at.length === 0 || now - at[at.length - 1] > VOTE_WINDOW_MS) REACTION_CAPS.delete(key);
		}
	}
	return false;
}

/**
 * Whether there is something there to react to.
 *
 * ⚠️ **A hidden comment is not reactable**, because a user cannot see it — accepting a
 * vote on one would let a caller both discover that it exists and move a score nobody
 * can read. Moderation state is checked here for the same reason every public read checks
 * it, and forgetting it is the quiet version of the same bug.
 */
export async function votableExists(subjectType: VoteSubject, subjectId: number): Promise<boolean> {
	if (subjectType === "comment") {
		const [row] = await db
			.select({ id: comments.id })
			.from(comments)
			.where(and(eq(comments.id, subjectId), visibleComment))
			.limit(1);
		return Boolean(row);
	}
	if (subjectType === "review") {
		const [row] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(and(eq(reviews.id, subjectId), visibleReview))
			.limit(1);
		return Boolean(row);
	}
	const [row] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(eq(posts.id, subjectId))
		.limit(1);
	return Boolean(row);
}

/**
 * What a vote may be attached to: a post, a comment, or a review.
 *
 * A Work is reviewed, never voted on — its aggregate is the reviews' verdicts, so a
 * second opinion channel on the same subject would be two answers to one question. A
 * review, by contrast, is a person's statement rather than a thing, and other users
 * mark it helpful the same way they vote a comment up: one vote record, one gesture.
 * Helpfulness *sorts* the review list and never weights the aggregate — see
 * `recommendedPercent` in `@anthers/shared/content`.
 */

export const NO_VOTES: VoteTally = { up: 0, down: 0 };

/**
 * The vote the author of a post, a comment or a review is taken to have cast on their own
 * thing, written when the thing is created.
 *
 * ⭐ **Reddit's rule, applied uniformly** (Parker, 2026-09-21): writing something at all is
 * the author saying it is worth reading, so it starts at 1 rather than 0, and a net of 0
 * then always means at least one user moved it down rather than ambiguity between "nobody
 * voted" and "the one voter went home". The row is an ordinary vote — same unique index,
 * same record sync — so withdrawing it or flipping it to down is just the vote route.
 *
 * ⚠️ Written best-effort AFTER the thing exists, not in its transaction: the row must never
 * be why creating a post, comment or review fails. The unique index makes a double-write
 * a no-op, so `onConflictDoNothing` rather than an upsert — there is nothing to flip.
 */
export async function authorUpvote(subjectType: VoteSubject, subjectId: number, userId: number) {
	try {
		await db
			.insert(votes)
			.values({ userId, subjectType, subjectId, direction: "up" })
			.onConflictDoNothing();
	} catch (error) {
		console.error(`author upvote on ${subjectType} ${subjectId} failed:`, error);
	}
}

/**
 * Refusal returned when a credit names a contributor whose rejection is already on file.
 */
export const REJECTED_CREDIT_REFUSAL = {
	error: "This credit was rejected by the contributor and can't be added again.",
	code: "credit_rejected",
} as const;

/**
 * The upvote and downvote totals for a set of subjects, plus the user’s own vote.
 *
 * ⭐ **Aggregated on read rather than kept in a counter column.** A denormalized count is
 * two writes that can disagree, and the disagreement is invisible — a score drifting from
 * its rows looks exactly like a score. At the size of one thread this is a grouped scan of
 * an indexed table, and the moment that stops being true is the moment to add a counter
 * *and* something that checks it.
 *
 * ⚠️ **A tally is absent, not zero, when nobody has reacted.** Callers use `NO_VOTES`,
 * so a subject nobody touched and a subject whose votes all canceled read the same —
 * which is correct, because the published score of both is 0.
 */
export async function voteTallies(
	subjectType: VoteSubject,
	subjectIds: number[],
	userId: number | null,
): Promise<{ tallies: Map<number, VoteTally>; mine: Map<number, VoteDirection> }> {
	const tallies = new Map<number, VoteTally>();
	const mine = new Map<number, VoteDirection>();
	if (subjectIds.length === 0) return { tallies, mine };

	const scope = and(eq(votes.subjectType, subjectType), inArray(votes.subjectId, subjectIds));

	const rows = await db
		.select({
			subjectId: votes.subjectId,
			up: sql<number>`count(*) filter (where ${votes.direction} = 'up')`.mapWith(Number),
			down: sql<number>`count(*) filter (where ${votes.direction} = 'down')`.mapWith(Number),
		})
		.from(votes)
		.where(scope)
		.groupBy(votes.subjectId);
	for (const r of rows) tallies.set(r.subjectId, { up: r.up, down: r.down });

	// A signed-out user has no vote to show, and asking for one costs a query that
	// can only come back empty.
	if (userId !== null) {
		const own = await db
			.select({ subjectId: votes.subjectId, direction: votes.direction })
			.from(votes)
			.where(and(scope, eq(votes.userId, userId)));
		for (const r of own) {
			if (isVoteDirection(r.direction)) mine.set(r.subjectId, r.direction);
		}
	}
	return { tallies, mine };
}

export function estimateReadMinutes(text: string): number {
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.ceil(wordCount / 200));
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Derive a slug that's unique per the given existence check, suffixing on collision. */
export async function makeUniqueSlug(
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

export async function workSlugExists(slug: string, exceptId?: number): Promise<boolean> {
	const [row] = await db
		.select({ id: works.id })
		.from(works)
		.where(
			exceptId != null ? and(eq(works.slug, slug), ne(works.id, exceptId)) : eq(works.slug, slug),
		)
		.limit(1);
	return !!row;
}

/**
 * Allocate an unused 9-digit public id (Patreon-style durable key).
 *
 * Posts and Works keep separate id spaces — they are different things at different URLs,
 * and forcing one shared space would only add contention.
 */
export async function makeUniquePublicId(table: typeof posts | typeof works): Promise<number> {
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
export function parsePublicParam(param: string): { publicId: number | null; slug: string } {
	if (/^\d+$/.test(param)) return { publicId: Number(param), slug: param };
	const m = param.match(/-(\d{6,})$/);
	if (m) return { publicId: Number(m[1]), slug: param };
	return { publicId: null, slug: param };
}

/** Resolve the full post row from a route param (publicId preferred, slug fallback). */
export async function findPostRow(param: string): Promise<typeof posts.$inferSelect | null> {
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
export async function findWorkRow(param: string): Promise<typeof works.$inferSelect | null> {
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
export async function queueTranscodeForWork(item: WorkRow): Promise<TranscodingJobRow | null> {
	const processing = processingFor(item.type);
	if (processing === "video" && item.sourceKey) {
		const [job] = await db
			.insert(workTranscodingJobs)
			.values({ workId: item.id, mediaType: "video", status: "pending" })
			.returning();
		// The lane's own queue resolves by the row's media type (`QUEUE_BY_MEDIA_TYPE`), and
		// the lane's order is a record (queue-position.ts), written at every transition —
		// enqueue here, claim/settle in the handler, cancel in its route.
		const mediaQueue = QUEUE_BY_MEDIA_TYPE.video;
		if (!mediaQueue) throw new Error("video has no queue to ride");
		await queue.send(mediaQueue, { jobId: job.id }, JOB_OPTIONS[mediaQueue]);
		await refreshQueuePositions();
		return job;
	}
	if (processing === "ebook" && item.sourceKey) {
		// The row routes by composition, exactly as `askRerender` does: an EPUB set
		// extracts (`ingest-ebook`), every other set renders as fixed pages. A set that
		// routes nowhere is recorded failed, legibly, rather than thrown out of a create
		// the creator is mid-way through.
		const [job] = await db
			.insert(workTranscodingJobs)
			.values({ workId: item.id, mediaType: "ebook", status: "pending" })
			.returning();
		try {
			const route = routePagedIngest(await listSourceFiles(item));
			const queueName = route === "ingest-ebook" ? QUEUES.INGEST_EBOOK : QUEUES.RENDER_PAGED;
			await queue.send(queueName, { jobId: job.id }, JOB_OPTIONS[queueName]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await db
				.update(workTranscodingJobs)
				.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
				.where(eq(workTranscodingJobs.id, job.id));
			return { ...job, status: "failed", errorMessage: message };
		}
		return job;
	}
	if (processing === "audio" && item.sourceKey) {
		const [job] = await db
			.insert(workTranscodingJobs)
			.values({ workId: item.id, mediaType: "audio", status: "pending" })
			.returning();
		const mediaQueue = QUEUE_BY_MEDIA_TYPE.audio;
		if (!mediaQueue) throw new Error("audio has no queue to ride");
		await queue.send(mediaQueue, { jobId: job.id }, JOB_OPTIONS[mediaQueue]);
		await refreshQueuePositions();
		return job;
	}
	return null;
}

/** A single-frame extraction reads only up to the paused moment and encodes one frame —
 *  seconds, not minutes. The timeout exists so a wedged reader (an unreachable storage
 *  address) fails the request instead of hanging it. */
export const FRAME_EXTRACT_TIMEOUT_MS = 20_000;

/**
 * Thumbnails render directly as <img src>; older rows stored a bare storage key instead
 * of a URL — `resolveThumbnailUrl` turns those into public URLs in place (new uploads
 * already store URLs), and lives in `services/thumbnails.ts` because search resolves the
 * same covers.
 */
export async function resolveWorkThumbnail(item: WorkRow): Promise<void> {
	item.thumbnail = await resolveThumbnailUrl(item.thumbnail);
}

/**
 * Resolve the Projects whose thumbnail is one of their Works.
 *
 * ⭐ **A Project's thumbnail-by-Work is a reference, not a copy** (`projects.thumbnail_work_id`):
 * the Project follows the Work's own thumbnail, and the Work's visibility and rating decide
 * whether that thumbnail is shown here. A Work hidden from this viewer — private or withdrawn
 * to a stranger, Adult-rated to somebody who has not opted in, blocked by a guardian —
 * contributes no thumbnail at all, so the Project falls back to its uploaded `thumbnail`
 * rather than leaking the thing the viewer may not see.
 *
 * ⚠️ **Membership is part of the query, not an assumption about the write path.** A Project's
 * thumbnail Work must be in its list; joining through `project_items` means a row left behind
 * by a removal or a bug can never dress the Project in a Work it does not hold.
 *
 * `seeAll` is the owner's own read: their drafts and every rung are theirs to edit, the same
 * exception every other owner-facing listing makes.
 */
export async function resolveProjectThumbnails(
	rows: { id: number; thumbnailWorkId: number | null; thumbnail: string | null }[],
	options: { userId: number | null; seeAll: boolean },
): Promise<Map<number, string>> {
	const thumbnails = new Map<number, string>();
	if (rows.length === 0) return thumbnails;

	const wanted = rows.filter((row) => row.thumbnailWorkId != null);
	if (wanted.length === 0) return thumbnails;

	const conditions: SQL[] = [
		inArray(
			projectItems.projectId,
			wanted.map((row) => row.id),
		),
	];
	if (!options.seeAll) {
		const [{ prefs }, { policy }] = await Promise.all([
			adultVisibility(options.userId),
			parentalVisibility(options.userId),
		]);
		conditions.push(
			options.userId != null
				? (or(eq(works.visibility, "released"), eq(works.creatorId, options.userId)) as SQL)
				: eq(works.visibility, "released"),
		);
		conditions.push(
			and(
				maturityHiddenFrom(
					prefs,
					options.userId,
					sql`works.creator_id`,
					sql`works.maturity`,
					sql`works.maturity_rows`,
				),
				parentalHiddenFrom(policy, options.userId, sql`works.creator_id`, sql`works.type`),
			) as SQL,
		);
	}

	const thumbnailRows = await db
		.select({ projectId: projectItems.projectId, workId: works.id, thumbnail: works.thumbnail })
		.from(projectItems)
		.innerJoin(works, eq(projectItems.workId, works.id))
		.where(and(...conditions));

	// The list may hold several Works; only the chosen one dresses the Project.
	const chosenByProject = new Map(wanted.map((row) => [row.id, row.thumbnailWorkId] as const));
	await Promise.all(
		thumbnailRows
			.filter((row) => chosenByProject.get(row.projectId) === row.workId)
			.map(async (row) => {
				const url = await resolveThumbnailUrl(row.thumbnail);
				if (url) thumbnails.set(row.projectId, url);
			}),
	);
	return thumbnails;
}

/**
 * The facts a link preview may show about one Work, for an anonymous reader.
 *
 * 🚨 **Anonymous is the whole caller set, and that is a property of the surface rather
 * than a limitation.** A crawler unfolds a URL with no session, so the owner branch, the
 * withdrawn-purchaser branch and the reader's opt-in have no subject to consult — a Work
 * that is not `released`, is Adult-rated, or belongs to a suspended creator is absent,
 * exactly as it is from the page. `null` here becomes the same 404 the page answers,
 * never a differently-worded one that would leak the state.
 *
 * ⚠️ **This read must not count a view.** `GET /works/:id` increments `viewCount`
 * fire-and-forget for everybody but the owner; an unfurl is not a view, and every chat,
 * feed and search crawler asking for a card would otherwise inflate it. Nothing here
 * writes.
 */
export async function publicWorkCard(param: string) {
	const work = await findWorkRow(param);
	if (!work) return null;
	if (work.visibility !== "released") return null;
	if (requiresAdultVerification(work.maturity)) return null;
	if (work.creatorId != null && (await isSuspendedAccount(work.creatorId))) return null;
	await resolveWorkThumbnail(work);
	return {
		title: work.title,
		description: work.description,
		thumbnail: work.thumbnail,
		maturity: work.maturity,
	};
}

/**
 * Serialize a library content item (owner-facing: full media keys + latest transcode).
 *
 * ⚠️ Async, and the credits are why: the owner's own serialization still runs the credit
 * overlay (`creditsForOwner`), so a creator editing a Work that names an on-network identity
 * can see which credits are still awaiting that person's confirmation. The overlay keeps the
 * stored contributor EXACTLY as written — the Studio edit form round-trips this field
 * verbatim on save, so resolving an identity to its rendered name here would overwrite the
 * stored DID and destroy the acceptance linkage. The flags are the only thing added.
 */
export async function serializeWork(
	item: WorkRow,
	workAssets: AssetRow[] = [],
	job: TranscodingJobRow | null = null,
	/** The Work's browser builds, owner-facing. Loaded by `loadWorkBundles`; empty when unset. */
	webBuildsList: WebBuildWithFiles[] = [],
	/**
	 * The delivery context the response is being built in — null under local storage,
	 * where the stored key is itself the playable address.
	 */
	delivery: DeliveryCtx | null = null,
	/** The Work's caption tracks, for the Studio's editor; empty when the caller did not load them. */
	captions: CaptionTrackRow[] = [],
	/**
	 * The counts behind the Studio's Reviews column. Only the owner's own Works listing
	 * computes them — it is the one surface that shows the column — so every other caller
	 * omits the argument and the serialization carries no `reviewCounts` key at all.
	 */
	reviewCounts?: { recommended: number; notRecommended: number },
	/** The Work's storefront preview set, owner-facing — empty when the caller did not load it. */
	previews: PreviewMediaRow[] = [],
	/** Each trailer's caption tracks, keyed by preview id — loaded with the previews. */
	previewCaptions: Map<number, PreviewCaptionTrackRow[]> = new Map(),
) {
	// The image set, in order — an image Work's gallery is its source-set table read
	// back (`listSourceFiles` falls back to the legacy column as the one-file set), and
	// the owner shape carries it ungated like the row it edits.
	const gallery = item.type === "image" ? (await listSourceFiles(item)).map((f) => f.file) : [];
	return {
		id: item.id,
		publicId: item.publicId,
		slug: item.slug,
		creatorId: item.creatorId,
		type: item.type,
		title: item.title,
		description: item.description,
		thumbnail: item.thumbnail,
		/** Owner-facing only: the whole upload the thumbnail was framed from. Never public. */
		thumbnailSource: item.thumbnailSource,
		/** Owner-facing: the window the dialog reopens at. */
		thumbnailCrop: item.thumbnailCrop,
		scheduledReleaseAt: item.scheduledReleaseAt,
		sourceKey: item.sourceKey,
		// The owner's own original, at the access-checked route, for the same ruling the
		// user shape carries (70.06 — playable from the moment the Work exists): an
		// owner previews their video — and, since 2026-10-16, their track — before any
		// processed deliverable exists, so the Studio needs this address the way a
		// viewer's play page does. Without a delivery context, the stored key is
		// already the playable address.
		originalUrl:
			(item.type === "video" || isListened(item.type)) && item.sourceKey
				? delivery
					? withShare(`${delivery.origin}/api/content/works/${item.id}/original`, delivery)
					: item.sourceKey
				: null,
		// The owner's own shape is also what the Work page renders for them, so a stored address the
		// check refuses is withheld here too rather than framed in the creator's own session.
		embedUrl: embedUrlProblem(item.embedUrl ?? "") ? "" : item.embedUrl,
		durationSeconds: item.durationSeconds,
		body: item.body,
		bodyHtml: item.bodyHtml,
		// Owner-facing, so ungated — this is the shape the Studio editor loads to edit.
		lyrics: item.lyrics,
		imageAlt: item.imageAlt,
		// The image Work's set, ordered; other kinds carry nothing here.
		gallery,
		estimatedReadMinutes: item.estimatedReadMinutes,
		note: item.note,
		visibility: item.visibility,
		releasedAt: item.releasedAt,
		maturity: item.maturity,
		maturityNotes: item.maturityNotes ?? [],
		/** The rating matrix as its creator marked it; a row absent from it is unanswered. */
		maturityRows: item.maturityRows ?? {},
		/** Whether an operator set the rating — what tells the creator an appeal is the route. */
		maturityLocked: item.maturitySource === "operator",
		originallyReleased: item.originallyReleased,
		streamEnabled: item.streamEnabled,
		downloadEnabled: item.downloadEnabled,
		access: item.access,
		// Owner-facing overlay: everything the creator wrote, with the credits that name an
		// unconfirmed on-network identity flagged as awaiting that person's confirmation.
		credits: await creditsForOwner(item),
		isPinned: item.isPinned,
		tags: item.tags,
		websiteUrl: item.websiteUrl,
		sourceUrl: item.sourceUrl,
		viewCount: item.viewCount,
		downloadCount: item.downloadCount,
		// Owner-facing and listing-only: the Reviews column's numbers, where the caller
		// asked for them. Omitted entirely elsewhere, so no other shape has to explain them.
		...(reviewCounts ? { reviewCounts } : {}),
		/** When the current media version was added — the date the Work's page shows. */
		versionAddedAt: item.versionAddedAt,
		/** The current version's name, or empty when its creator left it unnamed. */
		versionLabel: item.versionLabel,
		/** The UPLOAD date. Creator-facing only — the public sees originallyReleased and releasedAt. */
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		assets: workAssets,
		webBuilds: webBuildsList,
		transcoding: job,
		// The owner's caption tracks, ungated here — this shape is what the Studio edits —
		// with the play-facing URLs built the way the user shape builds them. Full rows,
		// not the reader's slim objects: the editor shows size and cue count, which say
		// something about what was uploaded that the play menu has no use for.
		captions:
			item.type !== "video"
				? []
				: captions.map((t) => ({
						...t,
						url: buildCaptionUrl(delivery ?? localDelivery, item.id, t.id),
					})),
		// The storefront's preview set, ungated for the owner — this is the shape the Manage
		// tab edits. A kind that does not take previews carries an empty list rather than a
		// missing field, so the editor's branch is one shape.
		previewMedia: supportsPreviewMedia(item.type)
			? previews.map((p) =>
					serializePreviewMedia(
						p,
						item.id,
						delivery ?? localDelivery,
						previewCaptions.get(p.id) ?? [],
					),
				)
			: [],
		/**
		 * The Work's listing on the network while it has one, and the public record link
		 * beside it — every reader who can see the Work sees it too (the record is public
		 * anyway). The link is a pure function of the stored address, so it costs no
		 * lookup. Null for a Work with no listing, which is ordinary rather than a fault.
		 */
		atprotoUri: item.atprotoUri,
		recordUrl: recordUrlFor(item.atprotoUri),
	};
}

/**
 * Whether a creator's request names a rating rather than answering the matrix.
 *
 * 🚨 **Refused, not ignored.** A creator rates a Work by answering every row of its matrix, with
 * no exceptions (Parker, 2026-09-18), so a request carrying `maturity` or `maturityNotes` is
 * asking for something that is not offered. Stripping the fields would answer a request that
 * meant to rate a Work with a Work still unrated and a 200, which is a save that appears to work
 * and does not. An operator's correction has its own route and is unaffected.
 */
export function namesARating(data: { maturity?: unknown; maturityNotes?: unknown }): boolean {
	return data.maturity !== undefined || data.maturityNotes !== undefined;
}

export const RATING_BY_NAME_REFUSAL = {
	error: "A Work is rated by answering every row of its rating matrix, not by naming a rating.",
	code: "rate_through_matrix",
} as const;

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
 * A Work's posting history — where it has been announced, and when. This is the record
 * Parker asked for: "a clean record of when the content has been posted". Carries the
 * post date, since a Work may be posted many times over its life. Derived from the post
 * bodies' own work links (`pgWorkEmbedPattern`) — a post is not asked to store anything,
 * so "has it been posted" reads what the post actually says.
 */
export async function postsUsingWork(workId: number): Promise<
	Array<{
		slug: string;
		title: string | null;
		isPublished: boolean;
		postedAt: Date | null;
	}>
> {
	const [work] = await db
		.select({ publicId: works.publicId })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return [];
	return await db
		.selectDistinct({
			slug: posts.slug,
			title: posts.title,
			isPublished: posts.isPublished,
			postedAt: posts.publishedAt,
		})
		.from(posts)
		.where(sql`${posts.body} ~ ${pgWorkEmbedPattern(work.publicId)}`);
}

/**
 * Where a Work's media should be delivered from. When set, a completed transcode's
 * stored URL is rewritten to the matching access-checked endpoint — signed HLS for
 * video, a signed redirect for audio — instead of a raw CDN URL. Stored media is
 * private, so the raw URL 403s; the endpoints are how an entitled user actually
 * plays it. Null in local dev, where /content serves everything unsigned.
 *
 * The post slug used to be part of this, because delivery was reached *through* a post
 * and each endpoint had to re-check that the item it was handed actually belonged to the
 * post being used to reach it — otherwise one accessible post unlocked every item on the
 * platform. Gates live on the Work now, so the Work addresses itself and that entire
 * class of cross-reference check disappears with the indirection that created it.
 */
export interface DeliveryCtx {
	origin: string;
	/**
	 * The **share token** this request arrived with, if any — carried onto every media URL
	 * the server builds.
	 *
	 * 🚨 **It has to travel on the URL, because the things that fetch these cannot be told
	 * anything else.** An `<img>`, an `<audio src>` and hls.js all issue their own requests
	 * with no way for the page to attach a header, so a recipient with no session would
	 * otherwise be handed a set of URLs that 401 the moment the player touched them. The
	 * token is a locator, not a credential, so putting it in a URL grants nothing that
	 * following the link did not already grant.
	 */
	share?: string | null;
}

/** Appends the share token, when the request rode one in. */
export function withShare(url: string, ctx: DeliveryCtx): string {
	return ctx.share ? `${url}?share=${encodeURIComponent(ctx.share)}` : url;
}

/** URL of the access-checked HLS master for a video Work. */
export function buildHlsManifestUrl(
	ctx: DeliveryCtx,
	workId: number,
	file = "master.m3u8",
): string {
	return withShare(`${ctx.origin}/api/content/works/${workId}/hls/${file}`, ctx);
}

/** URL of the access-checked audio endpoint for an audio Work. */
export function buildAudioUrl(ctx: DeliveryCtx, workId: number): string {
	return withShare(`${ctx.origin}/api/content/works/${workId}/audio`, ctx);
}

/**
 * URL of the access-checked caption route for one track. Unlike media URLs, the caption
 * route is the address in every mode — there is no bucket URL to fall back to, because a
 * local-mode key is not a playable address the way a small file's is. Local mode answers
 * `publicOrigin()`, which is same-origin, so the `<track>` fetch carries the session.
 */
export function buildCaptionUrl(ctx: DeliveryCtx, workId: number, trackId: number): string {
	return withShare(`${ctx.origin}/api/content/works/${workId}/captions/${trackId}`, ctx);
}

/**
 * The delivery context the local-mode serialization falls back to for caption and preview
 * URLs.
 *
 * `BASE_URL` is the API's own externally reachable origin in a session (`session.ts` sets
 * it), while `publicOrigin()` is the SPA's dev default of `:3000`. A browser session runs
 * the API on its own free port, so falling back to the SPA default would hand `<img>` and
 * `<track>` the wrong origin — the page would fetch `:3000` and get nothing.
 */
export const localDelivery: DeliveryCtx = {
	origin: (process.env.BASE_URL ?? publicOrigin()).replace(/\/+$/, ""),
};

/**
 * URL of the reachability-checked preview route for one storefront item. Like the caption
 * route, this endpoint is the address in every mode: preview media is private and no bucket
 * URL may stand in for it.
 */
export function buildPreviewUrl(ctx: DeliveryCtx, workId: number, previewId: number): string {
	return withShare(`${ctx.origin}/api/content/works/${workId}/previews/${previewId}`, ctx);
}

/** URL of a trailer's caption route, reachability-checked with the preview it belongs to. */
export function buildPreviewCaptionUrl(
	ctx: DeliveryCtx,
	workId: number,
	previewId: number,
	trackId: number,
): string {
	return withShare(
		`${ctx.origin}/api/content/works/${workId}/previews/${previewId}/captions/${trackId}`,
		ctx,
	);
}

/** One trailer caption track — the same shape the Work's own editor reads. */
export function serializePreviewCaptionRow(
	row: PreviewCaptionTrackRow,
	workId: number,
	previewId: number,
	ctx: DeliveryCtx,
) {
	return {
		id: row.id,
		language: row.language,
		label: row.label || row.language,
		kind: row.kind,
		url: buildPreviewCaptionUrl(ctx, workId, previewId, row.id),
		byteSize: row.byteSize,
		cueCount: row.cueCount,
	};
}

/** One preview item as the carousel needs it: its id, kind, alt, delivery URL and captions. */
export function serializePreviewMedia(
	preview: PreviewMediaRow,
	workId: number,
	ctx: DeliveryCtx,
	captions: PreviewCaptionTrackRow[] = [],
) {
	return {
		id: preview.id,
		kind: preview.kind === "video" ? ("video" as const) : ("image" as const),
		alt: preview.alt,
		url: buildPreviewUrl(ctx, workId, preview.id),
		...(preview.kind === "video"
			? { captions: captions.map((t) => serializePreviewCaptionRow(t, workId, preview.id, ctx)) }
			: {}),
	};
}

/**
 * A transcode row as a *user* may see it.
 *
 * `hlsManifestUrl` and `outputFileUrl` point at the deliverable, so they follow the
 * same rule as `sourceKey` and asset files: handed out only when the user has
 * access. Everything else — status, progress, ETA, error, waveform — stays, so a
 * locked post still renders "Processing…" instead of an empty frame.
 *
 * For a user who *does* have access the URLs are rewritten to the access-checked
 * delivery routes. That rewrite is not a nicety: stored media is private, so a raw
 * CDN URL would 403 even for someone entitled to it.
 */
export function userTranscoding(
	job: TranscodingJobRow | null,
	canAccess: boolean,
	delivery: DeliveryCtx | null,
): Promise<TranscodingJobRow | null> {
	// See the async boundary below: the rendition check is the only lookup in here.
	return (async () => {
		if (!job) return null;
		if (!canAccess)
			return { ...job, hlsManifestUrl: null, audioManifestUrl: null, outputFileUrl: null };
		// ⭐ Whether the tree plays: a completed row always has (its completion write
		// named the master), and — publish-early, 2026-10-18 — so does a row whose
		// ladder's first rung is up (`playableAt` written at that rung's upload) even
		// though the tall rungs still encode. Every branch below keys on this pair;
		// a still-encoding ladder has one rung in the master, and HLS degrades.
		const playable = job.status === "completed" || job.playableAt != null;
		if (!playable) {
			// The tree is not up a rung yet (still early, failed, canceled): the row's
			// URLs are whatever the run wrote, which for a non-playable video is
			// nothing, and the player state reads that.
			return job;
		}
		if (!delivery) {
			// No delivery context means local storage, where every object is served
			// unsigned — the row's URLs are already the playable ones. The audio
			// rendition still has to be reported, or the Podcast-This row never renders
			// in a dev browser at all; its URL is the manifest's sibling, same shape as
			// the raw storage URL the row already carries.
			if (job.mediaType === "video" && job.hlsManifestUrl) {
				const prefixKey = urlToKey(job.hlsManifestUrl).replace(/\/[^/]+$/, "");
				const hasAudioRendition = await storage.exists(`${prefixKey}/audio.m3u8`);
				if (hasAudioRendition) {
					return {
						...job,
						audioManifestUrl: job.hlsManifestUrl.replace(/[^/]+$/, "audio.m3u8"),
					};
				}
			}
			return job;
		}

		if (job.mediaType === "video" && job.hlsManifestUrl) {
			// The audio-only rendition rides the same access-checked route. Its URL is
			// serialized only when the rendition genuinely exists — a video transcoded
			// before the job produced one has an `audio.m3u8` that 404s, and reporting it
			// anyway would draw a Podcast-This affordance that plays nothing. (A ladder
			// still filling in has no rendition yet, and the same null is right.)
			const prefixKey = urlToKey(job.hlsManifestUrl).replace(/\/[^/]+$/, "");
			const hasAudioRendition = await storage.exists(`${prefixKey}/audio.m3u8`);
			return {
				...job,
				hlsManifestUrl: buildHlsManifestUrl(delivery, job.workId),
				audioManifestUrl: hasAudioRendition
					? buildHlsManifestUrl(delivery, job.workId, "audio.m3u8")
					: null,
			};
		}
		if (job.mediaType === "audio" && job.outputFileUrl) {
			return { ...job, outputFileUrl: buildAudioUrl(delivery, job.workId) };
		}
		return job;
	})();
}

/** Parse an `:id` path param, rejecting anything that isn't a positive integer. */

export const PREVIEW_UNLOCKED_GIVEN = 1_000_000;

export function previewRequest(c: {
	req: { query: (k: string) => string | undefined };
}): { given: number | null; owned: boolean } | null {
	// 🚨 `?previewAs=` gives an EMPTY STRING, not undefined — and `Number("")` is **0**,
	// which passes every range check below. So the obvious `raw == null` guard alone reads
	// a blank parameter as "preview as a user giving nothing" and quietly locks a
	// creator out of their own page. Second time this exact trap has bitten; the first was
	// `Number(localStorage.getItem(...))` defaulting the remembered volume to silence.
	// Treat empty as absent, always.
	const raw = c.req.query("previewAs")?.trim();
	if (!raw) return null;
	// ⭐ The View As row's shapes (Parker, 2026-10-16): the imagined user is one of two,
	// Unlocked or Locked — the retired slider's dial was read by nobody, and what a
	// creator wants to see is the consequence. Unlocked has cleared every gate a
	// creator's own ladder could name (a monthly amount no real threshold exceeds, and
	// bought) and Locked has given nothing and bought nothing.
	if (raw === "unlocked") return { given: PREVIEW_UNLOCKED_GIVEN, owned: true };
	if (raw === "locked") return { given: 0, owned: false };
	if (raw === "out") return { given: null, owned: false };
	// ⚠️ **NOT `Number.isInteger`.** Amounts carry cents, so an integer check refuses a
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
 * rather than per request means a Work that somehow isn't theirs — on a shared Project, in
 * a future collab — silently resolves normally instead of resolving as somebody with a
 * different amount of access.
 */
export function contextFor(
	work: { id: number; creatorId: number | null },
	userId: number | null,
	real: AccessContext,
	preview: { given: number | null; owned: boolean } | null,
): AccessContext {
	if (!preview || userId == null || work.creatorId !== userId) return real;
	return buildPreviewContext({
		creatorId: userId,
		given: preview.given,
		owned: preview.owned,
		workIds: [work.id],
	});
}

/**
 * Who this request is for — an account, a **share link**, or nobody.
 *
 * 🚨 **A share link is scoped to ONE Work, and this is where that is enforced.** The token
 * names a Work; if the request is for a different one, the link is simply not present, so a
 * token minted for a free Work cannot be pointed at anything else on the platform.
 *
 * ⚠️ **A session always wins.** Somebody who has an account resolves on their own standing
 * and spends their own allowance, whatever link they arrived by — otherwise a link would be a
 * way to consume on somebody else's meter while signed in, and (worse) a way around the
 * recipient's own Adult opt-in.
 */
export async function requesterFor(
	c: Parameters<typeof getOptionalUserId>[0],
	workId: number,
): Promise<{ userId: number | null; sharedBy: number | null }> {
	const userId = await getOptionalUserId(c);
	if (userId != null) return { userId, sharedBy: null };

	const token = c.req.query("share");
	if (!token) return { userId: null, sharedBy: null };
	const link = await resolveShareToken(token);
	if (!link || link.workId !== workId) return { userId: null, sharedBy: null };
	return { userId: null, sharedBy: link.sharerId };
}

/**
 * Resolve the calling user's access to one Work.
 *
 * Every delivery endpoint goes through here, which is the point: access is re-resolved
 * live, per request, against the Work's own gates. Nothing is inherited from a post, a
 * project, or the URL that got the caller here — and, since 2026-08-28, nothing is inherited
 * from a share link either. A token supplies an *attribution*; the gates are unmoved.
 */
export async function workAccessFor(
	c: Parameters<typeof getOptionalUserId>[0],
	work: WorkRow,
): Promise<AccessResultLike> {
	return (await workAccessRequestFor(c, work)).access;
}

/**
 * The same resolution, with the two facts the delivery rules turn on.
 *
 * `userId` is the signed-in reader and `sharedBy` the sharer whose link the request rode.
 * The download route needs both: a share link is its own credential and needs no grant,
 * while a signed-in request must present one. Returning them beside the verdict keeps the
 * two lookups this resolver already did from being repeated by the caller.
 */
export async function workAccessRequestFor(
	c: Parameters<typeof getOptionalUserId>[0],
	work: WorkRow,
): Promise<{ access: AccessResultLike; userId: number | null; sharedBy: number | null }> {
	const { userId, sharedBy } = await requesterFor(c, work.id);
	const ctx = await buildAccessContext(userId, { workIds: [work.id], sharedBy });
	return { access: resolveAccessSync(work as AccessibleWork, ctx), userId, sharedBy };
}

/**
 * Whether this request may be served *bytes*, once access says yes.
 *
 * 🚨 **A second, account-level check that deliberately does NOT live in `resolveAccess`.**
 * A free account watches 10 hours of Public Access a month; the Public Access price
 * given to Anthers removes the limit. That is a property of the **account**, not of the Work — the
 * Work stays free to everyone either way — so encoding it as a Work-level denial is how
 * the commons quietly re-stratifies, which is exactly what this rule was
 * for. `resolveAccessSync` also has to stay pure and synchronous so a Catalog page
 * resolves a batch without an N+1, and this needs a query.
 *
 * So it sits here, at the two endpoints that actually hand over media, and only for
 * Public Access work: a gated Work the user cleared, one they bought, and their own
 * catalog are all `isFree: false` and never reach the meter.
 *
 * ⚠️ **A share-link view is metered against the SHARER's separate share-link budget**, not
 * against their ordinary allowance and not against nothing. Which budget applies is decided
 * by how the request arrived, because the two bound different things: the ten hours bound
 * what one person may watch, and the share-link hour bounds how much viewing one person may
 * fund for strangers. Metering a relay against the sharer's own hours would make sharing cost
 * them the thing the sub-pool exists to protect.
 *
 * Returns null when delivery may proceed, or the 402 body when the allowance is spent.
 */
export async function publicAccessGate(
	c: Parameters<typeof getOptionalUserId>[0],
	work: WorkRow,
	access: AccessResultLike,
): Promise<{ error: string; reason: string; budget: PublicAccessBudget } | null> {
	// Only the commons is metered. Anything reached by paying — a gate cleared, a
	// purchase — or a creator's own work is not Public Access and draws nothing.
	if (!(access.isFree && work.streamEnabled)) return null;

	const { userId, sharedBy } = await requesterFor(c, work.id);

	if (sharedBy != null) {
		const shared = await loadShareLinkBudget(sharedBy);
		if (shared.allowed) return null;
		return {
			error: "This shared link has used its viewing time for this month",
			reason: "share_link_limit",
			// The sharer's own ten hours are nobody else's business, so the recipient is told
			// what ran out without being handed a reading of somebody's account. Same shape,
			// so the players' 402 handling needs no second branch.
			budget: {
				unlimited: false,
				usedSeconds: shared.usedSeconds,
				limitSeconds: shared.limitSeconds,
				remainingSeconds: shared.remainingSeconds,
				allowed: false,
			},
		};
	}

	const budget = await loadPublicAccessBudget(userId);
	if (budget.allowed) return null;

	return {
		error: "You have used this month's free Public Access hours",
		reason: "public_access_limit",
		budget,
	};
}

/**
 * Whether a guardian's **time limit** has run out on this account.
 *
 * 🚨 **A third gate, at the same choke point and for a third reason**, and the three are
 * deliberately not merged. Access says *may you consume this Work* (a property of the Work and
 * the user's standing). The Public Access meter says *have you spent the commons' allowance*
 * (a property of the account and the commons). This says *has this household run out of time
 * today* — a property of the account and nothing else, which applies to work that was bought,
 * gated and cleared, or free alike. Collapsing any two of them would make one of the three
 * answers wrong somewhere.
 *
 * ⚠️ **403 rather than 402, and the difference is not cosmetic.** A spent allowance is "you
 * may, and here is how" — there is a price that removes it. A time limit is a refusal with no
 * price attached, and offering one would be the platform selling a way around somebody's
 * parent.
 *
 * Returns null when delivery may proceed, or the 403 body when the window is spent.
 */
export async function parentalTimeGate(
	userId: number | null,
	work: WorkRow,
): Promise<{ error: string; code: string; window: LimitWindow } | null> {
	if (userId == null) return null;
	const policy = await parentalPolicyFor(userId);
	if (!policy.enabled) return null;

	const subject = { creatorId: work.creatorId, workType: work.type };
	const cap = dailyCapFor(policy, subject);
	// Nothing to measure against — skip the query entirely, which is the common case for every
	// account that has a pin but no limits.
	if (
		cap == null &&
		policy.limits.daily == null &&
		policy.limits.weekly == null &&
		policy.limits.monthly == null
	) {
		return null;
	}

	const window = spentWindow(policy, await consumedSeconds(userId, subject), cap);
	if (!window) return null;
	return {
		error:
			window === "day"
				? "That's the time set for today. There'll be more tomorrow."
				: `That's the time set for this ${window}.`,
		code: "parental_time_limit",
		window,
	};
}

/**
 * Serialize a Work for a user, withholding the deliverable when they lack access.
 *
 * The split is the load-bearing part. Everything a *listing* needs — title, type,
 * thumbnail, duration, dates, the access verdict itself — is always present, so a locked
 * Work still renders a proper card with a working unlock prompt. Everything that IS the
 * deliverable — source key, embed URL, asset files, playable media URLs — is handed out
 * only on access. A denied user gets no pointer at the payload at all: not a signed
 * one, not an expired one, none.
 */
export async function serializeWorkForUser(
	work: WorkRow,
	workAssets: AssetRow[],
	job: TranscodingJobRow | null,
	access: AccessResultLike,
	delivery: DeliveryCtx | null,
	/**
	 * Whether this user has spent their monthly Public Access allowance.
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
	 * Who is asking to see this Work, or null for a signed-out user.
	 *
	 * 🚨 **Required, not optional, for the same reason as `allowanceSpent`.** The credits
	 * pass through the user overlay (`creditsForUser`), which withholds an unaccepted
	 * `did`-naming credit from everybody except the person it names and this Work's creator.
	 * An optional parameter would default to "nobody" — which is the signed-out answer and
	 * therefore safe for a third-party user, but silently WRONG for the two parties who
	 * must see the credit: the credited person would have no way to discover a pending
	 * credit, and the creator's own page would hide what they just saved. Every call site
	 * has to decide who is asking, and the compiler is what makes them.
	 */
	userId: number | null,
	/**
	 * How many pages an ebook has, or 0.
	 *
	 * ⚠️ The COUNT is public even when the Work is locked, and the page *keys* never are.
	 * "48 pages" is the sort of thing a locked Work has to be able to say — it is the
	 * shape of the thing, like a video's duration, which this serializer has always sent
	 * regardless of access. What it must not leak is a pointer at any page.
	 */
	pageCount = 0,
	/**
	 * How many **reflow** sections an ebook's EPUB ingest extracted, or 0 — the fixed
	 * shape's `pageCount` sibling. This is the only ingest-produced signal the reader
	 * needs to pick its view: sections exist → reflow (`work_sections`, foliate);
	 * none → fixed (`work_pages`, the page reader). Same publicity rule as `pageCount` —
	 * a count is the book's shape, never a pointer into it.
	 */
	sectionCount = 0,
	/**
	 * Whether a guardian's **time limit** has run out on this account.
	 *
	 * ⚠️ **Optional where `allowanceSpent` is required, and the asymmetry is deliberate.** A
	 * missed allowance check serves the commons free forever, which is a defect; a missed time
	 * check on a listing serves a card to somebody who cannot open the Work anyway, because
	 * the four delivery routes and this branch both refuse independently. The default is
	 * therefore the safe one at every call site that has no user to ask about — a Catalog
	 * page, a project's list, a post's references.
	 */
	timeLimited = false,
	/**
	 * Whether the Work carries a completed primary browser build — loaded with the
	 * Work by `loadWorkBundles`'s builds map, never queried per Work here (this function
	 * serializes batches; a per-Work lookup would be an N+1 on every Catalog page).
	 *
	 * Sets `webPlayable`, which gates the play button the same way `embedUrl`'s validity
	 * gates the external embed. The build's files ride nowhere in this payload.
	 */
	hasPrimaryBuild = false,
	/** Whether that primary build declared cross-origin isolation (threaded export). */
	primaryRequiresIsolation = false,
	/**
	 * The Work's caption tracks, loaded by `loadWorkBundles` — empty (never loaded) at the
	 * call sites that serialize cards and listings, where no player renders.
	 *
	 * The URL list rides `canAccess`, exactly like `originalUrl`: withheld from a user who
	 * cannot reach the Work, enforced again at the captions endpoint for whoever holds a
	 * stale URL. Withheld is an EMPTY list rather than a null field — the type is one
	 * array either way.
	 */
	captions: CaptionTrackRow[] = [],
	/**
	 * The Work's storefront preview set, loaded only by the Work detail route.
	 *
	 * 🚨 **Deliberately NOT gated on `canAccess`.** The locked viewer is this feature's
	 * audience, so the list travels beside `access` rather than behind it — and the
	 * reachability ladder the detail route already ran is what stops it reaching somebody
	 * the Work is invisible to. The delivery route enforces that ladder again per request.
	 */
	previews: PreviewMediaRow[] = [],
	previewCaptions: Map<number, PreviewCaptionTrackRow[]> = new Map(),
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
	 * else's meter would re-stratify the commons this rule keeps flat.
	 *
	 * A third, since 2026-08-28: a guardian's **time limit**, which behaves like the allowance
	 * for the same reason — it belongs to the account and says nothing about the Work. Note it
	 * applies whatever the access, since a limit somebody's parent set is not undone by having
	 * bought something.
	 */
	const deliverable = canAccess && !(publicAccess && allowanceSpent) && !timeLimited;

	// The image set, in order — an image Work's gallery is its source-set table read back
	// (`listSourceFiles` falls back to the legacy column as the one-file set). It rides the
	// same `deliverable` verdict as `sourceKey`, `imageAlt` and the gated prose: these are
	// the four with no delivery endpoint of their own, so this payload is where the meter
	// bites for looking, and a locked Work's pictures leave with its words.
	const gallery =
		work.type === "image" && deliverable ? (await listSourceFiles(work)).map((f) => f.file) : [];
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
		// creator and an operator, and a user able to read it could tell a corrected Work
		// from a self-declared one.
		maturity: work.maturity,
		maturityNotes: work.maturityNotes ?? [],
		// The matrix too, so a user's own filter can blur by kind of content in the browser. It
		// restates the notes plus which rows are None, so it tells a user nothing the notes
		// do not, except that a creator said something is absent.
		maturityRows: work.maturityRows ?? {},
		originallyReleased: work.originallyReleased,
		// The creator's provenance table — public liner notes, ungated like the description,
		// EXCEPT where a credit names an on-network identity that has not accepted: the
		// overlay (`creditsForUser`) withholds that from everyone but the named person and
		// the creator, and resolves an accepted one to a handle rather than a bare DID.
		credits: await creditsForUser(work, userId),
		streamEnabled: work.streamEnabled,
		downloadEnabled: work.downloadEnabled,
		isPinned: work.isPinned,
		tags: work.tags,
		websiteUrl: work.websiteUrl,
		sourceUrl: work.sourceUrl,
		viewCount: work.viewCount,
		downloadCount: work.downloadCount,
		/** The current media version's date, for the reader. Its name travels beside it. */
		versionAddedAt: work.versionAddedAt,
		versionLabel: work.versionLabel,
		createdAt: work.createdAt,
		updatedAt: work.updatedAt,
		// The creator's prose. For a text Work this IS the deliverable; for any other type
		// it is the notes that come with it. Either way it rides with the payload and is
		// gated — `description` is the public blurb that stays visible when locked.
		//
		// These four are the ones with no delivery endpoint of their own, so `deliverable`
		// is where the meter actually bites for reading, playing and looking.
		bodyHtml: deliverable ? work.bodyHtml : "",
		body: deliverable ? work.body : "",
		sourceKey: deliverable ? work.sourceKey : "",
		// A row written before the address was checked, or by any path that skipped the check,
		// still never reaches the iframe: the address is refused here as well as on the way in.
		// `embedUrlProblem` in `@anthers/shared/content` carries the reasons.
		embedUrl: deliverable && !embedUrlProblem(work.embedUrl ?? "") ? work.embedUrl : "",
		// 🚨 **A hosted build rides on the same `deliverable` verdict as every other
		// medium.** True means the Work page may press its play button — which then mints
		// the per-session play address by its own checked call, exactly the shape the
		// audio route leaves to the player (withhold the URL, enforce at the endpoint).
		// The build's files themselves are never in this payload: they resolve against
		// the delivery origin's allowlist, where only the token speaks.
		//
		// `webPlayPath` says WHERE the play button leads: `"inline"` frames the minted
		// address in place; `"page"` sends the user to the server-rendered play page —
		// which an isolation build (threaded export) requires, because a frame is
		// cross-origin isolated only when every ancestor is, and this SPA cannot carry
		// per-Work response headers. Withheld under the same not-deliverable branch.
		webPlayable: deliverable && hasPrimaryBuild,
		webPlayPath: deliverable ? (primaryRequiresIsolation ? "page" : "inline") : null,
		// 🚨 Lyrics ride WITH the payload, not with the blurb. A gated track's words are as
		// much the deliverable as its audio, and the two failure directions are not
		// symmetric: a creator who wants them public can put them in `description`, which
		// stays visible when locked, while a creator who wanted them private has no way to
		// un-serve words already handed out. Same branch as `body`, deliberately — a third
		// rule here ("gated by access but not by the meter") would be a second mechanism
		// for something already enforced once.
		lyrics: deliverable ? work.lyrics : "",
		// The image's alt rides the same branch as the image itself — it describes pixels
		// the gate withholds (the schema column's docblock carries the reasoning).
		imageAlt: deliverable ? work.imageAlt : "",
		// The set of images the Work displays, gated exactly beside its siblings here.
		gallery,
		pageCount,
		sectionCount,
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
		// The original file's play address, for a video Work and — since 2026-10-16 —
		// for the listened kinds: the 2026-10-11 ruling's baseline, playable from the
		// moment the Work exists and delivered as the bytes the creator uploaded,
		// with the processed deliverable as the upgrade that arrives later (wiki
		// 70.06). The same posture as the transcoding URLs below — withheld when the
		// user may not reach the Work, and enforced at the endpoint
		// (`/works/:id/original`), which minted the signed URL fresh per request only
		// after the meter and household limit answered. Without a delivery context
		// (local mode), the stored key is already the playable address, exactly as
		// `userTranscoding` treats its own URLs.
		originalUrl:
			canAccess && (work.type === "video" || isListened(work.type)) && work.sourceKey
				? delivery
					? withShare(`${delivery.origin}/api/content/works/${work.id}/original`, delivery)
					: work.sourceKey
				: null,
		transcoding: await userTranscoding(job, canAccess, delivery),
		// Caption tracks ride `canAccess` like the video's own URLs: authored descriptions
		// of a gated video are inside its gate, and a served track answers to the same
		// access check at its route. They do NOT ride the meter — the meter measures
		// attention, not bytes, and a caption file is bytes (see the download note above).
		captions:
			canAccess && work.type === "video"
				? captions.map((t) => ({
						id: t.id,
						language: t.language,
						label: t.label || t.language,
						kind: t.kind,
						url: buildCaptionUrl(delivery ?? localDelivery, work.id, t.id),
					}))
				: [],
		// The storefront's preview set — shown to the locked viewer this page is for. A kind
		// without preview support carries an empty list; an already-open Work still carries
		// it (the page just does not render the carousel), so the shape does not change.
		previewMedia: supportsPreviewMedia(work.type)
			? previews.map((p) =>
					serializePreviewMedia(
						p,
						work.id,
						delivery ?? localDelivery,
						previewCaptions.get(p.id) ?? [],
					),
				)
			: [],
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
		 * Note this is a fact about the WORK and says nothing about whether a given user
		 * may watch more of it this month. That is the account-level meter, which is
		 * deliberately not expressed here — see `publicAccessGate`.
		 */
		publicAccess,
		/**
		 * The Work's listing on the network, as the public record link beside it — the
		 * same one the owner's shape carries, since the record is public no matter who
		 * reads (the widening task, 2026-10-10). Derived from the stored address alone,
		 * so it costs no lookup on the hot read path, and it is null for a Work with no
		 * listing, which is ordinary rather than a fault.
		 */
		recordUrl: recordUrlFor(work.atprotoUri),
	};
}

/**
 * Whether this user has spent their monthly Public Access allowance.
 *
 * One read per request, not per Work: the allowance belongs to the **account**, so a
 * page listing forty Works asks once. That is the same reason the meter could never live
 * inside `resolveAccessSync` — which is pure and synchronous precisely so a batch
 * resolves without an N+1.
 *
 * 🚨 **This docstring is where the anonymous-viewing rationale was written down**, and it
 * is worth saying so rather than quietly deleting it. It read: *"A logged-out user is
 * never spent: the server hands anonymous callers the full allowance on purpose, because
 * anonymous streaming of the commons is the shop window."* Nobody decided that. It was a
 * plausible-sounding sentence invented to explain a missing `requireAuth`, and from here it
 * reached the onboarding doc, the Roadmap and the meter's own module docs, where it read like settled
 * policy because it was written in the voice of one. **A comment explaining why the code is
 * right is not evidence that anybody chose it.**
 *
 * A signed-out user now has no allowance at all, so this reports them spent — which no
 * longer decides anything, because `resolveAccessSync` has already refused them the
 * deliverable by then.
 */
export async function allowanceSpent(
	userId: number | null,
	sharedBy: number | null = null,
): Promise<boolean> {
	// A share-link view draws the sharer's separate relay budget, never their ten hours and
	// never nothing. Same split as `publicAccessGate` and for the same reason — the two
	// budgets bound different things.
	if (userId == null && sharedBy != null) {
		return !(await loadShareLinkBudget(sharedBy)).allowed;
	}
	const budget = await loadPublicAccessBudget(userId);
	return !budget.allowed;
}

/** The shape `resolveAccessSync` returns; declared structurally so serialization stays pure. */
export type AccessResultLike = ReturnType<typeof resolveAccessSync>;

/** Load Works by id with their assets and latest transcode, ready for serialization. */
export async function loadWorkBundles(workIds: number[]): Promise<{
	worksById: Map<number, WorkRow>;
	assetsByWork: Map<number, AssetRow[]>;
	jobByWork: Map<number, TranscodingJobRow>;
	/** Page count per ebook Work. A COUNT, never the keys — see `serializeWorkForUser`. */
	pagesByWork: Map<number, number>;
	/** Reflow section count per ebook Work — the reader's shape signal, `pageCount`'s sibling. */
	sectionsByWork: Map<number, number>;
	/** Browser builds per Work, with their file rows. Owner-facing payload; see `serializeWork`. */
	buildsByWork: Map<number, WebBuildWithFiles[]>;
	/** Caption tracks per Work — player payload, only for surfaces that render one. */
	captionsByWork: Map<number, CaptionTrackRow[]>;
}> {
	const worksById = new Map<number, WorkRow>();
	const assetsByWork = new Map<number, AssetRow[]>();
	const jobByWork = new Map<number, TranscodingJobRow>();
	const pagesByWork = new Map<number, number>();
	const sectionsByWork = new Map<number, number>();
	const buildsByWork = new Map<number, WebBuildWithFiles[]>();
	const captionsByWork = new Map<number, CaptionTrackRow[]>();
	if (workIds.length === 0) {
		return {
			worksById,
			assetsByWork,
			jobByWork,
			pagesByWork,
			sectionsByWork,
			buildsByWork,
			captionsByWork,
		};
	}

	const [
		workRows,
		assetRows,
		jobRows,
		pageRows,
		sectionRows,
		buildRows,
		buildFileRows,
		captionRows,
	] = await Promise.all([
		db.select().from(works).where(inArray(works.id, workIds)),
		db.select().from(workAssets).where(inArray(workAssets.workId, workIds)),
		db
			.select()
			.from(workTranscodingJobs)
			.where(inArray(workTranscodingJobs.workId, workIds))
			.orderBy(desc(workTranscodingJobs.createdAt)),
		db
			.select({ workId: workPages.workId, count: sql<number>`count(*)::int` })
			.from(workPages)
			.where(inArray(workPages.workId, workIds))
			.groupBy(workPages.workId),
		db
			.select({ workId: workSections.workId, count: sql<number>`count(*)::int` })
			.from(workSections)
			.where(inArray(workSections.workId, workIds))
			.groupBy(workSections.workId),
		db.select().from(workBuilds).where(inArray(workBuilds.workId, workIds)),
		db
			.select({ file: workBuildFiles, workId: workBuilds.workId })
			.from(workBuildFiles)
			.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
			.where(inArray(workBuilds.workId, workIds)),
		db.select().from(workCaptionTracks).where(inArray(workCaptionTracks.workId, workIds)),
	]);
	for (const p of pageRows) pagesByWork.set(p.workId, p.count);
	for (const s of sectionRows) sectionsByWork.set(s.workId, s.count);

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
	for (const t of captionRows) {
		if (t.workId == null) continue;
		const list = captionsByWork.get(t.workId) ?? [];
		list.push(t);
		captionsByWork.set(t.workId, list);
	}
	const filesByBuild = new Map<number, (typeof workBuildFiles.$inferSelect)[]>();
	for (const { file } of buildFileRows) {
		const list = filesByBuild.get(file.buildId) ?? [];
		list.push(file);
		filesByBuild.set(file.buildId, list);
	}
	for (const b of buildRows) {
		const list = buildsByWork.get(b.workId) ?? [];
		list.push({ ...b, files: filesByBuild.get(b.id) ?? [] });
		buildsByWork.set(b.workId, list);
	}
	return {
		worksById,
		assetsByWork,
		jobByWork,
		pagesByWork,
		sectionsByWork,
		buildsByWork,
		captionsByWork,
	};
}

/**
 * Public origin the browser uses to reach us (same host serves the SPA + /api in
 * prod). Behind DO's ingress `c.req.url` carries an internal host, so absolute URLs
 * handed to the client must be built from FRONTEND_URL, not the request URL.
 */
export function publicOrigin(): string {
	const configured = (process.env.FRONTEND_URL ?? "").trim().replace(/\/+$/, "");
	if (configured) return configured;
	// A browser session (and CI's copy of one) runs the API on its own port, not on the
	// SPA's `:3000`. Absolute media URLs have to name the API, so fall back to the port
	// this process is actually listening on rather than the dev SPA default. Production
	// always names FRONTEND_URL, so this branch is local and CI only.
	const port = process.env.API_PORT ?? process.env.PORT ?? "8000";
	return `http://localhost:${port}`;
}

/**
 * The address of the same share rendered as an embeddable player.
 *
 * An embed is a share link that renders in a player: it carries the identical opaque
 * token, and `/embed/:token` answers with the Work's player page instead of a redirect to
 * its full page. Every access, metering and attribution question is answered from the
 * token exactly as it is for the link — this URL only changes what the page looks like.
 */
export function embedUrl(token: string): string {
	return `${publicOrigin()}/embed/${token}`;
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
export function deliveryCtx(share: string | null = null): DeliveryCtx | null {
	if (isLocalStorage) return null;
	return { origin: publicOrigin(), share };
}

/**
 * Lifetime of a signed media URL. Must exceed a user's watch/listen time, since the
 * URL is handed out once and used for the whole of a VOD playback.
 */
export const SIGNED_MEDIA_TTL_SECONDS = 6 * 60 * 60;

export type WorkReachability = { refusal: Response } | { userId: number | null; isOwner: boolean };

/**
 * The visibility ladder a Work's own bytes pass before anything is served: released or
 * still-owed-to-a-buyer, Adult verification, and creator suspension, each a 404 rather
 * than a 403 because the state itself is what the rung withholds.
 *
 * 🚨 **This is extracted so the preview route cannot be a side door around it.** A preview
 * is shown to a locked viewer by design, but only to a viewer the Work itself is reachable
 * by; a route that signed a preview without this ladder would hand a suspended creator's
 * storefront, or an Adult Work's screenshots, to somebody who cannot see the Work at all.
 * The detail route and every preview delivery route call this one function.
 */
export async function workReachability(
	c: Parameters<typeof getOptionalUserId>[0],
	work: typeof works.$inferSelect,
): Promise<WorkReachability> {
	const userId = await getOptionalUserId(c);
	const isOwner = userId != null && userId === work.creatorId;

	const stillOwed = async (buyerId: number | null) =>
		buyerId != null &&
		(
			await db
				.select({ id: purchases.id })
				.from(purchases)
				.where(
					and(
						eq(purchases.workId, work.id),
						eq(purchases.buyerId, buyerId),
						eq(purchases.status, "completed"),
					),
				)
				.limit(1)
		).length > 0;

	if (work.visibility !== "released" && !isOwner) {
		// A withdrawn Work is out of public circulation but still owed to the people
		// who bought it — that is the whole point of the state, so this is the one
		// place a non-released Work is served to someone other than its creator.
		// `private` still 404s for everyone else: it was never anyone's to buy.
		if (work.visibility !== "withdrawn" || !(await stillOwed(userId))) {
			return { refusal: c.json({ error: "Work not found" }, 404) };
		}
	}

	// 🚨 **404, not 403, and the difference is the whole rule.** Adult work is invisible
	// to anyone who has not opted in and verified — its existence, title and cover art
	// included — so a response saying "this exists and you may not have it" would leak
	// exactly what the rung withholds. This is also the surface a share link arrives at,
	// and the wiki's *Rating Standard* is explicit that a share link is a locator and never an entitlement: the
	// person following one has no setting for the opt-in to consult, so they meet the
	// same absence a search would have given them.
	//
	// ⚠️ Placed after the owner and withdrawn-purchaser branches deliberately. A creator
	// reaches their own Work whatever their setting says, and this must not become the
	// reason somebody cannot see a thing they made.
	if (!isOwner && requiresAdultVerification(work.maturity)) {
		const { access } = await adultVisibility(userId);
		if (!access.canReach) return { refusal: c.json({ error: "Work not found" }, 404) };
	}

	// A suspended creator's Work reads as absent — the same 404 a private Work gets,
	// never a differently-worded one, because naming the state would leak it. Placed
	// after the withdrawn-purchaser branch deliberately: a suspension removes the
	// creator from circulation; it does not confiscate what a buyer already owns.
	if (!isOwner && work.creatorId != null && (await isSuspendedAccount(work.creatorId))) {
		const stillOwned = work.visibility === "withdrawn" || (await stillOwed(userId));
		if (!stillOwned) return { refusal: c.json({ error: "Work not found" }, 404) };
	}

	return { userId, isOwner };
}

/**
 * Queue the space write after the row has been written, and never let its failure fail the
 * request. During the cutover the database is still the hot copy, so a queue failure costs
 * freshness in the space rather than the save itself.
 */
export function queueReaderWrite(work: () => Promise<void>): void {
	void work().catch((error) => console.error("[reader-state] queue failed", error));
}

import { libraryRoutes } from "./content/library.js";
import { postsRoutes } from "./content/posts.js";
import { projectsRoutes } from "./content/projects.js";
import { uploadsRoutes } from "./content/uploads.js";
import { workEditorRoutes } from "./content/workEditor.js";
import { workMediaRoutes } from "./content/workMedia.js";
import { worksRoutes } from "./content/works.js";

const contentRoutes = new Hono()
	.route("/", postsRoutes)
	.route("/", workMediaRoutes)
	.route("/", worksRoutes)
	.route("/", workEditorRoutes)
	.route("/", projectsRoutes)
	.route("/", uploadsRoutes)
	.route("/", libraryRoutes);

export { contentRoutes };

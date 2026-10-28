// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: posts, comments, votes and reviews.
 *
 * The announcement half of the surface. A post is prose that announces; the Works it links
 * are inert embeds resolved at read time. Comments, votes and reviews are the reader's
 * responses, with their own moderation filters.
 *
 * Split out of `routes/content.ts` on 2026-10-28; docblocks moved with their code.
 */

import { db } from "@anthers/db/client";
import {
	comments,
	postEdits,
	posts,
	projectPosts,
	projects,
	reviews,
	users,
	votes,
	works,
} from "@anthers/db/schema";
import {
	type CommentSubjectType,
	REVIEW_WINDOWS,
	recommendedPercent,
	reviewWindowSince,
} from "@anthers/shared/content";
import { requiresAdultVerification } from "@anthers/shared/content-rating";
import { visiblePostTitle } from "@anthers/shared/post-title";
import { commentScore, isCollapsed } from "@anthers/shared/votes";
import { zValidator } from "@hono/zod-validator";
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	like,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { embedCreator } from "../../lib/handles.js";
import {
	canonicalizePostTitle,
	displayPostTitle,
	displayPostTitles,
	mentionableWorks,
	mentionedWorksForTitle,
} from "../../lib/post-title-mentions.js";
import { workPublicIdsFromBody } from "../../lib/post-work-links.js";
import { getOptionalUserId, requireAuth, requireCreator } from "../../middleware/auth.js";
import {
	type AccessibleWork,
	buildAccessContext,
	resolveAccessSync,
} from "../../services/access.js";
import {
	isSuspendedAccount,
	notSuspendedAccount,
	notTestAccount,
} from "../../services/account-visibility.js";
import { notifyPostComment, notifyReply, notifyReview } from "../../services/activity-notify.js";
import { interactionPermissionRefusal } from "../../services/atproto.js";
import { POST_COLLECTION, VOTE_COLLECTION } from "../../services/atproto-record-plan.js";
import { queueRecordRemoval } from "../../services/atproto-record-removal.js";
import { recordUrlFor } from "../../services/atproto-repo.js";
import { blockedUserIds, isBlocked, notBlockedBy } from "../../services/blocks.js";
import {
	commentAncestry,
	REPLY_SUBJECT_TYPE,
	rootOfAncestry,
	shapeThread,
	threadCommentIds,
} from "../../services/comment-thread.js";
import { canBePaid } from "../../services/payouts.js";
import {
	normalizeStoredMarkdown,
	postContentExcerpt,
	postHtmlToMarkdown,
} from "../../services/post-markdown.js";
import { publishRefusal } from "../../services/publish-refusal.js";
import { queueRecordSync } from "../../services/record-sync.js";
import {
	allowanceSpent,
	authorUpvote,
	type DeliveryCtx,
	deliveryCtx,
	findPostRow,
	findWorkRow,
	loadWorkBundles,
	makeUniquePublicId,
	makeUniqueSlug,
	NO_VOTES,
	serializeWorkForUser,
	tooManyVotesFrom,
	visibleReview,
	votableExists,
	voteTallies,
	workAccessFor,
} from "../content.js";
import {
	createCommentSchema,
	createPostSchema,
	createReviewSchema,
	deletePostQuerySchema,
	type postBaseSchema,
	updatePostSchema,
	voteQuerySchema,
	voteSchema,
	voteTargetSchema,
} from "./schemas.js";

const postsRoutes = new Hono()
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
		const effectiveSort = sort === "popular" ? "popular" : "newest";
		// The viewer, for the two things the feed resolves per person: their own drafts
		// under `mine=true`, and the names behind the Works their posts' titles mention.
		const viewerId = await getOptionalUserId(c);

		// ── Cursor pagination ──
		// Keyset pagination over the full ordering tuple — the row id breaks every tie —
		// so paging is stable under concurrent inserts and never re-serves or skips a row.
		// The cursor is the last row of the previous page, base64url JSON, its ordering
		// values captured when that page was served: the comparison values are a snapshot,
		// so later movement on a boundary row (a new pin, a view-count bump) cannot shift
		// an existing page boundary. The feed time rides as epoch-microsecond text: a JS
		// Date holds milliseconds only, and rounding the key off by a fraction would make
		// the equality band skip rows. Postgres 16's `extract(epoch …)` is exact numeric
		// arithmetic, so the microseconds compare with no rounding on either side.
		const cursorRaw = c.req.query("cursor");
		let cursor: { s: string; p: 0 | 1; id: number; m: string; v?: number } | null = null;
		if (cursorRaw != null && cursorRaw !== "") {
			try {
				const parsed = JSON.parse(Buffer.from(cursorRaw, "base64url").toString("utf8"));
				const shapeOk =
					parsed?.s === effectiveSort &&
					(parsed.p === 0 || parsed.p === 1) &&
					Number.isInteger(parsed.id) &&
					parsed.id > 0 &&
					typeof parsed.m === "string" &&
					/^\d+(\.\d+)?$/.test(parsed.m) &&
					(effectiveSort === "popular"
						? Number.isInteger(parsed.v) && (parsed.v as number) >= 0
						: parsed.v === undefined);
				if (!shapeOk) throw new Error("bad cursor");
				cursor = parsed;
			} catch {
				return c.json({ error: "Invalid cursor." }, 400);
			}
		}

		const rawLimit = Number(c.req.query("limit"));
		if (c.req.query("limit") != null && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
			return c.json({ error: "limit must be a positive integer." }, 400);
		}
		const limit = rawLimit ? Math.min(rawLimit, FEED_PAGE_MAX) : FEED_PAGE_MAX;

		const conditions: SQL[] = [];

		if (mine === "true") {
			if (!viewerId) return c.json({ posts: [] });
			conditions.push(eq(posts.creatorId, viewerId));
		} else {
			conditions.push(eq(posts.isPublished, true));
		}

		if (creator) {
			const [user] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.atprotoHandle, creator))
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

		// The public feed is every published post now: a post has one home, and retiring
		// `show_on_timeline` removed the only way to publish something off it. A creator's
		// own view (`mine=true`) still carries drafts, which the published condition above
		// deliberately leaves out of the public arm.

		if (tag) conditions.push(sql`${posts.tags} @> ${JSON.stringify([tag])}::jsonb`);

		if (search) {
			conditions.push(or(like(posts.title, `%${search}%`), like(posts.body, `%${search}%`)) as SQL);
		}

		// A suspended account goes dark: its posts drop out of the public feed before any
		// LIMIT, beside the block and maturity filters rather than after the page is cut.
		if (mine !== "true") {
			conditions.push(notSuspendedAccount(posts.creatorId) as SQL);
			// The automated-test account is hidden from the feed the same way, on the
			// pattern above — a query condition, not a change to the account itself.
			conditions.push(notTestAccount(posts.creatorId) as SQL);
		}

		// Sorted on publication, not on when the draft row appeared. `publishedAt` is null
		// for drafts (the creator's own view), so fall back to createdAt to keep them ordered.
		// Both reads and the ordering go through the same epoch-micros expression, so what
		// feeds the cursor is exactly what ordered the page.
		const feedTime = sql`COALESCE(${posts.publishedAt}, ${posts.createdAt})`;
		const feedTimeMicros = sql`((extract(epoch from ${feedTime})) * 1000000)::numeric`;
		let orderClause: SQL[];
		switch (sort) {
			case "popular":
				orderClause = [desc(posts.viewCount), desc(feedTimeMicros)];
				break;
			default:
				orderClause = [desc(feedTimeMicros)];
		}

		// Rows ranking after the cursor row under `(is_pinned DESC, sort key DESC, id DESC)`.
		// A boolean sorts DESC as false < true, so leaving the pinned band means
		// `is_pinned = false` when the cursor row was pinned and is impossible otherwise;
		// inside a band the remaining keys compare as a plain "strictly before" chain.
		if (cursor) {
			const older = sql`(${feedTimeMicros} < ${cursor.m}::numeric OR (${feedTimeMicros} = ${cursor.m}::numeric AND ${posts.id} < ${cursor.id}))`;
			const inBand =
				effectiveSort === "popular"
					? sql`((${posts.viewCount} < ${cursor.v} OR (${posts.viewCount} = ${cursor.v} AND ${older})))`
					: older;
			conditions.push(
				cursor.p === 1
					? sql`(${posts.isPinned} = false OR (${posts.isPinned} = true AND ${inBand}))`
					: sql`(${posts.isPinned} = false AND ${inBand})`,
			);
		}

		// One row past the page decides whether a next page exists.
		const fetched = await db
			.select({
				post: posts,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
				feedTimeMicros: sql<string>`${feedTimeMicros}::text`,
			})
			.from(posts)
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(posts.isPinned), ...orderClause, desc(posts.id))
			.limit(limit + 1);

		const hasMore = fetched.length > limit;
		const result = hasMore ? fetched.slice(0, limit) : fetched;

		// The name each title's `@` mention resolves to for this viewer — one lookup for
		// the page, and the card renders this rather than the raw stored title.
		const displayTitles = await displayPostTitles(
			result.map((row) => row.post.title),
			viewerId,
		);

		let nextCursor: string | null = null;
		if (hasMore && result.length > 0) {
			const last = result[result.length - 1];
			nextCursor = Buffer.from(
				JSON.stringify({
					s: effectiveSort,
					p: last.post.isPinned ? 1 : 0,
					id: last.post.id,
					m: last.feedTimeMicros,
					...(effectiveSort === "popular" ? { v: last.post.viewCount } : {}),
				}),
			).toString("base64url");
		}

		// The Works each post embeds, for a card thumbnail and a count — extracted from
		// the bodies the rows already carry (nothing is stored; see `lib/post-work-links.ts`).
		// Deliberately NOT resolved for access here: the feed lists announcements, and a
		// post's readability has nothing to do with whether the Works it embeds are open.
		// The Works each post embeds, resolved for this reader through the same allow-list a
		// title's mention uses: a tile's image reaches whoever the listing reaches, so an
		// Adult Work's thumbnail must not arrive here by a query that never asked whether this
		// reader may see the Work at all.
		const allPublicIds = [...new Set(result.flatMap((r) => workPublicIdsFromBody(r.post.body)))];
		const mentionable = await mentionableWorks(allPublicIds, viewerId);

		return c.json({
			posts: result.map((r, index) => {
				const p = r.post;
				const embedded = workPublicIdsFromBody(p.body);
				return {
					id: p.id,
					publicId: p.publicId,
					slug: p.slug,
					creatorId: p.creatorId,
					title: p.title,
					// The title with each mentioned Work's current name — what a card shows.
					displayTitle: displayTitles[index] ?? p.title,
					isPinned: p.isPinned,
					tags: p.tags,
					isPublished: p.isPublished,
					publishedAt: p.publishedAt,
					scheduledFor: p.scheduledFor,
					viewCount: p.viewCount,
					createdAt: p.createdAt,
					updatedAt: p.updatedAt,
					creator: embedCreator({
						handle: r.creatorHandle,
						displayName: r.creatorDisplayName,
						avatar: r.creatorAvatar,
					}),
					// A card image, if the post embeds a Work this reader may see. A locked
					// Work's thumbnail is the preview it is supposed to show; an Adult Work's
					// is part of the existence its rung withholds, so it is not here.
					thumbnail: mentionable.get(embedded[0])?.thumbnail ?? null,
					linkedWorkCount: embedded.length,
					// The body as plain text, where the tile's band renders the content —
					// the same field the feed entries carry (`routes/accounts.ts`), for the
					// same tile. The body is public (a post carries no gate of its own, and
					// its page reads signed out); the plain-text form is lighter than the
					// markdown it is derived from.
					excerpt: postContentExcerpt(p.body),
				};
			}),
			nextCursor,
		});
	})

	.post("/posts", requireAuth, requireCreator, zValidator("json", createPostSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// Drafting takes creator mode, which `requireCreator` has checked; publishing or
		// scheduling takes payout setup as well.
		if (data.isPublished || data.scheduledFor != null) {
			const refusal = await publishRefusal(user, "publish");
			if (refusal) return c.json(refusal.body, refusal.status);
		}

		// NOTE: publishing is deliberately NOT gated on media readiness any more. Readiness is
		// a property of the media, the media belongs to the Work, and a post that merely embeds
		// a Work has nothing to wait for — blocking an announcement on someone's encode was an
		// artifact of the post owning the media. The gate moved to RELEASE, on the Work.

		// A title's `@` mentions are canonicalized before anything reads the title: the slug
		// derives from the visible words, never the link destinations, and a mention to a
		// Work this author cannot publish about is reduced to its plain text rather than
		// stored as a link that would never resolve.
		const title = (await canonicalizePostTitle(data.title, user.id)) ?? "";

		// Explicit slug must be free; otherwise derive a unique one from the title.
		let slug: string;
		if (data.slug) {
			if (await postSlugExists(data.slug)) {
				return c.json({ error: "A post with this slug already exists" }, 409);
			}
			slug = data.slug;
		} else {
			slug = await makeUniqueSlug(visiblePostTitle(title) || "post", postSlugExists);
		}

		const body = postBodyFromCreate(data);
		const publicId = await makeUniquePublicId(posts);

		const [post] = await db
			.insert(posts)
			.values({
				creatorId: user.id,
				publicId,
				slug,
				title,
				body,
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

		// One pinned post per creator: a pin floats above the feed, so a second one would
		// make "the pinned post" meaningless. Creating a pinned post takes the slot.
		if (post.isPinned) await unpinOtherPosts(user.id, post.id);

		// The creator's own upvote starts the post at 1 — posting it at all says it is worth
		// reading. See `authorUpvote`.
		await authorUpvote("post", post.id, user.id);

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

		// Asked for unconditionally rather than only when `isPublished` — the job re-reads and
		// decides, and a draft costs one read to skip. Working out here whether it would publish
		// would put the publishability rule in two places, and they would drift.
		void queueRecordSync("post", post.id);

		const linkedWorks = await loadPostWorksFromBody(body, user.id, deliveryCtx());
		// The row no longer carries `body_html`; the stored body is markdown in `body`,
		// which the spread ships as it is.
		return c.json({ post: { ...post, linkedWorks, displayTitle: visiblePostTitle(title) } }, 201);
	})

	.get("/posts/:slug", async (c) => {
		const { slug } = c.req.param();
		const post = await findPostRow(slug);
		if (!post) return c.json({ error: "Post not found" }, 404);

		// An unpublished post (draft / scheduled / unpublished) is visible only to its creator —
		// the permalink 404s for everyone else, matching how drafts are hidden from feeds.
		const userId = await getOptionalUserId(c);
		if (!post.isPublished && userId !== post.creatorId) {
			return c.json({ error: "Post not found" }, 404);
		}

		// A suspended author's permalink reads as absent for the same reason a hidden
		// entity's does: the account's presence stops being served, and the ordinary
		// 404 is the least informative answer the user already renders.
		if (
			post.creatorId != null &&
			userId !== post.creatorId &&
			(await isSuspendedAccount(post.creatorId))
		) {
			return c.json({ error: "Post not found" }, 404);
		}

		// A tombstoned post has no creator (the account was deleted; the thread stays
		// readable). Everything downstream already tolerates an absent creator, so the
		// lookups are simply skipped rather than defaulted to somebody.
		const [creator] = post.creatorId
			? await db
					.select({
						handle: users.atprotoHandle,
						displayName: users.displayName,
						avatar: users.avatar,
					})
					.from(users)
					.where(eq(users.id, post.creatorId))
					.limit(1)
			: [undefined];

		// Can the creator receive a direct-purchase payout? (Connected account, onboarded
		// and payouts-enabled.) Drives whether the buyer sees a live checkout.
		const creatorHasStripe = post.creatorId ? await canBePaid(post.creatorId) : false;

		// No review aggregate here: a review is a verdict on a WORK, and a post is an
		// announcement. The Works this post links carry their own.

		// Fire-and-forget view count.
		db.update(posts)
			.set({ viewCount: sql`${posts.viewCount} + 1` })
			.where(eq(posts.id, post.id))
			.execute();

		// A post has no gates of its own: it is an announcement, and announcements are for
		// the audience. Each Work its body embeds resolves on its OWN gates, so this page can
		// show a readable post alongside a Work the user cannot open — which is exactly the
		// separation the model is for, and why there is no post-level `access` any more.
		const linkedWorks = await loadPostWorksFromBody(post.body, userId, deliveryCtx());

		// The title's `@` mentions: one resolved name for the card's text, and the Works
		// themselves so the heading can link each name to its Work.
		const displayTitle = await displayPostTitle(post.title, userId);
		const mentionedWorks = await mentionedWorksForTitle(post.title, userId);

		// Transparent edit history — every content edit is logged with a timestamp, and it
		// carries no user predicate **on purpose** (settled 2026-08-09).
		//
		// It used to want one. Before migration `0010` a post carried its own gates, so a
		// user denied the body still got the full timestamped list of what changed and
		// when — the shape of gated content, leaked by a query nobody had thought about.
		// The Catalog separation dissolved that rather than fixing it: a post is an
		// announcement and has no gates at all, so there is no hidden body here whose
		// edits could describe it. Publishing the history of a public thing is just
		// Building in the Open.
		//
		// **This is load-bearing for whoever adds an edit log to a Work.** A Work IS
		// gated, and the same query written against it would recreate the original leak
		// exactly — so it needs the user predicate this one doesn't.
		const edits = await db
			.select({
				editedAt: postEdits.editedAt,
				summary: postEdits.summary,
				changedFields: postEdits.changedFields,
			})
			.from(postEdits)
			.where(eq(postEdits.postId, post.id))
			.orderBy(desc(postEdits.editedAt));

		// The row no longer carries `body_html`; the stored body is markdown in `body`.
		return c.json({
			post: {
				// The row carries no `body_html`; the stored body is markdown in `body`.
				...post,
				/**
				 * The post's public record link, beside the thing it is (the widening task,
				 * 2026-10-10) — the same one-form-a-person-can-follow link a Work's page
				 * carries. Null while the post has no record: a draft, a scheduled one, or a
				 * creator whose permission is not given yet. Ordinary, never an error.
				 */
				recordUrl: recordUrlFor(post.atprotoUri),
				creator: { ...creator, hasStripe: creatorHasStripe },
				linkedWorks,
				// The title as a reader sees it, and the Works behind its mentions so the
				// heading links each `@` name to the Work it names.
				displayTitle,
				mentionedWorks: mentionedWorks.map(({ publicId, slug, title }) => ({
					publicId,
					slug,
					title,
				})),
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

		// 🚨 Putting a post in front of anyone takes a fully set-up creator, and so does
		// scheduling it, since the sweep publishes a scheduled draft with nobody asking. Asked
		// only on the transition into published: the editor sends `isPublished: true` on every
		// save of a live post, and a creator whose payouts lapsed must still be able to fix a
		// typo in it. Everything else stays open to the owner — above all unpublishing, which is
		// the safe direction and the one that takes a record back off the network.
		const goesLive =
			(data.isPublished === true && !existing.isPublished) || data.scheduledFor != null;
		if (goesLive) {
			const refusal = await publishRefusal(user, "publish");
			if (refusal) return c.json(refusal.body, refusal.status);
		}

		if (data.slug && data.slug !== existing.slug) {
			if (await postSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		// The title as it will be stored: a mention's destination stays the durable public
		// id, its text is refreshed to the Work's current name, and a mention this author
		// cannot publish about is reduced to plain text. Done once, before the slug derives
		// from the title and before the edit history compares it.
		const nextTitle =
			data.title !== undefined
				? ((await canonicalizePostTitle(data.title, user.id)) ?? "")
				: undefined;

		// 🚨 **A retitle re-derives the slug** (Parker, 2026-10-16, "Hello, there" still sitting
		// at `/posts/post-…`): part of why the URL is durable is the ability to name the thing
		// it is, and the trailing `publicId` is the half that never has to change — old links
		// (every earlier slug, a bare publicId, any word before it) keep resolving through
		// `findPostRow` and the page settles the address bar to canonical. An explicit slug
		// still wins as before.
		let derivedSlug: string | null = null;
		if (data.slug === undefined && nextTitle !== undefined && nextTitle.trim() !== "") {
			const next = await makeUniqueSlug(visiblePostTitle(nextTitle), (slug) =>
				postSlugExists(slug, existing.id),
			);
			if (next !== existing.slug) derivedSlug = next;
		}

		const updates: Record<string, unknown> = { updatedAt: new Date() };
		if (data.slug !== undefined) updates.slug = data.slug;
		else if (derivedSlug) updates.slug = derivedSlug;
		if (nextTitle !== undefined) updates.title = nextTitle;
		Object.assign(updates, postBodyUpdatesFromPatch(data, existing));
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

		// Pinning takes the creator's one pin slot. Done after the update so the new pin is
		// never one of the rows just cleared, and conditioned on the flag rather than on a
		// difference, so pinning an already-pinned post is harmless.
		if (updates.isPinned === true) await unpinOtherPosts(user.id, existing.id);

		// Record a timestamped edit-history entry when the post's content actually changed
		// (publish/unpublish/schedule toggles don't count — see changedPostFields).
		const editedFields = changedPostFields(
			existing,
			nextTitle !== undefined ? { ...data, title: nextTitle } : data,
			derivedSlug,
		);
		if (editedFields.length > 0) {
			await db.insert(postEdits).values({
				postId: existing.id,
				summary: editedFields.join(", "),
				changedFields: editedFields,
			});
		}

		// Every edit, not only a publish or a retract: the record carries the post's URL, and a
		// slug change moves it. ⚠️ Unpublishing reaches here too, which is the half that matters —
		// it is what takes the record back down.
		void queueRecordSync("post", updated.id);

		const linkedWorks = await loadPostWorksFromBody(updated.body, user.id, deliveryCtx());
		return c.json({
			post: {
				...updated,
				linkedWorks,
				// The canonicalization just refreshed every mention's text, so the visible
				// title needs no further lookup here.
				displayTitle: visiblePostTitle(updated.title),
				mentionedWorks: (await mentionedWorksForTitle(updated.title, user.id)).map(
					({ publicId, slug, title }) => ({ publicId, slug, title }),
				),
			},
		});
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
		// ⚠️ **The whole thread, replies included.** A reply's subject is a comment, so a
		// delete matching on the post alone would strand every reply beneath it.
		const thread = await threadCommentIds({ subjectType: "post", subjectId: existing.id });
		if (thread.length > 0) await db.delete(comments).where(inArray(comments.id, thread));

		// 🚨 **The one enqueue in this file that cannot be a hint**, because there will be nothing
		// left to re-read: the address and the account travel with the job. `existing` was read
		// before any of this, which is what makes them available at all — see `queueRecordRemoval`.
		if (existing.atprotoUri && existing.creatorId !== null) {
			await queueRecordRemoval({
				ownerId: existing.creatorId,
				collection: POST_COLLECTION,
				uri: existing.atprotoUri,
			});
		}

		await db.delete(posts).where(eq(posts.id, existing.id));
		return c.body(null, 204);
	})

	// ── Comments (on posts) and replies ─────────────────────────────────────────
	//
	// A reply is posted to the same route with `replyTo`, and the thread read returns the
	// replies with the comments — see `services/comment-thread.ts`.
	//
	// 🚨 **A Work takes no comments and no votes; a review is the only feedback it accepts**
	// (Parker, 2026-09-13), so that Anthers has one coherent feedback model: posts and the
	// comments on them are voted on, Works are reviewed. `comments.subject_type` still
	// accepts `work` because rows written before that rule exist, and the users that
	// moderate or delete comments still handle them.

	.get("/posts/:slug/comments", async (c) => {
		const post = await findPostRow(c.req.param("slug"));
		if (!post) return c.json({ error: "Post not found" }, 404);
		// The thread of a suspended author's post is as absent as the post itself.
		if (post.creatorId != null && (await isSuspendedAccount(post.creatorId))) {
			return c.json({ error: "Post not found" }, 404);
		}
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

			const { body, replyTo } = c.req.valid("json");

			// The parent's author, for the reply notification. Read on the same walk the
			// refusal below already makes, so the notification costs no second query —
			// `replyRefusal`'s 404 also stands in as the block check the notification
			// needs. ⚠️ `ancestry[0]` is the reply's OWN subject — the comment being
			// answered — because the walk's first row is `replyTo` itself.
			let parentAuthorId: number | null = null;
			if (replyTo !== undefined) {
				const ancestry = await commentAncestry(replyTo);
				const refusal = await replyRefusal(replyTo, post.id, user.id);
				if (refusal) return c.json({ error: refusal }, 404);
				parentAuthorId = ancestry[0]?.userId ?? null;
			}

			// A comment is a record in the commenter's own repository, so one Anthers cannot write
			// is refused rather than kept here and silently never published.
			const unwritable = await interactionPermissionRefusal(user.id);
			if (unwritable) return c.json(unwritable.body, unwritable.status);

			const [comment] = await db
				.insert(comments)
				.values(
					replyTo === undefined
						? { userId: user.id, subjectType: "post", subjectId: post.id, body }
						: { userId: user.id, subjectType: REPLY_SUBJECT_TYPE, subjectId: replyTo, body },
				)
				.returning();

			// The author's own upvote lands on the new comment itself — posting it at all says
			// it is worth reading. See `authorUpvote`.
			await authorUpvote("comment", comment.id, user.id);

			// The social half: tell whoever just got answered. The reply's parent author was
			// read above; a fresh comment tells the post's creator instead. AWAITED, not
			// void — credit-acceptance's reasoning is the precedent: the awaits are so a
			// request cannot outlive its notifications (a process edge between response
			// and insert would drop the row, and the row is the deliverable). One insert
			// plus a preferences read is a couple of milliseconds against a posted reply;
			// the mail attempt inside is bounded by sendEmail's own no-op/send, and a
			// notify THROWN failure would 500 the comment — `.catch` keeps that case as
			// "posted, unannounced" rather than "failed, try again".
			try {
				if (replyTo === undefined) {
					await notifyPostComment({ commenterId: user.id, commenterHandle: user.handle, post });
				} else if (parentAuthorId != null) {
					await notifyReply({
						replierId: user.id,
						replierHandle: user.handle,
						parentId: replyTo,
						parentAuthorId,
						post: { slug: post.slug, publicId: post.publicId, title: post.title },
					});
				}
			} catch {
				// The comment stands; the announcement may have failed. Log nothing per-row:
				// the next session's read of the thread is the truth the feed renders.
			}

			// The record goes in the commenter's own repository, once the post has a record for it
			// to name — see `user-record-listing.ts` for what happens while it does not.
			void queueRecordSync("comment", comment.id);

			return c.json({ comment: { ...comment, handle: user.handle } }, 201);
		},
	)

	// ── Votes (posts, comments and reviews) ────────────────────────────────────
	//
	// One like or one dislike per person per thing. The published score is the net floored
	// at zero and it is also the ranking key — see `@anthers/shared/votes` for why those
	// have to be the same number. A Work is never voted on; it is reviewed. A review IS
	// voted on, as helpfulness — the same record, the same gesture, asked as "was this
	// helpful?" rather than "did you like this?".

	/**
	 * The vote state of one subject.
	 *
	 * ⭐ **A separate read rather than a field on the Work and post payloads.** Those
	 * responses come back through `serializeWork` down several branches — owner, preview,
	 * gated user — and threading a score through every one of them would put the same
	 * three lines in four places for a control that can ask for itself. A comment thread
	 * still gets its scores inline, because the list already fetches them in one grouped
	 * query and a request per comment would not be a trade at all.
	 *
	 * ⭐ **The counts go to every reader (Parker, 2026-10-16 — the numbers ride the
	 * buttons).** The post page's vote buttons carry the up and down counts themselves,
	 * YouTube-style, so this read serves the figures behind both to anybody who asks.
	 * That revises the earlier author-only read: a creator's full visibility on their own
	 * thing is subsumed by counts nobody is withheld from. The comment thread's payload
	 * still carries no raw counts — it draws the net, and nothing there renders the pair.
	 */
	.get("/votes", zValidator("query", voteQuerySchema), async (c) => {
		const { subjectType, subjectId } = c.req.valid("query");
		const userId = await getOptionalUserId(c);
		const { tallies, mine } = await voteTallies(subjectType, [subjectId], userId);
		const tally = tallies.get(subjectId) ?? NO_VOTES;
		return c.json({
			score: commentScore(tally),
			collapsed: isCollapsed(tally),
			userVote: mine.get(subjectId) ?? null,
			up: tally.up,
			down: tally.down,
		});
	})

	.put("/votes", requireAuth, zValidator("json", voteSchema), async (c) => {
		const user = c.get("user");
		if (tooManyVotesFrom(user.id)) {
			return c.json(
				{
					error: "That is a lot of votes very quickly. Try again shortly.",
					code: "rate_limited",
				},
				429,
			);
		}

		const { subjectType, subjectId, direction } = c.req.valid("json");
		if (!(await votableExists(subjectType, subjectId))) {
			return c.json({ error: "Nothing to vote on" }, 404);
		}

		// Withdrawing a vote is never refused; casting or flipping one writes a record.
		const unwritable = await interactionPermissionRefusal(user.id);
		if (unwritable) return c.json(unwritable.body, unwritable.status);

		// Changing an upvote to a downvote UPDATES the one row. Inserting a second would let
		// both count, which is the unique index's whole job and is worth doing in one
		// statement so there is no window where neither or both exist.
		const [vote] = await db
			.insert(votes)
			.values({ userId: user.id, subjectType, subjectId, direction })
			.onConflictDoUpdate({
				target: [votes.userId, votes.subjectType, votes.subjectId],
				set: { direction },
			})
			.returning({ id: votes.id });

		// A flip rewrites the one record at its own address rather than adding a second, for the
		// same reason the row is updated rather than duplicated.
		void queueRecordSync("vote", vote.id);

		const { tallies } = await voteTallies(subjectType, [subjectId], null);
		const tally = tallies.get(subjectId) ?? NO_VOTES;
		// ⚠️ The counts come back from a WRITE too, not only from the read. A user reacting
		// to a subject with a buttoned control would otherwise watch the numbers sit still
		// until a reload — two figures on screen disagreeing, which is worse than either
		// being absent. They go to every reader now, as on the read above (Parker,
		// 2026-10-16).
		return c.json({
			score: commentScore(tally),
			collapsed: isCollapsed(tally),
			userVote: direction,
			up: tally.up,
			down: tally.down,
		});
	})

	.delete("/votes", requireAuth, zValidator("json", voteTargetSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId } = c.req.valid("json");
		const withdrawn = await db
			.delete(votes)
			.where(
				and(
					eq(votes.userId, user.id),
					eq(votes.subjectType, subjectType),
					eq(votes.subjectId, subjectId),
				),
			)
			.returning({ atprotoUri: votes.atprotoUri });

		// 🚨 **Withdrawing a vote is the voter taking their record back**, and the row that knew
		// where it went is gone as of the line above — so the address is read out of the delete
		// itself and travels with the job. See `queueRecordRemoval`.
		for (const { atprotoUri } of withdrawn) {
			if (atprotoUri) {
				await queueRecordRemoval({
					ownerId: user.id,
					collection: VOTE_COLLECTION,
					uri: atprotoUri,
				});
			}
		}
		const { tallies } = await voteTallies(subjectType, [subjectId], null);
		const tally = tallies.get(subjectId) ?? NO_VOTES;
		return c.json({
			score: commentScore(tally),
			collapsed: isCollapsed(tally),
			userVote: null,
			// The counts go to every reader, as on the read and the write above (Parker,
			// 2026-10-16 — the numbers ride the buttons).
			up: tally.up,
			down: tally.down,
		});
	})

	// ── Reviews (Works only) ───────────────────────────────────────────────────
	//
	// A review is "a user's verdict on a work" (the wiki's *How Anthers Talks About Itself*), and reviews are floor-level
	// moderation because "a creator moderating reviews of their own work is the conflict
	// reviews exist to avoid" (the wiki's *Moderation & Reporting*). Both are about works, so unlike comments this is
	// NOT polymorphic — reviewing an announcement is a category error.
	//
	// The route path stays `/reviews` (and the table stays `reviews`): "review" is a copy
	// rule, not a schema rule, exactly like the Seed vocabulary changes.
	.get(
		"/works/:id/reviews",
		zValidator(
			"query",
			z.object({
				window: z.enum(REVIEW_WINDOWS).optional(),
				/**
				 * Whether to read the reviews of the current media version only. `all` is the
				 * default and the shape every existing caller already gets.
				 */
				version: z.enum(["all", "current"]).optional(),
			}),
		),
		async (c) => {
			const work = await findWorkRow(c.req.param("id"));
			if (!work) return c.json({ error: "Work not found" }, 404);

			// A suspended creator's Work has no public review surface — the same 404 the
			// Work page itself returns, since this list is a section of that page.
			if (work.creatorId != null && (await isSuspendedAccount(work.creatorId))) {
				return c.json({ error: "Work not found" }, 404);
			}

			const currentUserId = await getOptionalUserId(c);
			const window = c.req.valid("query").window ?? "month";

			// ── The current media version as a cutoff for reviews ──
			//
			// A Work can carry more than one media version, and a review left on the first
			// release reads beside one left on the build in front of the reader today. So a
			// reader may ask for the reviews written since the current version arrived, and
			// the cutoff is `reviews.createdAt >= works.versionAddedAt`.
			//
			// ⚠️ **That is a proxy, and it leaks in both directions.** A review written after
			// the new version can still be about the old build — a reader who played the 2019
			// cut and posts in 2026 is counted as reviewing the current one. And an edited
			// review keeps its original `createdAt`: the POST route's conflict branch rewrites
			// `verdict` and `body` only, so somebody who replayed the current build and edited
			// words they first wrote against the old one stays outside the cutoff for good.
			// Recording the version on the review at write time would close both leaks with a
			// column and an optional published Lexicon field; the trade was taken deliberately
			// (2026-10-24) because the question the filter exists to answer — what has the
			// build in front of me earned? — is answered well enough by when the words were
			// written, and a schema commitment is not read-side work.
			//
			// The cutoff is only offered when a version arrived AFTER the release. A Work's
			// first upload is earlier than its release date, so `versionAddedAt < releasedAt`
			// means there has never been a second version: the whole review history is the
			// current one's, and the client has no control to offer.
			const versionSince =
				work.versionAddedAt && work.releasedAt && work.versionAddedAt > work.releasedAt
					? work.versionAddedAt
					: null;
			// Reading `current` on a Work with no post-release version is not an error — it is
			// the whole history either way, which is exactly what `all` returns.
			const afterCurrentVersion =
				c.req.valid("query").version === "current" && versionSince
					? gte(reviews.createdAt, versionSince)
					: undefined;

			// The aggregate is deliberately NOT filtered by blocks, unlike the review list
			// below. A score is a fact about the Work, not about who is reading it: making it
			// user-dependent would mean two people see different reviews for the same thing,
			// and it would let one user move a creator's public average by blocking a
			// reviewer. The small honest cost is that a blocker can see "90% recommended from 10"
			// over nine listed reviews — which is already true of a hidden review, and is the right
			// side of the trade.
			//
			// ⭐ **The version scope DOES apply here, and that is the point of taking the filter
			// to the server.** A block is about who is reading; a version is about what was
			// reviewed, so the share and the list it summarizes must describe one set. Narrowing
			// only the list would leave "80% recommended" over a list that showed 100%.
			// `afterCurrentVersion` also scopes both FILTER clauses below, since the Recent share
			// counts the rows this WHERE clause already narrowed.
			// 🚨 **A proportion, not an average.** Reviews carry a verdict rather than a score,
			// so the public figure is the share who recommended it — "94% recommended" — which
			// is an honest statistic where a mean of stars was arithmetic performed on guesses.
			// Every visible review counts once. Helpfulness sorts the list and never weights one
			// review above another in either share — see `recommendedPercent`.
			const recommendedCount = sql`case when ${reviews.verdict} = 'recommended' then 1 end`;
			// The window cutoff crosses the wire as an ISO string with the cast naming its type,
			// because this driver's raw template cannot serialize a `Date` it cannot infer a
			// type for — inside a FILTER clause it falls back to treating it as a string.
			const since = reviewWindowSince(window).toISOString();
			const [agg] = await db
				.select({
					recommended: count(recommendedCount).mapWith(Number),
					count: count(reviews.id),
					recentRecommended:
						sql<number>`count(${recommendedCount}) filter (where ${reviews.createdAt} >= ${since}::timestamptz)`.mapWith(
							Number,
						),
					recentCount:
						sql<number>`count(${reviews.id}) filter (where ${reviews.createdAt} >= ${since}::timestamptz)`.mapWith(
							Number,
						),
				})
				.from(reviews)
				// Suspension joins `visibleReview` here because it is user-independent —
				// exactly the property the aggregate's no-block carve-out rests on, so the
				// two rules never ask the same number to disagree with itself.
				.where(
					and(
						eq(reviews.workId, work.id),
						visibleReview,
						// The automated-test account's review is counted away with it.
						notTestAccount(reviews.userId),
						notSuspendedAccount(reviews.userId),
						afterCurrentVersion,
					),
				);

			// The written reviews themselves. Hidden ones are withheld here for the same
			// reason they're excluded from the aggregate — this is a public read. Blocked
			// pairs are withheld for a different reason: a review carries a name and words,
			// so it is a place two people meet.
			//
			// ⭐ **A textless review counts but does not list** (Parker, 2026-10-19). The
			// aggregate above includes every visible verdict; here only rows with words
			// appear, because a list of bare verdicts is nothing a reader can read. New
			// writes normalize whitespace-only text to NULL, and the trim guards rows
			// written outside that path.
			const reviewRows = await db
				.select({
					id: reviews.id,
					userId: reviews.userId,
					verdict: reviews.verdict,
					body: reviews.body,
					createdAt: reviews.createdAt,
					handle: users.atprotoHandle,
					avatar: users.avatar,
					atprotoUri: reviews.atprotoUri,
				})
				.from(reviews)
				.innerJoin(users, eq(reviews.userId, users.id))
				.where(
					and(
						eq(reviews.workId, work.id),
						visibleReview,
						sql`coalesce(btrim(${reviews.body}), '') <> ''`,
						notBlockedBy(currentUserId, reviews.userId),
						// A suspended reviewer's words go with the rest of their account;
						// listed beside the block filter because both answer "who may meet
						// the user here". The automated-test account is hidden here on
						// the same listing rule.
						notSuspendedAccount(reviews.userId),
						notTestAccount(reviews.userId),
						afterCurrentVersion,
					),
				);

			// Each review's helpfulness, in the same grouped read a comment thread uses. The
			// user's own votes ride along so the buttons open in the right state.
			const reviewIds = reviewRows.map((r) => r.id);
			const { tallies, mine } = await voteTallies("review", reviewIds, currentUserId);

			let userVerdict: string | null = null;
			let userReview: string | null = null;
			if (currentUserId) {
				// Deliberately unfiltered by moderation status: the verdict and words a
				// user submitted shouldn't silently change under them. Their review
				// simply stops counting and stops appearing to everyone else.
				const [row] = await db
					.select({ verdict: reviews.verdict, body: reviews.body })
					.from(reviews)
					.where(and(eq(reviews.workId, work.id), eq(reviews.userId, currentUserId)))
					.limit(1);
				userVerdict = row?.verdict ?? null;
				userReview = row?.body ?? null;
			}

			return c.json({
				recommendedPercent: recommendedPercent(agg.recommended, Number(agg.count)),
				recommended: agg.recommended,
				count: Number(agg.count),
				/**
				 * The current media version's date when a version arrived after the release —
				 * the cutoff `version=current` measures against, and what tells the client
				 * whether there is a version to offer at all. Null means every review is of
				 * the current build because there has only ever been one.
				 */
				versionSince: versionSince?.toISOString() ?? null,
				recent: {
					window,
					recommendedPercent: recommendedPercent(agg.recentRecommended, agg.recentCount),
					recommended: agg.recentRecommended,
					count: agg.recentCount,
				},
				userVerdict,
				userReview,
				// Every listed row carries text — the query above excludes a verdict left on its
				// own — so `body` reaches the client as words rather than an empty quote. The
				// fallback is for the type, not for a shape the query can produce. Newest first
				// at this layer so Helpful-first and Newest-first are the CLIENT's two
				// presentations of one payload rather than two queries that could disagree.
				reviews: reviewRows
					// The raw address stays in the row's own column; the payload carries the link
					// built from it and not the address itself.
					.map(({ atprotoUri, ...r }) => ({
						...r,
						body: r.body ?? "",
						// The scorer hides nothing. A reviewer's net shows like a commenter's does,
						// and the exact figures behind it ride the single-subject read for every
						// reader now (Parker, 2026-10-16 — the numbers ride the buttons).
						score: commentScore(tallies.get(r.id) ?? NO_VOTES),
						userVote: mine.get(r.id) ?? null,
						/** The review's public record link (the widening task, 2026-10-10); null while there is none, which is ordinary. */
						recordUrl: recordUrlFor(atprotoUri),
					}))
					.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
			});
		},
	)

	.post("/works/:id/reviews", requireAuth, zValidator("json", createReviewSchema), async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		// You may only review what you can actually consume. This is stricter than the old
		// post route, which let anyone who could reach the page leave a verdict on content
		// they had never seen.
		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const unwritable = await interactionPermissionRefusal(user.id);
		if (unwritable) return c.json(unwritable.body, unwritable.status);

		const { verdict, body } = c.req.valid("json");
		// A textless review stores NULL rather than "", the same absence a record carries:
		// an empty string would say the reviewer wrote nothing, where NULL says they left
		// the words out. Editing one to add text fills it in place.
		const bodyText = body?.trim() || null;
		// The conflict branch sets `verdict` and `body` and nothing else — notably not
		// `moderationStatus`. Re-reviewing changes the verdict and the words on a hidden
		// row without resurrecting it, so a user can't un-hide their own review by
		// submitting again. Adding a field here means adding it to BOTH the insert
		// and this set clause; forgetting the set clause silently makes edits no-ops.
		//
		// ⚠️ Editing rewrites the published record at the same address rather than writing
		// a second one, so a link to a review keeps working.
		const existing = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(and(eq(reviews.userId, user.id), eq(reviews.workId, work.id)))
			.limit(1);
		const [review] = await db
			.insert(reviews)
			.values({ userId: user.id, workId: work.id, verdict, body: bodyText })
			.onConflictDoUpdate({
				target: [reviews.userId, reviews.workId],
				set: { verdict, body: bodyText },
			})
			.returning();

		// The reviewer's own upvote starts a NEW review at 1 — saying something at all says
		// it is worth reading. An EDIT is explicitly not a re-upvote: the reviewer may have
		// withdrawn or flipped theirs, and rewriting their words must not silently take that
		// back. The `existing` pre-read makes the two branches; the unique index makes the
		// insert idempotent, so a race between them still lands one vote.
		if (existing.length === 0) {
			await authorUpvote("review", review.id, user.id);
			// The creator is told about a NEW review only — an edit re-notifying is the noise
			// the branch itself is here to stop. Awaited for the same reason the comment
			// emitters are; see that call site.
			await notifyReview({
				reviewerId: user.id,
				reviewerHandle: user.handle,
				work,
				isNew: true,
			}).catch(() => {});
		}

		void queueRecordSync("review", review.id);

		return c.json({ review }, 201);
	});

/*
 * ── The four delivery endpoints ───────────────────────────────────────────────
 *
 * 🚨 **`requireAuth` on all four, since 2026-08-28. Consuming a Work requires an
 * account.** The line is the page versus the bytes: `GET /works/:id` stays open to
 * everybody, so a Work's page is shareable and indexable, and these —
 * the routes that actually hand something over — are the ones that ask who is calling.
 *
 * Anonymous delivery was never a decision. It was the absence of this middleware, which
 * later acquired a written justification ("anonymous streaming of the commons is the
 * shop window") that propagated into the onboarding doc, the Roadmap and this file's own comments.
 * What it cost, concretely: `POST /attention` **is** authenticated, so the bytes went out
 * and no attention event was ever written — **the creator earned nothing for anonymous
 * viewing of their Public Access work**, silently, with no error and nothing logged. And
 * `loadPublicAccessBudget(null)` returned the full allowance, so anonymous streaming was
 * *unlimited* while signing in reduced you to ten hours a month — the incentive inverted
 * directly underneath the platform's one conversion event.
 *
 * ⚠️ **The middleware is the guard; it is not the only one.** `resolveAccessSync` refuses
 * a null user independently, which is what covers text, games, images and software —
 * their deliverable rides inside `GET /works/:id` and passes no route of its own. Neither
 * check is redundant: remove the middleware and these four leak, remove the resolver rule
 * and the other four types do.
 *
 * 📌 A packaged desktop Studio presents its session as `Authorization: Bearer`, which
 * `requireAuth` accepts — but an `<img>`, an `<audio src>` and hls.js cannot attach a
 * header, so media in a Tauri window still depends on the cookie it cannot send. That
 * gap predates this change and is not closed by it; closing it needs a signed-URL
 * handoff, and no installer has been built yet.
 *
 * ── The access artifacts ──────────────────────────────────────────────────────
 *
 * A receipt is written into the reader's space by the job, not here. What lives on this
 * router is the key a third party checks it with, and the grant file delivery needs.
 *
 * 🚨 **The issuer document is the public half of the signing key, and nothing else.** It
 * is served without auth because checking a receipt without Anthers is the point of a
 * receipt; a deployment with no key answers 503 rather than publishing an empty JWKS a
 * verifier could mistake for a revocation.
 */

/**
 * A subject's thread: its comments, each followed by its replies, as a flat list in reading order.
 *
 * One function for both subject types — the Post thread and the Work thread differ only in
 * which `(subject_type, subject_id)` pair is asked about, so they cannot drift apart in how
 * they filter. That matters here more than most places: this is the whole of moderation and
 * blocking at read time for a thread, and a second copy of it is a second place to forget one.
 *
 * ⭐ **Flat rather than nested, and ordered by the server.** Each entry carries its subject, so
 * the client groups a reply under the comment it answers by that alone; the order within each
 * group is decided in `shapeThread`, beside the score it reads. A nested payload would put the
 * depth of a reply chain into the JSON parser's call stack.
 */
export async function listComments(
	subjectType: CommentSubjectType,
	subjectId: number,
	userId: number | null = null,
) {
	const ids = await threadCommentIds({ subjectType, subjectId });
	if (ids.length === 0) return [];

	// LEFT join, not inner. A **tombstoned** comment has a null author — its writer
	// deleted their account and the comment stayed so the conversation around it still
	// reads. An inner join would silently drop exactly those rows, which is the
	// tombstone promise failing in the one place it is supposed to hold: the thread.
	const [rows, blocked] = await Promise.all([
		db
			.select({ comment: comments, handle: users.atprotoHandle, avatar: users.avatar })
			.from(comments)
			.leftJoin(users, eq(comments.userId, users.id))
			.where(inArray(comments.id, ids)),
		// A blocked pair does not meet in a thread, in either direction. This is the densest
		// contact surface in the app; `shapeThread` takes the blocked author's replies with them.
		blockedUserIds(userId),
	]);

	// A suspended author's comments go dark with the rest of their account. They render
	// through the same gap the moderation-removed path already draws, so the thread
	// around them still reads and nothing states the suspension — a tombstoned (null)
	// author stays readable, since that gap belongs to a deleted account's promise.
	// One grouped lookup rather than a predicate per row, matching how `blocked` loads.
	const authorIds = [...new Set(rows.map((r) => r.comment.userId).filter((id) => id != null))];
	const suspendedAuthors = new Set<number>(
		authorIds.length === 0
			? []
			: (
					await db
						.select({ id: users.id })
						.from(users)
						.where(and(inArray(users.id, authorIds), isNotNull(users.suspendedAt)))
				).map((r) => r.id),
	);

	const visibleIds = rows
		.filter(
			(r) =>
				r.comment.moderationStatus === "visible" &&
				(r.comment.userId == null || !suspendedAuthors.has(r.comment.userId)),
		)
		.map((r) => r.comment.id);
	const { tallies, mine } = await voteTallies("comment", visibleIds, userId);

	const nodes = rows.map((r) => {
		const visible =
			r.comment.moderationStatus === "visible" &&
			(r.comment.userId == null || !suspendedAuthors.has(r.comment.userId));
		return {
			row: r,
			id: r.comment.id,
			subjectType: r.comment.subjectType,
			subjectId: r.comment.subjectId,
			createdAt: r.comment.createdAt,
			// A removed comment has no score to show, so it ranks as nothing rather than by
			// votes a user cannot see.
			score: visible ? commentScore(tallies.get(r.comment.id) ?? NO_VOTES) : 0,
			visible,
			blocked: r.comment.userId !== null && blocked.has(r.comment.userId),
		};
	});

	return shapeThread({ subjectType, subjectId }, nodes).map(({ kind, node }) => {
		if (kind === "removed") {
			/**
			 * 🚨 **The place a removed comment was, built from nothing but where it sits.** Its
			 * text, its author and its record address never leave the server — the address
			 * names the author's DID — so this is written out field by field and never spread
			 * from the row. It exists only because replies beneath it are still shown.
			 */
			return {
				id: node.id,
				subjectType: node.subjectType,
				subjectId: node.subjectId,
				createdAt: node.createdAt,
				removed: true as const,
			};
		}
		const r = node.row;
		const tally = tallies.get(r.comment.id) ?? NO_VOTES;
		return {
			...r.comment,
			removed: false as const,
			handle: r.handle,
			avatar: r.avatar,
			/**
			 * The comment's public record link (the widening task, 2026-10-10) — it rides the
			 * comment's row wherever the thread renders, for author and stranger alike, since
			 * the record is public. Null while there is no record, which is ordinary: the
			 * subject may have none, the author may not publish. The removed entry above
			 * carries neither address nor link on purpose.
			 */
			recordUrl: recordUrlFor(r.comment.atprotoUri),
			// 🚨 Says only WHO, never WHY. A moderation removal is the `removed` entry above;
			// this flag means the author left. Conflating the two would have us telling users
			// a user deleted something they didn't.
			deletedByAuthor: r.comment.userId === null,
			/**
			 * The published score, floored at zero — and the only ranking key.
			 *
			 * 🚨 The raw counts are deliberately NOT sent. Publishing them would hand a
			 * pile-on the dislike counter the floor exists to withhold, and the client has no
			 * use for them: everything it draws and everything that decides the order is this
			 * one number plus `collapsed`.
			 */
			score: node.score,
			/**
			 * The raw counts, and ONLY for whoever wrote this comment.
			 *
			 * ⭐ Parker, 2026-09-04: an author gets *"full visibility into exact like values
			 * and dislike values, not just the net"* on their own words. 🚨 Spread
			 * conditionally rather than sent as nulls, so a non-author's payload does not
			 * carry the keys at all — a client cannot render, cache or leak a field that is
			 * not there.
			 */
			...(userId !== null && r.comment.userId === userId ? { up: tally.up, down: tally.down } : {}),
			/**
			 * ⚠️ A THIRD state, and it is neither of the other two. A removed comment arrives
			 * as a gap with no text; `deletedByAuthor` is an author who left. This one is still
			 * here, still readable, and folded because users pushed it down.
			 */
			collapsed: isCollapsed(tally),
			/** What this user did, so the control can show itself as pressed. */
			userVote: mine.get(r.comment.id) ?? null,
		};
	});
}

/**
 * Why this person may not reply to this comment under this post, or null when they may.
 *
 * 🚨 **Every refusal is the same 404**, because the reasons are ones a user must not be able
 * to tell apart. A comment that is removed, one under a different post and one written by
 * somebody in a blocked pair all look like a comment that does not exist, which is what the
 * thread already shows this user.
 *
 * - **The comment must be visible.** A removed comment is not something anybody can answer, for
 *   the same reason it cannot be voted on.
 * - **It must sit under this post.** The route is the post's, so a reply that landed in some
 *   other thread would be a comment the page that sent it never shows. A comment on a Work is
 *   refused here too, since a Work takes no comments at all.
 * - **Nobody above it may be in a blocked pair with the replier.** The thread drops a blocked
 *   author's comment together with everything beneath it, so the replier cannot see this
 *   comment either; a reply the replier's own thread would not show is a way around the block.
 *   A removed comment above it does not refuse a reply, because that one is drawn as a gap.
 */
export async function replyRefusal(
	replyTo: number,
	postId: number,
	replierId: number,
): Promise<string | null> {
	const notFound = "Comment not found";
	const ancestry = await commentAncestry(replyTo);
	const parent = ancestry[0];
	if (parent?.moderationStatus !== "visible") return notFound;

	const root = rootOfAncestry(ancestry);
	if (root?.subjectType !== "post" || root.subjectId !== postId) return notFound;

	const authors = new Set(
		ancestry.map((a) => a.userId).filter((id): id is number => id !== null && id !== replierId),
	);
	for (const author of authors) {
		if (await isBlocked(replierId, author)) return notFound;
	}
	return null;
}

/**
 * The markdown a post save carries. The editor sends HTML (`bodyHtml`) and it is converted
 * at this boundary; a client that already holds markdown sends `body` and it is normalized.
 * Sending both names the editor's HTML the winner — it is the thing the creator was looking
 * at — and the `body` a stale client derived from that same HTML is dropped as the shadow
 * it no longer has any business being.
 */
export function postBodyFromCreate(data: z.infer<typeof postBaseSchema>): string {
	if (data.bodyHtml) return postHtmlToMarkdown(data.bodyHtml);
	return normalizeStoredMarkdown(data.body);
}

/**
 * The same rule for a PATCH, against the row's current markdown: only what actually changed
 * is written, so an unrelated save never rewrites (or re-derives) the stored body.
 */
export function postBodyUpdatesFromPatch(
	data: z.infer<typeof updatePostSchema>,
	existing: typeof posts.$inferSelect,
): Record<string, unknown> {
	const updates: Record<string, unknown> = {};
	if (data.bodyHtml !== undefined) {
		updates.body = postHtmlToMarkdown(data.bodyHtml);
	} else if (data.body !== undefined) {
		updates.body = normalizeStoredMarkdown(data.body);
	}
	void existing;
	return updates;
}

/** The row's own id excludes itself, so a retitle that re-derives the same slug does not collide with itself. */
export async function postSlugExists(slug: string, exceptId?: number): Promise<boolean> {
	const [row] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(
			exceptId != null ? and(eq(posts.slug, slug), ne(posts.id, exceptId)) : eq(posts.slug, slug),
		)
		.limit(1);
	return !!row;
}

/**
 * Which content-bearing fields a PATCH actually changed, as human labels — this drives a
 * post's edit history. Publish/unpublish and schedule changes are actions, not content
 * edits, so they're deliberately excluded and never produce a history entry.
 *
 * Delivery and access are gone from this list because they are gone from the post: they
 * belong to the Work now, and a Work's own history is its own concern.
 */
export function changedPostFields(
	existing: typeof posts.$inferSelect,
	data: z.infer<typeof updatePostSchema>,
	derivedSlug?: string | null,
): string[] {
	const changed: string[] = [];
	// `derivedSlug` is the derived slug this PATCH stored for the retitled post — a retitle
	// moves the URL by design (the publicId keeps it resolving), and the history says so.
	if (data.title !== undefined && data.title !== (existing.title ?? "")) changed.push("title");
	if (data.slug !== undefined && data.slug !== existing.slug) changed.push("slug");
	else if (derivedSlug && derivedSlug !== existing.slug) changed.push("slug");
	const bodyChanged =
		(data.body !== undefined && data.body !== (existing.body ?? "")) ||
		(data.bodyHtml !== undefined && postHtmlToMarkdown(data.bodyHtml) !== (existing.body ?? ""));
	if (bodyChanged) changed.push("body");
	if (data.isPinned !== undefined && data.isPinned !== existing.isPinned) changed.push("pin");
	if (data.tags !== undefined && JSON.stringify(data.tags) !== JSON.stringify(existing.tags ?? []))
		changed.push("tags");
	return changed;
}

/**
 * One pinned post per creator.
 *
 * A pin is presentation — it floats a post above the feed — and the product speaks of
 * "your pinned post" in the singular, so two of them is a state with no meaning. Pinning
 * clears the creator's other pins in the same statement the route runs; the confirmation
 * a creator sees names what will be replaced.
 */
export async function unpinOtherPosts(creatorId: number, keepPostId: number): Promise<void> {
	await db
		.update(posts)
		.set({ isPinned: false })
		.where(and(eq(posts.creatorId, creatorId), ne(posts.id, keepPostId), eq(posts.isPinned, true)));
}

/**
 * The Works a post embeds, each resolved against the user's own standing.
 *
 * The embeds are the Work links the body carries (`workPublicIdsFromBody`) — nothing is
 * stored, so a body edit changes the embeds with it, and a link whose Work is gone
 * renders as the plain link it already is. Note what is NOT happening here: the post
 * contributes nothing to access. Each Work is resolved on its own gates, so one post can
 * carry a free Work and a locked one side by side, and a post the user can read may
 * embed a Work they cannot open.
 */
export async function loadPostWorksFromBody(
	body: string | null,
	userId: number | null,
	delivery: DeliveryCtx | null = null,
) {
	const publicIds = workPublicIdsFromBody(body);
	if (publicIds.length === 0) return [];

	// Resolved by publicId — the part of the address that identifies the Work — and
	// ordered by first appearance in the body, which is the display order the refs
	// table's `position` used to carry.
	const rows = await db
		.select({
			id: works.id,
			publicId: works.publicId,
			maturity: works.maturity,
			creatorId: works.creatorId,
		})
		.from(works)
		.where(inArray(works.publicId, publicIds));
	if (rows.length === 0) return [];
	const byPublicId = new Map(rows.map((r) => [r.publicId, r]));

	const { worksById, assetsByWork, jobByWork, pagesByWork, sectionsByWork, buildsByWork } =
		await loadWorkBundles(rows.map((r) => r.id));
	const [ctx, spent] = await Promise.all([
		buildAccessContext(userId, { workIds: rows.map((r) => r.id) }),
		allowanceSpent(userId),
	]);

	const serialized = await Promise.all(
		publicIds.map(async (publicId, position) => {
			const found = byPublicId.get(publicId);
			const work = found ? worksById.get(found.id) : undefined;
			if (!work) return null;
			// 🚨 A post embedding an Adult Work does not embed it to somebody who has
			// not opted in. The reference is dropped rather than serialized as locked,
			// because the invisibility rule covers the title and cover art and a locked
			// card is made of both. `ctx` already carries the user's adult access, so
			// this costs no extra query — and reading it from the same context the access
			// verdict comes from is what keeps the two from disagreeing.
			if (
				requiresAdultVerification(work.maturity) &&
				!ctx.adultAccess &&
				ctx.userId !== work.creatorId
			) {
				return null;
			}
			return {
				position,
				work: await serializeWorkForUser(
					work,
					assetsByWork.get(work.id) ?? [],
					jobByWork.get(work.id) ?? null,
					resolveAccessSync(work as AccessibleWork, ctx),
					delivery,
					spent,
					userId,
					pagesByWork.get(work.id) ?? 0,
					sectionsByWork.get(work.id) ?? 0,
					(buildsByWork.get(work.id) ?? []).some((b) => b.isPrimary),
					(buildsByWork.get(work.id) ?? []).find((b) => b.isPrimary)?.requiresIsolation ?? false,
				),
			};
		}),
	);
	return serialized.filter((r): r is NonNullable<typeof r> => r !== null);
}

/** The most one `GET /posts` page may carry — the page size, and the default when a client
 * asks for no limit at all. It matches the flat limit this route carried before pagination;
 * a client keeps walking `nextCursor` past it. */
export const FEED_PAGE_MAX = 100;

export { postsRoutes };

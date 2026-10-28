// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: the Catalog itself — Works, their pages, and the creator's edits.
 *
 * Creating, listing and changing a Work; the public Work page, cards, share links and the
 * Catalog by creator. The media a Work holds lives beside this in `work-media`.
 *
 * Split out of `routes/content.ts` on 2026-10-28; docblocks moved with their code.
 */

import { db } from "@anthers/db/client";
import {
	badges,
	projectItems,
	projects,
	reviews,
	users,
	workAssets,
	workBuildFiles,
	workBuilds,
	workPages,
	workSections,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import { isOwnThumbnail, supportsPreviewMedia } from "@anthers/shared/content";
import {
	gridFor,
	normalizeContentNotes,
	normalizeMaturityRows,
} from "@anthers/shared/content-rating";
import { POST_PREVIEW_EXCERPT_LIMIT, postPreviewFor } from "@anthers/shared/post-preview";
import { normalizeTag } from "@anthers/shared/tags";
import { workPreviewFor } from "@anthers/shared/work-preview";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { queueScansForWork } from "../../jobs/scan-media.js";
import { accountByHandle, resolveHandle } from "../../lib/handles.js";
import {
	displayPostTitle,
	mentionableWorks,
	postsMentioningWork,
} from "../../lib/post-title-mentions.js";
import { workPublicIdsFromBody } from "../../lib/post-work-links.js";
import { getOptionalUserId, requireAuth } from "../../middleware/auth.js";
import { invalidBody } from "../../middleware/validate.js";
import {
	type AccessibleWork,
	buildAccessContext,
	defaultSeedAccess,
	normalizeAccessRows,
	resolveAccessSync,
} from "../../services/access.js";
import {
	isSuspendedAccount,
	notSuspendedAccount,
	notTestAccount,
} from "../../services/account-visibility.js";
import { notBlockedBy } from "../../services/blocks.js";
import { listCaptionTracks, listPreviewCaptionTracksForWork } from "../../services/captions.js";
import { adultVisibility, maturityHiddenFrom } from "../../services/content-preferences.js";
import { declaredRating } from "../../services/content-rating.js";
import {
	affirmSelfCredits,
	creditAttributionsForContributor,
	findRejectedCredit,
} from "../../services/credit-acceptance.js";
import { parentalHiddenFrom, parentalVisibility } from "../../services/parental-controls.js";
import { canBePaid } from "../../services/payouts.js";
import { postContentExcerpt } from "../../services/post-markdown.js";
import { rowsOf } from "../../services/rows.js";
import { sanitizePostHtml } from "../../services/sanitize.js";
import {
	isShareable,
	resolveShareToken,
	revokeShareLink,
	shareLinkFor,
} from "../../services/share-links.js";
import { FOREIGN_FILE_REFUSAL, isOwnStorageRef } from "../../services/storage/keys.js";
import { queueWorkListingSync } from "../../services/work-listing.js";
import { listPreviewMedia } from "../../services/work-preview-media.js";
import {
	allowanceSpent,
	contextFor,
	deliveryCtx,
	embedUrl,
	estimateReadMinutes,
	findPostRow,
	findWorkRow,
	loadWorkBundles,
	makeUniquePublicId,
	makeUniqueSlug,
	namesARating,
	parentalTimeGate,
	postsUsingWork,
	previewRequest,
	publicOrigin,
	publicWorkCard,
	queueTranscodeForWork,
	RATING_BY_NAME_REFUSAL,
	REJECTED_CREDIT_REFUSAL,
	requesterFor,
	resolveWorkThumbnail,
	serializeWork,
	serializeWorkForUser,
	userTranscoding,
	visibleReview,
	workReachability,
	workSlugExists,
} from "../content.js";
import { parseNumericId } from "./access.js";
import {
	type AssetRow,
	catalogQuerySchema,
	createWorkBody,
	IMAGE_THUMBNAIL_REFUSAL,
	previewQuerySchema,
	type TranscodingJobRow,
	tagDirectoryQuerySchema,
	type WebBuildFileRow,
	type WebBuildWithFiles,
} from "./schemas.js";

const worksRoutes = new Hono()
	// ══════════════════════════════════════════════════════════════════════════
	// CONTENT LIBRARY — creator-owned, reusable content items
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * Create a library content item owned by the caller. Media items with a source that
	 * needs processing are queued here (once, in the library) — never on post save.
	 */
	.post("/works", requireAuth, createWorkBody, async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");
		if (namesARating(data)) return c.json(RATING_BY_NAME_REFUSAL, 400);

		// A Work is born private. Nothing is visible on upload — release is a separate,
		// deliberate act, which is the whole point of separating the Catalog from posting.
		const requestedVisibility = data.visibility ?? "private";
		if (requestedVisibility === "released" || data.scheduledReleaseAt) {
			return c.json(
				{
					error: "Create the Work first, then release or schedule it from its page.",
					code: "release_on_create",
				},
				400,
			);
		}

		if (isOwnThumbnail(data.type) && data.thumbnail) return c.json(IMAGE_THUMBNAIL_REFUSAL, 400);

		// Refused before anything is written. See `storage/keys.ts` for what naming another
		// account's object would let a Work do.
		for (const ref of [data.sourceKey, data.thumbnail, data.thumbnailSource]) {
			if (!(await isOwnStorageRef(ref ?? "", user.id))) return c.json(FOREIGN_FILE_REFUSAL, 400);
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
		// Declared through a complete matrix, or left `unrated` for the Edit page to ask about.
		const declaredOnCreate = declaredRating(data.maturityRows, gridFor(data.type));
		const publicId = await makeUniquePublicId(works);

		// A rejected DID credit cannot be re-added.
		if (data.credits && data.credits.length > 0) {
			const rejected = await findRejectedCredit(-1, data.credits);
			if (rejected) return c.json(REJECTED_CREDIT_REFUSAL, 400);
		}

		// Every gate names one of this creator's rungs, and the rung's amount is what is
		// stored — never the number the request carried. `normalizeAccessRows` carries the
		// reasoning.
		let accessRows = defaultSeedAccess();
		if (data.access !== undefined) {
			const normalized = await normalizeAccessRows(user.id, data.access);
			if ("error" in normalized) return c.json({ error: normalized.error }, 400);
			accessRows = normalized.rows;
		}

		const [work] = await db
			.insert(works)
			.values({
				creatorId: user.id,
				publicId,
				slug,
				type: data.type,
				title: data.title,
				description: data.description,
				// An image is its own thumbnail (`isOwnThumbnail`).
				thumbnail: isOwnThumbnail(data.type) ? (data.sourceKey ?? "") : data.thumbnail,
				thumbnailSource: isOwnThumbnail(data.type) ? (data.sourceKey ?? "") : data.thumbnailSource,
				thumbnailCrop: data.thumbnailCrop ?? null,
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
				note: data.note ?? "",
				versionLabel: data.versionLabel?.trim() ?? "",
				visibility: "private",
				// Declared here or left `unrated` for the editor to ask about. Either way it
				// is the creator's own word, so the source says so — nothing here can be an
				// operator's correction, because the Work did not exist a moment ago.
				maturity: declaredOnCreate.maturity ?? "unrated",
				maturityNotes: declaredOnCreate.maturity
					? normalizeContentNotes(declaredOnCreate.notes ?? [])
					: [],
				maturityRows: normalizeMaturityRows(data.maturityRows, gridFor(data.type)),
				maturitySource: declaredOnCreate.maturity ? "creator" : null,
				maturitySetAt: declaredOnCreate.maturity ? new Date() : null,
				originallyReleased: data.originallyReleased ? new Date(data.originallyReleased) : null,
				streamEnabled: data.streamEnabled ?? data.type !== "physical",
				downloadEnabled: data.downloadEnabled ?? false,
				access: accessRows,
				credits: data.credits ?? [],
				isPinned: data.isPinned ?? false,
				tags: data.tags ?? [],
				websiteUrl: data.websiteUrl ?? "",
				sourceUrl: data.sourceUrl ?? "",
			})
			.returning();

		const job = await queueTranscodeForWork(work);
		await queueScansForWork(work);
		await resolveWorkThumbnail(work);
		// A credit naming the creator's own identity is affirmed by the act of writing it:
		// there is no third party to ask, so it is recorded as an ordinary acceptance here
		// (see `affirmSelfCredits`). A Work is born private and has no listing yet; the row
		// is what the record's confirmed set reads when the Work is released.
		await affirmSelfCredits({ workId: work.id, creatorUserId: user.id, credits: work.credits });
		// The draft is a creator-space record, and a Work is born private — so the first sync is
		// what puts it there. The job re-reads and decides; a Work that needs no listing simply
		// writes no public record.
		await queueWorkListingSync(work.id);
		// No credit notification here: a Work is born private, and the notification is owed
		// when the Work is public — see the PATCH route and `notifyCreditedAccounts`.
		return c.json({ work: await serializeWork(work, [], job, [], deliveryCtx()) }, 201);
	})

	/** The caller's own Catalog — every Work, private and released, with processing state. */
	/**
	 * The tag directory — the tags released Works actually carry, most-used first, with
	 * the count beside each one.
	 *
	 * ⭐ **This is the vocabulary the Details tab offers**, and it is deliberately the real
	 * corpus rather than the filter sidebar's curated `TAGS_BY_TYPE` list: a creator deciding
	 * between a broad tag and a specific new one needs to see how many Works already use
	 * each, and a tag nobody has used yet must be visibly new rather than absent.
	 *
	 * ⚠️ **The count is public Works only.** Drafts and private Works never qualify (they
	 * are not part of the catalog a reader can browse), and Adult Works are left out for
	 * the same reason every listing leaves them out: an aggregate is still a statement
	 * that Adult work exists, and the rung's invisibility is a query condition. Mature
	 * Works count normally — Mature is a warning and a blur, never invisibility.
	 */
	.get("/tags", zValidator("query", tagDirectoryQuerySchema, invalidBody), async (c) => {
		const { q, limit } = c.req.valid("query");
		const search = q ? normalizeTag(q) : "";
		if (q && !search) return c.json({ tags: [] });
		const visible = and(
			sql`w.visibility = 'released'`,
			sql`w.maturity <> 'adult'`,
			notSuspendedAccount(sql`w.creator_id`),
			notTestAccount(sql`w.creator_id`),
		) as SQL;
		const result = await db.execute(sql`
			SELECT entry.tag AS tag, count(*)::int AS works
			FROM ${works} w
			CROSS JOIN LATERAL (
				SELECT DISTINCT value AS tag
				FROM jsonb_array_elements_text(coalesce(w.tags, '[]'::jsonb))
			) AS entry
			WHERE ${visible}
				AND entry.tag <> ''
				${search ? sql`AND entry.tag ILIKE ${`%${search}%`}` : sql``}
			GROUP BY entry.tag
			ORDER BY count(*) DESC, entry.tag ASC
			LIMIT ${limit}
		`);
		return c.json({
			tags: rowsOf<{ tag: string; works: number }>(result).map((row) => ({
				tag: row.tag,
				works: Number(row.works),
			})),
		});
	})

	.get("/works", requireAuth, async (c) => {
		const user = c.get("user");

		const items = await db
			.select()
			.from(works)
			.where(eq(works.creatorId, user.id))
			.orderBy(desc(works.createdAt));
		if (items.length === 0) return c.json({ works: [] });

		const ids = items.map((i) => i.id);
		const [assetRows, jobRows, buildRows, buildFileRows, reviewRows] = await Promise.all([
			db.select().from(workAssets).where(inArray(workAssets.workId, ids)),
			db
				.select()
				.from(workTranscodingJobs)
				.where(inArray(workTranscodingJobs.workId, ids))
				.orderBy(desc(workTranscodingJobs.createdAt)),
			db.select().from(workBuilds).where(inArray(workBuilds.workId, ids)),
			db
				.select({ file: workBuildFiles })
				.from(workBuildFiles)
				.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
				.where(inArray(workBuilds.workId, ids)),
			// The Reviews column's counts, in one grouped read rather than per row. The
			// filters are the public aggregate's own — a hidden review, a suspended
			// reviewer's and the automated-test account's all stop counting there, so a
			// creator reading their table sees the figure their Work page shows.
			db
				.select({
					workId: reviews.workId,
					recommended:
						sql<number>`count(*) filter (where ${reviews.verdict} = 'recommended')`.mapWith(Number),
					notRecommended:
						sql<number>`count(*) filter (where ${reviews.verdict} <> 'recommended')`.mapWith(
							Number,
						),
				})
				.from(reviews)
				.where(
					and(
						inArray(reviews.workId, ids),
						visibleReview,
						notTestAccount(reviews.userId),
						notSuspendedAccount(reviews.userId),
					),
				)
				.groupBy(reviews.workId),
		]);
		const reviewCountsByWork = new Map<number, { recommended: number; notRecommended: number }>();
		for (const row of reviewRows) {
			reviewCountsByWork.set(row.workId, {
				recommended: row.recommended,
				notRecommended: row.notRecommended,
			});
		}
		const filesByBuild = new Map<number, WebBuildFileRow[]>();
		for (const { file } of buildFileRows) {
			const list = filesByBuild.get(file.buildId) ?? [];
			list.push(file);
			filesByBuild.set(file.buildId, list);
		}
		const buildsByWork = new Map<number, WebBuildWithFiles[]>();
		for (const b of buildRows) {
			const list = buildsByWork.get(b.workId) ?? [];
			list.push({ ...b, files: filesByBuild.get(b.id) ?? [] });
			buildsByWork.set(b.workId, list);
		}

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
			works: await Promise.all(
				items.map((i) =>
					serializeWork(
						i,
						assetsByWork.get(i.id) ?? [],
						jobByWork.get(i.id) ?? null,
						buildsByWork.get(i.id) ?? [],
						deliveryCtx(),
						[],
						reviewCountsByWork.get(i.id),
					),
				),
			),
		});
	})

	/**
	 * The Works a Badge opens — the Badge Maker's Perks tab reads this to show the other
	 * half of "access is added automatically".
	 *
	 * ⭐ **Access is authored on the Work, never on the Badge** (Parker, 2026-10-26): a Work
	 * names a rung in its Access table, and the Badge's own editor only lists the Works that
	 * already do. The list is the answer to the sentence that used to leave a creator
	 * asking where to go.
	 *
	 * "Opened" means the rung's row allows the Work at $0 **and** the Everyone row does not
	 * already make it Public Access. A row with a price is a purchase door at that rung, not
	 * a gate the Badge clears, so it is excluded; a free baseline makes every rung redundant
	 * and is excluded for the same reason.
	 */
	.get("/badge-gates/:badgeId", requireAuth, async (c) => {
		const user = c.get("user");
		const badgeId = Number(c.req.param("badgeId"));

		const [badge] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.id, badgeId), eq(badges.creatorId, user.id)))
			.limit(1);
		if (!badge) return c.json({ error: "Badge not found" }, 404);

		const rows = await db
			.select()
			.from(works)
			.where(eq(works.creatorId, user.id))
			.orderBy(desc(works.updatedAt));

		const gated = rows.filter((work) => {
			const access = work.access ?? [];
			const publicAccess = access.some(
				(row) => row.threshold === 0 && row.allow && Number(row.price) === 0,
			);
			return (
				!publicAccess &&
				access.some((row) => row.badgeId === badgeId && row.allow && Number(row.price) === 0)
			);
		});

		return c.json({
			works: gated.map((work) => ({
				id: work.id,
				publicId: work.publicId,
				title: work.title,
				type: work.type,
				visibility: work.visibility,
			})),
		});
	})

	/**
	 * Stop a Badge opening one Work — the inline control in the Badge Maker's Perks tab.
	 *
	 * ⚠️ **The row stays and `allow` becomes false**, rather than the row being deleted: the
	 * Access table is one row per rung, and the Studio's editor re-materializes every rung on
	 * its next save. A deleted row would come back as the same row with the same false flag,
	 * so the stored shape is the one every reader already understands.
	 *
	 * The rewrite goes through `normalizeAccessRows` — the one place the Badge-or-price rule
	 * is enforced — rather than writing `works.access` directly.
	 */
	.delete("/badge-gates/:badgeId/:workId", requireAuth, async (c) => {
		const user = c.get("user");
		const badgeId = Number(c.req.param("badgeId"));
		const workId = Number(c.req.param("workId"));

		const [badge] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.id, badgeId), eq(badges.creatorId, user.id)))
			.limit(1);
		if (!badge) return c.json({ error: "Badge not found" }, 404);

		const [work] = await db
			.select()
			.from(works)
			.where(and(eq(works.id, workId), eq(works.creatorId, user.id)))
			.limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = work.access ?? [];
		if (!access.some((row) => row.badgeId === badgeId)) {
			return c.json({ error: "That Badge does not gate this Work." }, 404);
		}

		const next = access.map((row) =>
			row.badgeId === badgeId ? { ...row, allow: false, price: "0" } : row,
		);
		const normalized = await normalizeAccessRows(user.id, next);
		if ("error" in normalized) return c.json({ error: normalized.error }, 400);

		await db
			.update(works)
			.set({ access: normalized.rows, updatedAt: new Date() })
			.where(eq(works.id, workId));

		return c.body(null, 204);
	})

	/**
	 * The card a shared link is unfurled with, for a reader who holds no session.
	 *
	 * Separate from `GET /works/:id` on purpose: that route counts a view and serializes
	 * the whole deliverable shape, while a crawler wants four fields and must leave no
	 * trace. The rating gate lives in `@anthers/shared/work-preview`, beside the renderer
	 * that reads it, so the API does not get a second opinion about what may travel.
	 */
	.get("/works/:id/card", async (c) => {
		const card = await publicWorkCard(c.req.param("id"));
		if (!card) return c.json({ error: "Work not found" }, 404);
		return c.json({ preview: workPreviewFor(card) });
	})

	/**
	 * The card a shared post is unfurled with, for a reader who holds no session.
	 *
	 * Separate from `GET /posts/:slug` for the same reason the Work card is: that route
	 * counts a view, while a crawler wants a heading, a line of text and an image, and must
	 * leave no trace. `publicPostCard` owns the gates; this only renders what it answers.
	 */
	.get("/posts/:slug/card", async (c) => {
		const card = await publicPostCard(c.req.param("slug"));
		if (!card) return c.json({ error: "Post not found" }, 404);
		return c.json({ preview: postPreviewFor(card) });
	})

	/**
	 * One Work — the Catalog's public detail endpoint, and the owner's editor payload.
	 *
	 * Deliberately one route serving both. The owner gets the full row (including the
	 * access tables they edit); everyone else gets the user serialization, which withholds
	 * the deliverable unless their access resolves. Two routes would mean two places for
	 * "what may this user see?" to drift apart, and the whole point of this layer is that
	 * the question has one answer.
	 *
	 * A `private` Work 404s for everyone but its creator — not 403, because the existence
	 * of unreleased work is itself not public information.
	 */
	.get("/works/:id", zValidator("query", previewQuerySchema), async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const reach = await workReachability(c, work);
		if ("refusal" in reach) return reach.refusal;
		const { userId, isOwner } = reach;

		const [assetRows, jobRows, buildRows, buildFileRows] = await Promise.all([
			db.select().from(workAssets).where(eq(workAssets.workId, work.id)),
			db
				.select()
				.from(workTranscodingJobs)
				.where(eq(workTranscodingJobs.workId, work.id))
				.orderBy(desc(workTranscodingJobs.createdAt)),
			db.select().from(workBuilds).where(eq(workBuilds.workId, work.id)),
			db
				.select({ file: workBuildFiles })
				.from(workBuildFiles)
				.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
				.where(eq(workBuilds.workId, work.id)),
		]);
		const filesByBuild = new Map<number, WebBuildFileRow[]>();
		for (const { file } of buildFileRows) {
			const list = filesByBuild.get(file.buildId) ?? [];
			list.push(file);
			filesByBuild.set(file.buildId, list);
		}
		const webBuildsList: WebBuildWithFiles[] = buildRows.map((b) => ({
			...b,
			files: filesByBuild.get(b.id) ?? [],
		}));

		await resolveWorkThumbnail(work);

		// The one route a viewer opens a video from, so it is the one route that loads the
		// Work's caption tracks. Both branches below serialize them — the owner's editor
		// lists them, the viewer's player offers them — and the batch shapes (cards,
		// listings) carry none, because nothing there renders a player.
		const captionRows = await listCaptionTracks(work.id);
		// The storefront's preview set and each trailer's caption tracks. One query each,
		// loaded only on this route: listing and card shapes never render the carousel.
		const previewRows = supportsPreviewMedia(work.type) ? await listPreviewMedia(work.id) : [];
		const previewCaptionRows = await listPreviewCaptionTracksForWork(work.id);

		/*
		 * The stub foundation of **Showings** — where a Work can be found. The creator's
		 * profile card and every Project it sits in today, plus the published posts whose
		 * TITLES name it: a discussion post lives on the Work's page rather than only at its
		 * own URL (`@Curtains Discussion (Spoilers)` is the shape). Channels, collections and
		 * collaborations follow when their machinery exists, and the client's side panel is
		 * the one place that reads this.
		 */
		const shownOn = {
			projects: await projectsShowingWork(work.id),
			posts: await postsMentioningWork(work.publicId, userId),
		};

		/*
		 * The owner short-circuit — and the one place creator preview has to interrupt it.
		 *
		 * A creator's own Work comes back through `serializeWork`, the owner-facing shape:
		 * full media keys, the editable access table, and **no `access` verdict at all**,
		 * because an owner has never needed one. That is exactly what a preview is asking
		 * for, so a preview request falls through to the user path below rather than
		 * being applied here — which is why `contextFor` can substitute a context and get
		 * a real answer out of the real resolver.
		 *
		 * ⚠️ Missing this branch is why the first cut of the preview did nothing at all for
		 * the person it exists for: the parameter was parsed, the context was built, and
		 * the request never reached the code that used it.
		 */
		if (isOwner && previewRequest(c) === null) {
			// The owner plays their own preview through the same pipes an entitled viewer
			// does, so their transcode runs the same delivery rewrite the user path
			// applies: the row's raw URL points at the private bucket, where the HLS
			// manifest 404s in the browser's player — and carries no CORS headers even
			// where it exists. Access is asserted unconditionally, because a creator may
			// always see their own media; `deliveryCtx()` with no share token is the
			// owner's own session, exactly what this branch serves.
			const playableJob = await userTranscoding(jobRows[0] ?? null, true, deliveryCtx());
			// 🚨 **The owner's shape needs the counts the reader branches on.** This branch
			// does not go through `loadWorkBundles` or `serializeWorkForUser`, and
			// `serializeWork` has never carried `pageCount`/`sectionCount` — so without
			// these two queries a creator opening their own comic got `pageCount` undefined,
			// read as 0, and rendered "This book has no pages yet" while every other reader
			// saw the book. An ebook's section count is the same defect in the other
			// direction: 0 sends the owner to the page reader instead of the reflow one.
			const [pageRow] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(workPages)
				.where(eq(workPages.workId, work.id));
			const [sectionRow] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(workSections)
				.where(eq(workSections.workId, work.id));
			return c.json({
				work: {
					...(await serializeWork(
						work,
						assetRows,
						playableJob,
						webBuildsList,
						deliveryCtx(),
						captionRows,
						undefined,
						previewRows,
						previewCaptionRows,
					)),
					// The Work page renders this for its owner, so it carries the same shape
					// signals the user path attaches below.
					pageCount: pageRow?.count ?? 0,
					sectionCount: sectionRow?.count ?? 0,
					shownOn,
				},
			});
		}

		// Fire-and-forget view count, owners excluded.
		db.update(works)
			.set({ viewCount: sql`${works.viewCount} + 1` })
			.where(eq(works.id, work.id))
			.execute();

		// A share link rides in on the query string and is resolved here, at the one route a
		// recipient actually lands on. `requesterFor` refuses a token that names a different
		// Work, and a signed-in caller ignores tokens entirely.
		const { sharedBy } = await requesterFor(c, work.id);
		const ctx = await buildAccessContext(userId, { workIds: [work.id], sharedBy });
		// A withdrawn Work can outlive its creator's account — see `works.creator_id`.
		// The card's own facts (bio, follower count, whether this reader follows them)
		// ride the creator so the Showings panel shows a person rather than a name
		// (Parker, 2026-10-19); the follow lookup is the same EXISTS the profile route uses.
		const [creator] = work.creatorId
			? await db
					.select({
						handle: users.atprotoHandle,
						displayName: users.displayName,
						avatar: users.avatar,
						bio: users.bio,
						followerCount:
							sql<number>`(SELECT count(*)::int FROM follows WHERE creator_id = ${users.id})`.as(
								"follower_count",
							),
						isFollowing: userId
							? sql<boolean>`EXISTS(SELECT 1 FROM follows WHERE follower_id = ${userId} AND creator_id = ${users.id})`
							: sql<boolean>`false`,
					})
					.from(users)
					.where(eq(users.id, work.creatorId))
					.limit(1)
			: [undefined];

		// Can the creator actually receive a direct-purchase payout? Drives whether the
		// buyer is offered a live checkout or told the creator can't take payments yet.
		//
		// ⚠️ Since 2026-08-28 a RELEASED Work's creator has necessarily passed this — it is
		// a release gate now. It stays because the answer can lapse after release (Stripe
		// can hold an account at any time), and because this endpoint also serves the
		// owner's own preview of an unreleased Work.
		const creatorHasStripe = work.creatorId ? await canBePaid(work.creatorId) : false;

		// This endpoint does not go through `loadWorkBundles`, so the page count is counted
		// here. It is the ONE page a user actually opens a book from, and leaving it on
		// the parameter default would have reported every ebook as zero pages — with no
		// error, and a user that renders nothing.
		const [pageRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(workPages)
			.where(eq(workPages.workId, work.id));
		// The reflow count rides the same answer's shape: sections exist → the reader is
		// the reflow one, none → the fixed page reader.
		const [sectionRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(workSections)
			.where(eq(workSections.workId, work.id));

		return c.json({
			work: {
				...(await serializeWorkForUser(
					work,
					assetRows,
					jobRows[0] ?? null,
					resolveAccessSync(
						work as AccessibleWork,
						contextFor(work, userId, ctx, previewRequest(c)),
					),
					deliveryCtx(sharedBy != null ? (c.req.query("share") ?? null) : null),
					await allowanceSpent(userId, sharedBy),
					userId,
					pageRow?.count ?? 0,
					sectionRow?.count ?? 0,
					// The one page a user actually opens a text Work, a game or an image
					// from, so it is the one that has to consult a household's time limit —
					// those four media have no delivery route of their own.
					(await parentalTimeGate(userId, work)) !== null,
					// The Work's own detail page — the one place a play button renders, so
					// this is the one lookup this endpoint owes (it does not go through
					// loadWorkBundles; see the page-count note above for the same shape).
					// One query answers both: is there a primary build, and does it need
					// isolation (which decides whether play opens the /play page).
					...(await buildFlagsForWork(work.id)),
					captionRows,
					previewRows,
					previewCaptionRows,
				)),
				creator,
				creatorHasStripe,
				// Who sent them, when they arrived by a share link — a display name and nothing
				// else. The recipient is told whose link they followed because it is what makes
				// the page make sense; the sharer's account is otherwise none of their business,
				// which is also why their remaining budget never reaches this response.
				sharedBy: sharedBy != null ? await sharerName(sharedBy) : null,
				// Where this Work has been announced — the other half of the reference.
				postedIn: await postsUsingWork(work.id),
				shownOn,
			},
		});
	})

	// ── Share links ──────────────────────────────────────────────────────────────
	//
	// 🚨 **The single exception to "consuming a Work requires an account", and it conveys an
	// allowance rather than a permission** (Parker, 2026-08-27). A token tells somebody where
	// a Work is; what they may reach is still `resolveAccess`'s answer alone. See
	// `services/share-links.ts` for why "ungated, non-Adult work only" falls out of the
	// control flow instead of being a rule these routes have to enforce.

	/**
	 * The link for this Work, minted on first ask and handed back unchanged after that.
	 *
	 * Idempotent so the URL somebody already pasted into a message keeps working — which is
	 * also what makes revoking mean something, since a fresh token per press would leave a
	 * trail of live links nobody could name.
	 */
	.post("/works/:id/share-link", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = parseNumericId(c.req.param("id"));
		if (workId == null) return c.json({ error: "Work not found" }, 404);

		const result = await shareLinkFor(user.id, workId);
		if ("refusal" in result) {
			if (result.refusal === "not_found") return c.json({ error: "Work not found" }, 404);
			return c.json(
				{
					error:
						"Only work that is free to everyone can be shared this way — a gate, a price or an Adult rating all need the person opening it to have their own account.",
					code: "not_shareable",
				},
				409,
			);
		}
		return c.json(
			{
				token: result.link.token,
				url: shareUrl(result.link.token),
				embedUrl: embedUrl(result.link.token),
			},
			201,
		);
	})

	/** Stop a link working. The token is retired rather than freed. */
	.delete("/works/:id/share-link", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = parseNumericId(c.req.param("id"));
		if (workId == null) return c.json({ error: "Work not found" }, 404);
		const revoked = await revokeShareLink(user.id, workId);
		return c.json({ revoked });
	})

	/**
	 * What a share token points at — a Work's canonical address, and who sent you.
	 *
	 * ⚠️ **It answers "where", never "whether".** The recipient's browser takes this to the
	 * Work's ordinary page carrying the token, and every question about what they may have is
	 * asked there, by the same resolver that answers it for everybody else. Returning a
	 * serialized Work from here would be a second path to the deliverable and therefore a
	 * second place for the rules to drift.
	 *
	 * A revoked or unknown token is a 404 rather than a 403: a link that no longer works and
	 * a link that never existed are the same thing to whoever is holding it, and telling them
	 * apart would confirm that somebody had shared something.
	 */
	.get("/share/:token", async (c) => {
		const link = await resolveShareToken(c.req.param("token"));
		if (!link) return c.json({ error: "This link is no longer available" }, 404);

		const [row] = await db
			.select({
				slug: works.slug,
				publicId: works.publicId,
				title: works.title,
				visibility: works.visibility,
				maturity: works.maturity,
				streamEnabled: works.streamEnabled,
				access: works.access,
				takedownStatus: works.takedownStatus,
				quarantineStatus: works.quarantineStatus,
				creatorId: works.creatorId,
				sharerName: users.displayName,
				sharerHandle: users.atprotoHandle,
			})
			.from(works)
			.innerJoin(users, eq(users.id, link.sharerId))
			.where(eq(works.id, link.workId))
			.limit(1);
		// 🚨 Asked again at resolution rather than trusted from the day the link was minted. A
		// Work corrected into Adult after its link was pasted somewhere would otherwise go on
		// answering that link with its title — to anybody holding it, signed in or not — which is
		// the existence the rung withholds. Withdrawn, gated or taken-down Works fail the same
		// check, and a link to one of those has nothing left to open either.
		if (!row || !isShareable(row)) {
			return c.json({ error: "This link is no longer available" }, 404);
		}

		// A suspended creator's Work is no longer openable, so a link to one has nothing
		// left to point at — the same "no longer available" a revoked link gets, rather
		// than a response that would state the suspension.
		if (row.creatorId != null && (await isSuspendedAccount(row.creatorId))) {
			return c.json({ error: "This link is no longer available" }, 404);
		}

		return c.json({
			workId: link.workId,
			slug: row.slug,
			publicId: row.publicId,
			title: row.title,
			sharedBy: row.sharerName || row.sharerHandle,
		});
	})

	/**
	 * Works anyone can open — released, streamable, and free to everyone.
	 *
	 * The predicate is deliberately the **user-independent** one: a Work qualifies when
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
		const userId = await getOptionalUserId(c);

		/** True when this access table has a row opening the Work to everyone, for free. */
		const openToEveryone = (column: SQL | unknown) => sql`EXISTS (
			SELECT 1 FROM jsonb_array_elements(COALESCE(${column}, '[]'::jsonb)) AS access_row
			WHERE (access_row->>'threshold')::numeric = 0
			  AND (access_row->>'allow')::boolean IS TRUE
			  AND COALESCE((access_row->>'price')::numeric, 0) = 0
		)`;

		const rows = await db
			.select({ work: works, handle: users.atprotoHandle, displayName: users.displayName })
			.from(works)
			.innerJoin(users, eq(works.creatorId, users.id))
			.where(
				and(
					eq(works.visibility, "released"),
					eq(works.streamEnabled, true),
					openToEveryone(works.access),
					notBlockedBy(userId, works.creatorId),
					// Suspended accounts are out of the commons entirely, beside the block
					// filter a user already sees here.
					notSuspendedAccount(works.creatorId),
					// So is the automated-test account — hidden from the commons by
					// handle, not by anything done to the account itself.
					notTestAccount(works.creatorId),
					// 🚨 **Load-bearing here, not belt-and-braces.** Adult work MAY be Public
					// Access since 2026-08-28, so this listing genuinely holds rows that must
					// not reach a user who has not opted in and verified. It was the
					// redundant half of a two-rule guard until the paywall was retired; it is
					// now the only rule standing between the commons and an unverified
					// visitor.
					(await adultVisibility(userId)).hidden,
					// A guardian's blocks hide as well as refuse — a grid of cards a child
					// cannot click is an advertisement, not a protection.
					(await parentalVisibility(userId)).hidden,
				),
			)
			.orderBy(sql`COALESCE(${works.releasedAt}, ${works.createdAt}) DESC`)
			.limit(limit);

		await Promise.all(rows.map((r) => resolveWorkThumbnail(r.work)));

		return c.json({
			works: rows.map(({ work, handle, displayName }) => ({
				publicId: work.publicId,
				slug: work.slug,
				title: work.title,
				type: work.type,
				thumbnail: work.thumbnail,
				durationSeconds: work.durationSeconds,
				estimatedReadMinutes: work.estimatedReadMinutes,
				creator: { handle, displayName },
			})),
		});
	})

	/**
	 * A creator's public Catalog — their released Works, newest-first-released first.
	 *
	 * Sorted by the creator-asserted original release date by default, so it reads as a
	 * body of work in the order it first came out, which may be years before Anthers.
	 * `sort=released` gives "what's new here" instead. Works with no original release
	 * date fall back to their release date so they can't vanish to the bottom.
	 */
	.get("/catalog/:handle", zValidator("query", catalogQuerySchema), async (c) => {
		const handle = c.req.param("handle");
		const sort = c.req.query("sort") ?? "original";
		const type = c.req.query("type");

		const resolution = await resolveHandle(handle);
		const account =
			resolution.account ??
			(resolution.redirectToHandle
				? await accountByHandle(resolution.redirectToHandle)
				: undefined);
		if (!account) return c.json({ error: "Creator not found" }, 404);
		const userId = await getOptionalUserId(c);
		// A suspended creator's Catalog is gone with the rest of their presence — the
		// same 404 an unknown handle returns, from the route that already treats hidden
		// as absent.
		if (userId !== account.id && (await isSuspendedAccount(account.id))) {
			return c.json({ error: "Creator not found" }, 404);
		}
		const creator = {
			id: account.id,
			handle: account.atprotoHandle,
			displayName: account.displayName,
		};

		const conditions: SQL[] = [eq(works.creatorId, creator.id)];
		// A creator browsing their own Catalog sees drafts too; nobody else does.
		if (userId !== creator.id) conditions.push(eq(works.visibility, "released"));
		if (type) conditions.push(eq(works.type, type));
		// 🚨 A creator profile is one of the non-feed surfaces the wiki's *Content Standards* left open, and it is
		// settled: a user who has not opted in meets nothing at all rather than an
		// interstitial. The accepted cost is that this Catalog is silently incomplete for
		// them — the alternative was announcing the existence and usually the title of work
		// the rung specifically does not give an existence to.
		const adultHidden = (await adultVisibility(userId)).hidden;
		const parentalHidden = (await parentalVisibility(userId)).hidden;
		if (adultHidden) conditions.push(adultHidden);
		// A guardian's blocks hide as well as refuse — a grid of cards a child cannot
		// click is an advertisement, not a protection.
		if (parentalHidden) conditions.push(parentalHidden);

		const preview = previewRequest(c);
		const order =
			sort === "released"
				? sql`COALESCE(${works.releasedAt}, ${works.createdAt}) DESC`
				: sql`COALESCE(${works.originallyReleased}, ${works.releasedAt}, ${works.createdAt}) DESC`;

		const rows = await db
			.select()
			.from(works)
			.where(and(...conditions))
			.orderBy(desc(works.isPinned), order)
			.limit(200);
		if (rows.length === 0) return c.json({ creator, works: [] });

		const ids = rows.map((r) => r.id);
		const { assetsByWork, jobByWork, pagesByWork, sectionsByWork, buildsByWork } =
			await loadWorkBundles(ids);
		const [ctx, catalogSpent] = await Promise.all([
			buildAccessContext(userId, { workIds: ids }),
			allowanceSpent(userId),
		]);
		await Promise.all(rows.map(resolveWorkThumbnail));
		return c.json({
			creator,
			works: await Promise.all(
				rows.map(async (w) => ({
					...(await serializeWorkForUser(
						w,
						assetsByWork.get(w.id) ?? [],
						jobByWork.get(w.id) ?? null,
						resolveAccessSync(w as AccessibleWork, contextFor(w, userId, ctx, preview)),
						deliveryCtx(),
						catalogSpent,
						userId,
						pagesByWork.get(w.id) ?? 0,
						sectionsByWork.get(w.id) ?? 0,
						(buildsByWork.get(w.id) ?? []).some((b) => b.isPrimary),
						(buildsByWork.get(w.id) ?? []).find((b) => b.isPrimary)?.requiresIsolation ?? false,
					)),
				})),
			),
		});
	})

	/**
	 * A person's credits — every published Work that names this account, split into the
	 * credits that stand and the ones waiting on their confirmation.
	 *
	 * This is the creator-profile counterpart to a Work's liner notes: the same rows turned
	 * around, as a body of work. A visitor sees only accepted credits; the account itself
	 * additionally sees the rows it has not answered, because the profile is where a
	 * person reviews what has been attributed to them.
	 *
	 * 🚨 **A listing of Works, so `maturityHiddenFrom` travels with `notBlockedBy`.** An
	 * Adult Work a viewer may not reach is absent here as everywhere else — title included
	 * — and a blocked creator's Work is absent too. Takedown and quarantine are checked
	 * because a credit is not a way around either.
	 *
	 * Attributed by identity: only credits whose contributor is the account's own DID count,
	 * since a freeform name cannot be safely matched to a person.
	 */
	.get("/credits/:handle", async (c) => {
		const handle = c.req.param("handle");
		const resolution = await resolveHandle(handle);
		const account =
			resolution.account ??
			(resolution.redirectToHandle
				? await accountByHandle(resolution.redirectToHandle)
				: undefined);
		if (!account) return c.json({ error: "Creator not found" }, 404);

		const userId = await getOptionalUserId(c);
		const isSelf = userId === account.id;
		// A suspended account's credits are gone with the rest of its presence — the same
		// 404 an unknown handle returns. The account itself still resolves its own page.
		if (!isSelf && (await isSuspendedAccount(account.id))) {
			return c.json({ error: "Creator not found" }, 404);
		}

		const [{ prefs }, { policy }] = await Promise.all([
			adultVisibility(userId),
			parentalVisibility(userId),
		]);

		const rows = await db
			.select({
				id: works.id,
				slug: works.slug,
				publicId: works.publicId,
				title: works.title,
				credits: works.credits,
				originallyReleased: works.originallyReleased,
				releasedAt: works.releasedAt,
				createdAt: works.createdAt,
			})
			.from(works)
			.where(
				and(
					eq(works.visibility, "released"),
					eq(works.takedownStatus, "active"),
					eq(works.quarantineStatus, "none"),
					sql`EXISTS (
						SELECT 1 FROM jsonb_array_elements(COALESCE(${works.credits}, '[]'::jsonb)) AS credit
						WHERE credit->>'contributor' = ${account.atprotoDid}
					)`,
					notBlockedBy(userId, works.creatorId),
					notSuspendedAccount(works.creatorId),
					notTestAccount(works.creatorId),
					maturityHiddenFrom(
						prefs,
						userId,
						sql`works.creator_id`,
						sql`works.maturity`,
						sql`works.maturity_rows`,
					),
					parentalHiddenFrom(policy, userId, sql`works.creator_id`, sql`works.type`),
				),
			)
			.orderBy(
				sql`COALESCE(${works.originallyReleased}, ${works.releasedAt}, ${works.createdAt}) DESC`,
			)
			.limit(500);

		const { accepted, pending } = await creditAttributionsForContributor(rows, account.atprotoDid);

		return c.json({
			creator: { handle: account.atprotoHandle, displayName: account.displayName },
			accepted,
			// The pending half is the account's own business: a stranger's serialization
			// carries the shape but never the rows, so a client cannot mistake a withheld
			// list for an empty one when it is the owner asking.
			pending: isSelf ? pending : [],
		});
	});

/**
 * Update a Work (owner-only) — including releasing it. Re-queues processing when the
 * source changes.
 *
 * **Release is the gate that matters here.** A Work may only go public once its media
 * is actually ready and it has some way to be consumed; this is where the readiness
 * check that used to sit on post-publish now lives, because readiness was always a
 * property of the media and the media belongs to the Work.
 */

/**
 * The build flags the user-facing serializer takes — whether a completed primary build
 * exists and whether it declared isolation — as one spread pair, from ONE query. The
 * detail route is the one caller (the batch routes read them off `loadWorkBundles`'s
 * map instead, which loads rows anyway); without this, adding a second flag was
 * becoming two nearly-identical inline lookups, which is how an N+1 and a drift are
 * both born.
 */
export async function buildFlagsForWork(workId: number): Promise<[boolean, boolean]> {
	const [row] = await db
		.select({ id: workBuilds.id, requiresIsolation: workBuilds.requiresIsolation })
		.from(workBuilds)
		.where(and(eq(workBuilds.workId, workId), eq(workBuilds.isPrimary, true)))
		.limit(1);
	return row != null ? [true, row.requiresIsolation] : [false, false];
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * The card a shared post is unfurled with, or null for the site card.
 *
 * Mirrors `publicWorkCard`, minus the rating ladder a post does not have: a post carries no
 * gate and its page reads signed out. The gates here are the permalink's own — an
 * unpublished post and a suspended author each answer nothing, exactly as they do on
 * `GET /posts/:slug` — and nothing here writes, because that route counts a view and an
 * unfurl is not one.
 *
 * The image is the first Work the post embeds, resolved through `mentionableWorks` rather
 * than read off `works` directly: an Adult Work's thumbnail is part of the existence the rung
 * withholds, and a post that links one must not hand it to an unverified stranger. The
 * title is resolved the same way, so a mention shows the Work's current name.
 */
export async function publicPostCard(param: string) {
	const post = await findPostRow(param);
	if (!post) return null;
	if (!post.isPublished) return null;
	if (post.creatorId != null && (await isSuspendedAccount(post.creatorId))) return null;

	const displayTitle = await displayPostTitle(post.title, null);
	const embedded = workPublicIdsFromBody(post.body);
	let image: string | null = null;
	if (embedded.length > 0) {
		// `mentionableWorks` is the allow-list a title's mention already resolves through, so
		// asking it which embedded Works this reader may see keeps the image and the name on
		// one rule: a Work it filters out contributes no thumbnail either.
		const mentionable = await mentionableWorks(embedded, null);
		const first = embedded.find((publicId) => mentionable.has(publicId));
		if (first !== undefined) {
			const [row] = await db
				.select({ thumbnail: works.thumbnail })
				.from(works)
				.where(eq(works.publicId, first))
				.limit(1);
			image = row?.thumbnail ? row.thumbnail : null;
		}
	}
	return {
		displayTitle,
		excerpt: postContentExcerpt(post.body, POST_PREVIEW_EXCERPT_LIMIT),
		image,
	};
}

/**
 * The Projects a Work sits in — published ones, in the order the project places them —
 * as the Showings panel's first facts. The creator's own profile card needs no query at
 * all (the Work already carries its creator), so this is the only lookup a Showings
 * stub takes today; the channels, collections and collaborations that will join these
 * rows are future facts, and the stub text says so where they are still to come.
 */
export async function projectsShowingWork(
	workId: number,
): Promise<Array<{ slug: string; title: string }>> {
	return await db
		.select({ slug: projects.slug, title: projects.title })
		.from(projectItems)
		.innerJoin(projects, eq(projects.id, projectItems.projectId))
		.where(and(eq(projectItems.workId, workId), eq(projects.isPublished, true)))
		.orderBy(asc(projectItems.sortOrder));
}

/** The display name of whoever shared a link, for the recipient's banner. */
export async function sharerName(sharerId: number): Promise<string | null> {
	const [row] = await db
		.select({ displayName: users.displayName, handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, sharerId))
		.limit(1);
	return row ? row.displayName || row.handle : null;
}

/**
 * The address of a share link, as somebody would paste it.
 *
 * Short and opaque on purpose: it carries no Work id, no slug and no handle, so the URL
 * itself says nothing about what is behind it until somebody follows it. `/s/:token` resolves
 * to the Work's canonical page, which is where every access question is asked.
 */
export function shareUrl(token: string): string {
	return `${publicOrigin()}/s/${token}`;
}

export { worksRoutes };

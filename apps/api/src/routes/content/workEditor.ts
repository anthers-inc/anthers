// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: the creator's editing surface for a Work.
 *
 * The PATCH that changes a Work, its rating appeal, usage read, deletion, assets, source
 * files and physical listing. Split from the Catalog's read half on 2026-10-28 so neither
 * module carries the whole surface.
 */

import { db } from "@anthers/db/client";
import {
	purchases,
	workAssets,
	workBuildFiles,
	workBuilds,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import { hasSourceSet, isGoodsType, isOwnThumbnail } from "@anthers/shared/content";
import { gridFor, maturityLabel, releaseRatingRefusal } from "@anthers/shared/content-rating";
import { zValidator } from "@hono/zod-validator";
import { and, countDistinct, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { queueScansForWork } from "../../jobs/scan-media.js";
import { ffmpegCommand } from "../../lib/ffmpeg.js";
import { probeVideo } from "../../lib/video-frames.js";
import { requireAuth } from "../../middleware/auth.js";
import { invalidBody } from "../../middleware/validate.js";
import { normalizeAccessRows } from "../../services/access.js";
import {
	appealsForWork,
	declaredRating,
	declareRating,
	fileRatingAppeal,
	ratingOf,
	resetRatingForTypeChange,
} from "../../services/content-rating.js";
import { removeCreatorSpace } from "../../services/creator-space.js";
import {
	affirmSelfCredits,
	findRejectedCredit,
	notifyCreditedAccounts,
} from "../../services/credit-acceptance.js";
import { syncAccountRoles } from "../../services/discord.js";
import { purgeReplacedWorkMedia, purgeWorkMedia } from "../../services/media-purge.js";
import { notifyMany } from "../../services/notifications.js";
import { physicalListingFor, savePhysicalListing } from "../../services/physical-listings.js";
import { sanitizePostHtml } from "../../services/sanitize.js";
import { storage } from "../../services/storage/index.js";
import { FOREIGN_FILE_REFUSAL, isOwnStorageRef } from "../../services/storage/keys.js";
import { queueWorkListingSync } from "../../services/work-listing.js";
import { releaseRefusal } from "../../services/work-release.js";
import {
	appendSourceFiles,
	comicSourceProblem,
	listSourceFiles,
	removeSourceFile,
	reorderSourceFiles,
	replaceSourceSet,
	syncFromSourceKey,
} from "../../services/work-source-files.js";
import { archiveCurrentMedia } from "../../services/work-versions.js";
import {
	deliveryCtx,
	estimateReadMinutes,
	FRAME_EXTRACT_TIMEOUT_MS,
	makeUniqueSlug,
	namesARating,
	postsUsingWork,
	queueTranscodeForWork,
	RATING_BY_NAME_REFUSAL,
	REJECTED_CREDIT_REFUSAL,
	resolveWorkThumbnail,
	serializeWork,
	userTranscoding,
	workSlugExists,
} from "../content.js";
import {
	createAssetSchema,
	deleteWorkQuerySchema,
	IMAGE_THUMBNAIL_REFUSAL,
	physicalListingSchema,
	ratingAppealSchema,
	sourceFilesSchema,
	sourceOrderSchema,
	updateWorkBody,
	type WebBuildFileRow,
} from "./schemas.js";

const workEditorRoutes = new Hono()
	.patch("/works/:id", requireAuth, updateWorkBody, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		// Reassigned below when the rating service rewrites the row, so the rest of the
		// handler edits what is actually stored rather than what was loaded first.
		let [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!work || work.creatorId !== user.id) {
			return c.json({ error: "Work not found" }, 404);
		}

		const data = c.req.valid("json");
		if (namesARating(data)) return c.json(RATING_BY_NAME_REFUSAL, 400);

		if (data.slug && data.slug !== work.slug) {
			if (await workSlugExists(data.slug)) return c.json({ error: "Slug already taken" }, 409);
		}

		// 🚨 **A retitle re-derives the slug**, the same rule the post route carries
		// (Parker, 2026-10-16): the trailing `publicId` keeps every old link resolving, and
		// the slug half of the address reads the Work's current name. An explicit slug wins.
		let derivedSlug: string | null = null;
		if (data.slug === undefined && data.title !== undefined && data.title.trim() !== "") {
			const next = await makeUniqueSlug(data.title, (slug) => workSlugExists(slug, work.id));
			if (next !== work.slug) derivedSlug = next;
		}

		// Delivery floor, evaluated on the state this edit RESULTS IN. `updateWorkSchema` is
		// `.partial()`, which silently drops any create-time refine, so a PATCH sending only
		// `streamEnabled: false` is valid or not depending on the STORED `downloadEnabled` —
		// something a schema refine cannot see.
		//
		// 🚨 The floor binds only kinds with a delivery to enable. A goods Work (physical,
		// service) delivers by being bought — there is no stream and no download to keep
		// on (the goods-works rule; Parker, 2026-10-09), and requiring one of the two of a
		// shirt would make every goods Work un-editable. The flags are normalized false
		// below for exactly this reason.
		const willStream = data.streamEnabled ?? work.streamEnabled;
		const willDownload = data.downloadEnabled ?? work.downloadEnabled;
		// The floor asks about the kind this edit RESULTS IN, the same way every other
		// gate below reads the row as the request leaves it.
		if (!willStream && !willDownload && !isGoodsType(data.type ?? work.type)) {
			return c.json({ error: "A Work must enable at least one of stream or download" }, 400);
		}

		// 🚨 A quarantined Work is not editable by its creator at all, and a 404 rather than
		// a 403 is deliberate. Delivery is already denied and the media already moved, so
		// nothing here could put it back — but a creator who could still rename it, re-gate
		// it or flip it back to `released` would be operating on material under a
		// preservation hold, and telling them *why* the Work has become untouchable hands a
		// signal to exactly the account we would least like to have one. The admin routes
		// 404 rather than 403 off the admin host for the same reason.
		if (work.quarantineStatus === "quarantined") {
			return c.json({ error: "Work not found" }, 404);
		}

		// An image is its own thumbnail, so a request naming another is refused rather than
		// quietly ignored, before anything is written.
		if (
			isOwnThumbnail(work.type) &&
			data.thumbnail !== undefined &&
			data.thumbnail !== (work.thumbnail ?? "")
		) {
			return c.json(IMAGE_THUMBNAIL_REFUSAL, 400);
		}

		// A file reference is checked when it CHANGES, and before anything is written — the
		// rating below is stored ahead of the release gates, and a refused request must store
		// nothing. Only a change is asked about, so a row written before the check stays
		// editable. `storage/keys.ts` carries the reasons.
		for (const [sent, stored] of [
			[data.sourceKey, work.sourceKey],
			[data.thumbnail, work.thumbnail],
			[data.thumbnailSource, work.thumbnailSource],
		] as const) {
			if (
				sent !== undefined &&
				sent !== (stored ?? "") &&
				!(await isOwnStorageRef(sent, user.id))
			) {
				return c.json(FOREIGN_FILE_REFUSAL, 400);
			}
		}

		// 🚨 **The kind changes only while nothing kind-specific exists to strand.** The
		// drafting rule (Parker, 2026-10-10): a Work can be drafted before its file exists,
		// and the kind a draft starts as often isn't the kind it ends as. Once media exists,
		// the kind is fixed — a comic Work with a video's source file is a row whose every
		// downstream reader (processing, delivery, the reader) disagrees about what it is —
		// and the honest refusal says to make a new Work. Two further guards: a released
		// Work's kind is part of its public listing and never changes here, and an
		// operator-set rating must not be erased by a type change, so that case is refused
		// ahead of the reset rather than silently destroying the correction.
		//
		// The rating reset runs through the rating service: it is the one writer of a Work's
		// maturity, and the reset erases rows answered against the old grid so the new kind
		// is rated on its own terms before release.
		if (data.type !== undefined && data.type !== work.type) {
			if (work.visibility === "released") {
				return c.json(
					{
						error: "A released Work's kind can't change. Make it private first.",
						code: "type_not_private",
					},
					409,
				);
			}
			if (ratingOf(work).locked) {
				return c.json(
					{
						error:
							"An operator set this Work's rating, so its kind can't change. Ask for the rating to be returned first.",
						code: "type_rating_locked",
					},
					409,
				);
			}
			if (work.sourceKey || work.body) {
				return c.json(
					{
						error:
							"This Work already has its media, so its kind can't change. Make a new Work of the other kind instead.",
						code: "type_has_media",
					},
					409,
				);
			}
			work = await resetRatingForTypeChange(work);
			// The rest of this handler — the closed-rung grid, the rating declaration, the
			// readiness gates — reads the kind the request LEAVES the Work as.
			work = { ...work, type: data.type };
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
		const declaring = declaredRating(data.maturityRows, gridFor(work.type)).maturity;
		if (
			work.visibility === "released" &&
			data.visibility !== "private" &&
			declaring !== undefined &&
			releaseRatingRefusal(declaring) === "closed"
		) {
			const rung = maturityLabel(declaring);
			return c.json(
				{
					error: `Anthers isn't accepting ${rung} work at the moment, so a released Work can't be rated ${rung}. Make this Work private and the rating will save — it will keep it until ${rung} reopens.`,
					code: "maturity_rung_closed",
					rung: declaring,
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
		// under-declaration pressure the wiki's *Rating Standard* exists to remove, produced by the gate meant
		// to enforce it. Every readiness refusal below now leaves the rating stored, so a
		// creator whose media is still encoding keeps their answer too.
		//
		// It goes through its own service because it is the one field on this route another
		// party can have decided. A creator lowering an operator's correction is refused
		// here rather than silently dropped — and told where the appeal is, since the
		// refusal is otherwise indistinguishable from the edit not having saved.
		if (data.maturityRows !== undefined) {
			const declared = await declareRating(work, { rows: data.maturityRows });
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

		// 🚨 **The release conditions read the Work as this request leaves it, not as it was
		// loaded.** A piece of writing is its body, and the Edit page sends the body and the release
		// in one save, so asking about the stored body would refuse a piece for being empty in the
		// very request that fills it — the same trap the rating fell into before it was written
		// ahead of these gates. The credits are overlaid for the same reason: a save can tick a
		// Created box and release in one request, and refusing it for the credits it just replaced
		// would be `credits_creator_required` answering a request that satisfied it.

		// A rejected DID credit cannot be re-added.
		if (data.credits !== undefined && data.credits.length > 0) {
			const rejected = await findRejectedCredit(id, data.credits);
			if (rejected) return c.json(REJECTED_CREDIT_REFUSAL, 400);
		}

		const asLeft: typeof work = {
			...(work.type === "text" && data.bodyHtml !== undefined
				? { ...work, bodyHtml: sanitizePostHtml(data.bodyHtml) }
				: work),
			...(data.credits !== undefined ? { credits: data.credits } : {}),
		};

		// 🚨 **Scheduling a release asks the conditions only the creator can fix, and asks them
		// now.** The sweep that releases a scheduled Work runs with nobody at the screen, so a
		// schedule that could only ever be refused should be refused here, where the answer has a
		// user. What resolves on its own — the file arriving, processing, the scan — is exactly
		// what a schedule is for waiting on, so it is not asked. Only a CHANGE to the schedule is
		// checked, so a Work waiting past its time on processing stays editable.
		const scheduleSent = data.scheduledReleaseAt;
		const scheduleChanged =
			scheduleSent !== undefined &&
			(scheduleSent ? Date.parse(scheduleSent) : null) !==
				(work.scheduledReleaseAt?.getTime() ?? null);
		// Releasing now supersedes any schedule the same request carries, so it is not asked about.
		if (scheduleSent && scheduleChanged && data.visibility !== "released") {
			if ((data.visibility ?? work.visibility) !== "private") {
				return c.json(
					{
						error: "Only a private Work can be scheduled for release.",
						code: "schedule_not_private",
					},
					409,
				);
			}
			if (Date.parse(scheduleSent) <= Date.now()) {
				return c.json(
					{ error: "Pick a release time in the future.", code: "schedule_in_past" },
					400,
				);
			}
			const refusal = await releaseRefusal(asLeft, user);
			if (refusal?.resolves === "creator") return c.json(refusal.body, refusal.status);
		}

		// 🚨 **Every release condition lives in `services/work-release.ts`**, because this route
		// and the `release-scheduled` sweep both release Works, and a condition written here alone
		// would be one the sweep walks straight past. The rating is already stored above, so a
		// refusal never costs the creator their declaration.
		if (releasing) {
			const refusal = await releaseRefusal(asLeft, user);
			if (refusal) return c.json(refusal.body, refusal.status);
		}

		const updates: Record<string, unknown> = { updatedAt: new Date() };
		if (data.type !== undefined) updates.type = data.type;
		if (data.slug !== undefined) updates.slug = data.slug;
		else if (derivedSlug) updates.slug = derivedSlug;
		if (data.title !== undefined) updates.title = data.title;
		if (data.description !== undefined) updates.description = data.description;
		if (data.thumbnail !== undefined) updates.thumbnail = data.thumbnail;
		if (data.thumbnailSource !== undefined) updates.thumbnailSource = data.thumbnailSource;
		if (data.thumbnailCrop !== undefined) updates.thumbnailCrop = data.thumbnailCrop;
		if (data.embedUrl !== undefined) updates.embedUrl = data.embedUrl;
		if (data.durationSeconds !== undefined) updates.durationSeconds = data.durationSeconds;
		if (data.note !== undefined) updates.note = data.note;
		// The current version's name. Editing it is a correction to what a reader sees only
		// when that version came after release; a version that is already archived keeps the
		// name it carried then.
		if (data.versionLabel !== undefined) updates.versionLabel = data.versionLabel.trim();
		// A physical Work carries no stream/download flags — delivery is being bought
		// (the goods-works rule), the Studio hides the switches, and any value a raw
		// PATCH or a stale client still sends is dropped rather than stored: a shirt
		// marked streamable would be a store page pretending to be a player.
		if (work.type !== "physical") {
			if (data.streamEnabled !== undefined) updates.streamEnabled = data.streamEnabled;
			if (data.downloadEnabled !== undefined) updates.downloadEnabled = data.downloadEnabled;
		}
		if (data.access !== undefined) {
			const normalized = await normalizeAccessRows(user.id, data.access);
			if ("error" in normalized) return c.json({ error: normalized.error }, 400);
			updates.access = normalized.rows;
		}
		if (data.credits !== undefined) updates.credits = data.credits;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.tags !== undefined) updates.tags = data.tags;
		if (data.websiteUrl !== undefined) updates.websiteUrl = data.websiteUrl;
		if (data.sourceUrl !== undefined) updates.sourceUrl = data.sourceUrl;
		if (data.body !== undefined) updates.body = data.body;
		// Not gated on `work.type === "music"`, unlike bodyHtml below. Only music Works show
		// lyrics, but refusing the write for any other type would silently discard what a
		// creator typed if they ever changed the type — and the column is inert everywhere
		// else, so there is nothing to protect against.
		if (data.lyrics !== undefined) updates.lyrics = data.lyrics;
		// Not gated on `work.type === "image"`, unlike bodyHtml below — same reasoning as
		// lyrics' write above it: inert for every other kind, so refusing the write would
		// only discard what a creator typed.
		if (data.imageAlt !== undefined) updates.imageAlt = data.imageAlt;
		if (data.bodyHtml !== undefined && work.type === "text") {
			updates.bodyHtml = sanitizePostHtml(data.bodyHtml);
			updates.estimatedReadMinutes = estimateReadMinutes(updates.bodyHtml as string);
		}

		// The creator-asserted original release date.
		if (data.originallyReleased !== undefined) {
			updates.originallyReleased = data.originallyReleased
				? new Date(data.originallyReleased)
				: null;
		}

		if (scheduleSent !== undefined) {
			updates.scheduledReleaseAt = scheduleSent ? new Date(scheduleSent) : null;
		}
		// Releasing now supersedes a schedule, whatever the request said about it.
		if (data.visibility === "released") updates.scheduledReleaseAt = null;

		if (data.visibility !== undefined) {
			updates.visibility = data.visibility;
			// Stamped on the FIRST release only. Un-releasing and re-releasing must not
			// rewrite a Work's place in the Catalog's "what's new" ordering.
			if (releasing && !work.releasedAt) updates.releasedAt = new Date();
		}

		const sourceChanged = data.sourceKey !== undefined && data.sourceKey !== work.sourceKey;
		// 🚨 **A bare clear of the column is refused, not obeyed** — setting `sourceKey` to
		// `""` on a Work that has one is a removal request, and removal has a route: a
		// silent clear would strand the old object un-enumerated and any in-flight job
		// un-exitable, which is the exact state the media removal route exists to do
		// honestly. The same for both halves of a paged Work's media.
		if (sourceChanged && !data.sourceKey && work.sourceKey) {
			return c.json(
				{
					error:
						"To remove this Work's media, use the media removal route (DELETE /works/:id/media) rather than clearing the source.",
					code: "source_clear_refused",
				},
				400,
			);
		}
		// A replaced thumbnail is new bytes from the same uploader, so it owes its own scan.
		const thumbnailChanged = data.thumbnail !== undefined && data.thumbnail !== work.thumbnail;
		if (data.sourceKey !== undefined) {
			// A legacy attach is still a new source, so a comic takes the same page-image
			// rule the source-set route runs — the two paths cannot disagree about what a
			// comic may add (Parker, 2026-10-19). An existing PDF is never re-read here.
			const pdfProblem = data.sourceKey
				? comicSourceProblem(work.type, { file: data.sourceKey })
				: null;
			if (pdfProblem) {
				return c.json({ error: pdfProblem, code: "comic_sources_are_images" }, 400);
			}
			updates.sourceKey = data.sourceKey;
			// The version that a change moves away from carries its original pointer with
			// it; the code below sweeps what it named. A new source has no original of its
			// own yet — the remux ingest is the only writer of the pointer after its own
			// ingest, and it writes the work the next remux makes one for.
			if (data.sourceKey !== work.sourceKey) updates.sourceOriginalKey = "";
		}
		// An image is its own thumbnail, and follows its file when the file arrives or is replaced
		// (Parker, 2026-09-18). Decided here rather than by the client, because the file arrives
		// while the creator may be editing the same Work on its page.
		if (sourceChanged && isOwnThumbnail(work.type)) {
			updates.thumbnail = data.sourceKey ?? "";
			updates.thumbnailSource = data.sourceKey ?? "";
			updates.thumbnailCrop = null;
		}

		// A new source is a new version. The prior original is archived before the write, so
		// the sweep below can retire its renditions without touching the bytes the version
		// keeps. A set kind's own rows are the source truth, so its archive belongs in
		// `syncFromSourceKey`, which owns them.
		const archivesSource =
			sourceChanged &&
			!hasSourceSet(work.type) &&
			!!data.sourceKey &&
			!!(work.sourceKey || work.sourceOriginalKey);
		if (sourceChanged) {
			updates.versionAddedAt = new Date();
			// A new version starts unnamed: the name belonged to the version being retired,
			// and the archive carries it from there.
			updates.versionLabel = "";
		}

		let updated: typeof works.$inferSelect;
		let archivedKeeps: Set<string> | null = null;
		if (archivesSource) {
			const result = await db.transaction(async (tx) => {
				const archived = await archiveCurrentMedia(work, tx);
				const [row] = await tx.update(works).set(updates).where(eq(works.id, id)).returning();
				return { row, keeps: archived?.keeps ?? null };
			});
			updated = result.row;
			archivedKeeps = result.keeps;
		} else {
			[updated] = await db.update(works).set(updates).where(eq(works.id, id)).returning();
		}

		// The creator's own credits are affirmed by the assertion itself, recorded before the
		// listing sync below so the record's confirmed set sees them. Run on every write, not
		// only a credits edit, so a self-credit written before this rule existed is healed by
		// the next save (`affirmSelfCredits`).
		await affirmSelfCredits({ workId: id, creatorUserId: user.id, credits: updated.credits });

		// The credited are told when the credit becomes PUBLIC: on the request that releases
		// the Work, or when credits change on one already released. A private Work's credits
		// notify nobody — the page the link points at would 404 for the contributor, and the
		// accept route refuses until a listing exists. The dedupe key collapses a re-save
		// (and an un-release/re-release) to one notification. See `notifyCreditedAccounts`.
		if (releasing || (data.credits !== undefined && updated.visibility === "released")) {
			await notifyCreditedAccounts(updated, user.id);
		}

		// The first release is what makes an account a verified creator, so it is the moment
		// the Discord Creator role is owed. Best-effort: the daily reconcile repairs a
		// failure, and a release must never fail because Discord is down.
		if (releasing && !work.releasedAt) {
			try {
				await syncAccountRoles(user.id);
			} catch (error) {
				console.error("[discord] role sync after a first release failed", error);
			}
		}

		// ⭐ **Fired on every edit rather than only on release**, because the record carries the
		// title, the description and the access state — so an ordinary edit changes what the
		// listing says, and working out which edits matter is exactly the reasoning the job was
		// built to make unnecessary. It re-reads and decides; a no-op costs one read.
		await queueWorkListingSync(id);

		// A new source means the old transcode is stale — re-process. For the paged kinds the
		// set table is the truth, so the legacy attach syncs it (replacing the set with the
		// one file) and re-renders through the service; queueing the job directly here as
		// well would be two jobs for one file.
		//
		// 🚨 **A replacement archives the version it retires, then sweeps that version's
		// renditions.** The creator's original is kept in `work_media_versions`; the prior
		// job rows and every derived output they name leave through `media-purge.ts`, the
		// one writer for what may be deleted. The 2026-10-23 version ruling replaced the
		// no-old-versions ruling of 2026-10-10.
		//
		// A set's source rows are its truth, so `syncFromSourceKey` archives the old set
		// before replacing it. An in-flight job's stale pg-boss delivery finds its row gone
		// and throws at the claim guard — the same precedent DELETE /works/:id's cascade
		// already set.
		if (sourceChanged && updated.sourceKey) {
			const priorJobs = await db
				.select()
				.from(workTranscodingJobs)
				.where(eq(workTranscodingJobs.workId, id));
			if (hasSourceSet(updated.type)) {
				// The old set's files become the version's originals; only the processing
				// rows retire here. `syncFromSourceKey` owns the set rows.
				if (priorJobs.length > 0) {
					await db.delete(workTranscodingJobs).where(eq(workTranscodingJobs.workId, id));
				}
				await syncFromSourceKey(updated, work);
			} else {
				if (work.sourceKey || work.sourceOriginalKey) {
					await purgeReplacedWorkMedia(
						work,
						priorJobs,
						archivedKeeps ? { keep: archivedKeeps } : undefined,
					);
					if (priorJobs.length > 0) {
						await db.delete(workTranscodingJobs).where(eq(workTranscodingJobs.workId, id));
					}
				}
				await queueTranscodeForWork(updated);
			}
		}
		if (sourceChanged || thumbnailChanged) await queueScansForWork(updated);

		const [assetRows, jobRows, buildRows, buildFileRows] = await Promise.all([
			db.select().from(workAssets).where(eq(workAssets.workId, id)),
			db
				.select()
				.from(workTranscodingJobs)
				.where(eq(workTranscodingJobs.workId, id))
				.orderBy(desc(workTranscodingJobs.createdAt)),
			db.select().from(workBuilds).where(eq(workBuilds.workId, id)),
			db
				.select({ file: workBuildFiles })
				.from(workBuildFiles)
				.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
				.where(eq(workBuilds.workId, id)),
		]);
		const filesByBuild = new Map<number, WebBuildFileRow[]>();
		for (const { file } of buildFileRows) {
			const list = filesByBuild.get(file.buildId) ?? [];
			list.push(file);
			filesByBuild.set(file.buildId, list);
		}

		await resolveWorkThumbnail(updated);
		// The Studio adopts this response, and its player drives `transcoding.hlsManifestUrl`,
		// whose raw stored value points at the private bucket — a browser 404 with no CORS
		// headers, and the console noise Parker reported (2026-10-16). The save answers
		// through the same delivery rewrite the owner read branch carries below: the row is
		// playable the way entitled playback is, and a creator may always see their own media.
		const playableJob = await userTranscoding(jobRows[0] ?? null, true, deliveryCtx());
		return c.json({
			work: await serializeWork(
				updated,
				assetRows,
				playableJob,
				buildRows.map((b) => ({ ...b, files: filesByBuild.get(b.id) ?? [] })),
				deliveryCtx(),
			),
		});
	})

	/**
	 * Take the video's paused moment as its thumbnail — server-side.
	 *
	 * ⚠️ **Why the client does not grab the frame itself** (Parker's report, work 23): the
	 * frame the browser draws into a canvas comes from the media element's bytes, and any
	 * cross-origin source taints that canvas — so before the transcode ladder exists, when
	 * the video plays its **original** through a signed cross-origin storage address
	 * (70.06), `canvas.toBlob` throws and the creator was told their browser could not take
	 * a frame it demonstrably could. After the ladder, playback is fed by the page's own
	 * script (hls.js/MSE), which is why the button started working at exactly the moment
	 * processing finished — a dependency on what was playing rather than on the choice
	 * itself. Extracting on the server reads the original in place (`readableInput`) at the
	 * timestamp the creator paused on and works everywhere, for every kind of work, with
	 * no CORS configuration dependency at all.
	 *
	 * The result is stored exactly as an uploaded thumbnail: the creator's own prefix, the
	 * public ACL the thumbnail media type earns, and its own scan (`queueScansForWork`),
	 * because it is new image bytes even though they derive from a cleaned source. The
	 * creator's own save flow never carries this value — the route stores and answers with
	 * the saved row, so the interaction is one act with no raced client state behind it
	 * (see the save-race this closes, the batch edit page's touched-flag bug).
	 *
	 * One extract at a time per Work: rapid clicks stack requests on ffmpeg else, and two
	 * racing extracts writing the same row would be a last-write race over one choice.
	 */
	.post(
		"/works/:id/thumbnail-frame",
		requireAuth,
		zValidator("json", z.object({ atSeconds: z.number().finite().nonnegative() }), invalidBody),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
			if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
			if (work.type !== "video") {
				return c.json(
					{ error: "Only a video can give a frame.", code: "thumbnail_frame_not_video" },
					400,
				);
			}
			if (!work.sourceKey) {
				return c.json(
					{
						error: "This Work has no file yet — play the video first.",
						code: "thumbnail_frame_no_media",
					},
					409,
				);
			}

			const busy = frameExtractionsBusy.has(id);
			if (busy) {
				return c.json(
					{
						error: "A frame from this video is already being taken — one moment.",
						code: "thumbnail_frame_busy",
					},
					409,
				);
			}

			const { atSeconds } = c.req.valid("json");
			frameExtractionsBusy.add(id);
			try {
				// The extraction reads the stored original in place — a fresh signed address;
				// `SOURCE_URL_TTL_SECONDS` above carries the reasoning.
				const input = await storage.readableInput(work.sourceKey);
				let at = atSeconds;
				// The stored duration the transcode wrote stands for the file's length, at
				// whole-second precision. **Inside that duration, no probe runs**: the
				// creator's player bounds `at` to its own playback, so a mid-video moment is
				// inside the file by construction, and asking ffprobe over the stored
				// original (two-plus ranged reads this request waits behind) buys nothing.
				// The probe still runs — with the exact duration and fps the last-frame clamp
				// needs — when the row carries no duration yet, and when the asked moment
				// reaches the stored rounding's last half second, where the difference
				// between the stored and exact bounds is what the clamp exists to hold.
				const storedDuration = work.durationSeconds ?? 0;
				if (!(storedDuration > 1) || atSeconds > storedDuration - 0.5) {
					// Read the duration straight from the stored original, so a paused moment
					// past the end (or a client claiming one) still lands inside the file —
					// and past the last DECODED frame, not merely inside the container: an
					// input seek asks for frames from the moment onward, so a moment past the
					// last frame's own timestamp (an ended video's pause is exactly its
					// duration) yields nothing. One frame earlier is the last displayable
					// picture the file holds.
					const probe = await probeVideo(input);
					if (!probe) {
						return c.json(
							{
								error: "This file has no readable video to take a frame from.",
								code: "thumbnail_frame_unreadable",
							},
							409,
						);
					}
					const lastFrame =
						probe.durationSeconds - (probe.framesPerSecond > 0 ? 1 / probe.framesPerSecond : 0.5);
					at = Math.max(0, Math.min(at, Math.max(lastFrame, 0)));
				}

				// One frame into the pipe: input seeking (`-ss` before `-i`) stops ffmpeg
				// reading past the moment, and `image2pipe` keeps the JPEG on stdout rather
				// than on this process's disk. `ffmpegCommand` pins the threads the plan
				// is sized to (`lib/ffmpeg.ts`).
				const proc = Bun.spawn(
					ffmpegCommand(
						input,
						["-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
						["-v", "error", "-ss", at.toFixed(3)],
					),
					{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
				);
				const withTimeout = Promise.resolve(new Response(proc.stdout).arrayBuffer());
				let jpeg: ArrayBuffer;
				try {
					jpeg = await Promise.race([
						withTimeout,
						new Promise<never>((_, reject) =>
							setTimeout(() => {
								proc.kill();
								reject(new Error("extraction timed out"));
							}, FRAME_EXTRACT_TIMEOUT_MS).unref(),
						),
					]);
				} finally {
					await proc.exited;
				}
				if (jpeg.byteLength === 0) {
					return c.json(
						{
							error:
								"No frame came out of that moment — try pausing somewhere a picture is showing.",
							code: "thumbnail_frame_empty",
						},
						409,
					);
				}

				const uuid = crypto.randomUUID().replace(/-/g, "");
				const key = `creators/${user.id}/thumbnails/${id}/${uuid}.jpg`;
				await storage.upload(key, Buffer.from(jpeg), "image/jpeg", "public");

				const url = await storage.getUrl(key);
				const [updated] = await db
					.update(works)
					// The extracted frame is a full image, so it is its own framing source.
					.set({ thumbnail: url, thumbnailSource: url, thumbnailCrop: null, updatedAt: new Date() })
					.where(eq(works.id, id))
					.returning();
				await queueScansForWork(updated);

				const [assetRows, jobRows] = await Promise.all([
					db.select().from(workAssets).where(eq(workAssets.workId, id)),
					db
						.select()
						.from(workTranscodingJobs)
						.where(eq(workTranscodingJobs.workId, id))
						.orderBy(desc(workTranscodingJobs.createdAt)),
				]);
				const [buildRows, buildFileRows] = await Promise.all([
					db.select().from(workBuilds).where(eq(workBuilds.workId, id)),
					db
						.select({ file: workBuildFiles })
						.from(workBuildFiles)
						.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
						.where(eq(workBuilds.workId, id)),
				]);
				const filesByBuild = new Map<number, WebBuildFileRow[]>();
				for (const { file } of buildFileRows) {
					const list = filesByBuild.get(file.buildId) ?? [];
					list.push(file);
					filesByBuild.set(file.buildId, list);
				}
				// Same delivery rewrite the edit route answers with — the Studio's editor
				// adopts this response while its player is showing `transcoding.hlsManifestUrl`.
				const playableJob = await userTranscoding(jobRows[0] ?? null, true, deliveryCtx());
				return c.json({
					work: await serializeWork(
						updated,
						assetRows,
						playableJob,
						buildRows.map((b) => ({ ...b, files: filesByBuild.get(b.id) ?? [] })),
						deliveryCtx(),
					),
				});
			} finally {
				frameExtractionsBusy.delete(id);
			}
		},
	)

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
	 * 🚨 **This is part of the rating feature rather than a later refinement**, on the *Content Standards* page's
	 * reasoning: because the Adult rung makes a Work invisible to anyone who has
	 * not opted in and verified they are an adult, an over-cautious call does not merely add a
	 * warning to a work, it takes most of its audience away — and for a queer
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

		// Read once: it decides whether to stop and ask before a Work with buyers is taken
		// out of public circulation. It does not decide *how* the Work goes — preservation
		// does that, below.
		const [{ count: soldCount } = { count: 0 }] = await db
			.select({ count: countDistinct(purchases.id) })
			.from(purchases)
			.where(and(eq(purchases.workId, id), eq(purchases.status, "completed")));

		// There is no `post_work_refs` cascade to warn about any more: an embed lives in the
		// post's body, and a deleted Work leaves the link it had exactly where it was — a
		// plain link, no card — the way any embedded page decays. Nothing here strips, so
		// nothing here refuses.
		const force = c.req.valid("query").force;
		if (!force) {
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

		// ── Kept by somebody: withdraw, never destroy ───────────────────────────────
		//
		// The rulings this implements: *if a user purchases something, they own it,
		// regardless of what the creator does down the line* (2026-08-10), and *a Work
		// anybody saved stays available* (Parker, 2026-10-25). Hard-deleting a purchased
		// Work took the thing away from everyone who had paid for it — the `0016` work
		// kept their *receipt*, which is not the same as keeping what they bought — and
		// hard-deleting a saved one takes it away from everyone who chose to keep it.
		//
		// So a forced delete on a preserved Work is a WITHDRAWAL: out of the Catalog, out
		// of the feeds, unpurchasable — every public listing filters *for* `released`, so
		// they exclude it with no change of their own — while the row, the media and the
		// holders' access all stay. Delivery gates on `resolveAccess`, which reads
		// purchases and never visibility, so a buyer's downloads and streams keep working.
		//
		// 🚨 **`works.preserved`, not the purchase count, is the question** (Parker,
		// 2026-10-25). A purchase saves itself to the Library and a save is what sets the
		// flag (`services/preservation.ts`), so every sold Work carries it — and so does a
		// free Work somebody saved, which is the case this door used to destroy. `withdrawn_at`
		// is stamped because the notice and the Library card state it; nothing counts from it.
		if (item.preserved) {
			const withdrawnAt = new Date();
			await db
				.update(works)
				.set({ visibility: "withdrawn", withdrawnAt, updatedAt: new Date() })
				.where(eq(works.id, id));
			// Sends nothing for a saved Work nobody bought: there is no buyer to tell, and
			// the savers are not emailed about a Work they can still open.
			await tellBuyersItWasWithdrawn(id, item.title);
			// 🚨 The delete half, and the one this whole design is shaped around: a listing left
			// up after a withdrawal re-publishes exactly what withdrawing was meant to undo.
			await queueWorkListingSync(id);
			return c.json({ withdrawn: true, purchaseCount: soldCount }, 200);
		}

		const [assetRows, jobRows] = await Promise.all([
			db.select().from(workAssets).where(eq(workAssets.workId, id)),
			db.select().from(workTranscodingJobs).where(eq(workTranscodingJobs.workId, id)),
		]);
		await purgeWorkMedia(item, assetRows, jobRows);

		// The creator's own records go before the row that names them. A gated space for a Work
		// nobody kept has no audience left, so it is deleted with the Work; a studio space
		// belongs to the creator and survives, because it may hold other drafts. Best effort:
		// the creator asked for the Work to go, and being unable to reach a second server is not
		// a reason to refuse. Whatever is left is recorded under the account-deletion and backup
		// paths rather than stranded silently.
		try {
			await removeCreatorSpace(item);
		} catch (err) {
			console.error(
				`[content] work ${id}: creator-space cleanup failed — ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}

		await db.delete(works).where(eq(works.id, id));
		return c.body(null, 204);
	})

	// ── Content-item downloadable assets (builds/variants) ────────────────────────
	.post("/works/:id/assets", requireAuth, zValidator("json", createAssetSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [work] = await db
			.select()
			.from(works)
			.where(and(eq(works.id, id), eq(works.creatorId, user.id)))
			.limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		const data = c.req.valid("json");
		// The asset route signs this key for the Work's owner, so an asset naming another
		// creator's private original would hand it over. See `storage/keys.ts`.
		if (!(await isOwnStorageRef(data.file, user.id))) return c.json(FOREIGN_FILE_REFUSAL, 400);

		const [existingAssets, existingPrimaryWeb] = await Promise.all([
			db.select().from(workAssets).where(eq(workAssets.workId, id)),
			db
				.select({ id: workBuilds.id })
				.from(workBuilds)
				.where(and(eq(workBuilds.workId, id), eq(workBuilds.isPrimary, true))),
		]);
		const replacesPrimary =
			data.isPrimary &&
			(existingAssets.some((asset) => asset.isPrimary) || existingPrimaryWeb.length > 0);
		const firstBuild = existingAssets.length === 0 && existingPrimaryWeb.length === 0;

		if (replacesPrimary) {
			// A new primary build starts a new version: the current builds become the
			// archived original and every prior build row retires. Their files stay — the
			// version owns them — so nothing is swept here.
			const asset = await db.transaction(async (tx) => {
				await archiveCurrentMedia(work, tx);
				await tx.delete(workAssets).where(eq(workAssets.workId, id));
				await tx.delete(workBuilds).where(eq(workBuilds.workId, id));
				const [created] = await tx
					.insert(workAssets)
					.values({ workId: id, ...data })
					.returning();
				await tx
					.update(works)
					.set({ versionAddedAt: new Date(), versionLabel: "" })
					.where(eq(works.id, id));
				return created;
			});
			return c.json({ asset }, 201);
		}

		const [asset] = await db
			.insert(workAssets)
			.values({ workId: id, ...data })
			.returning();
		if (firstBuild) {
			await db
				.update(works)
				.set({ versionAddedAt: new Date(), versionLabel: "" })
				.where(eq(works.id, id));
		}
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
			.delete(workAssets)
			.where(and(eq(workAssets.id, Number(c.req.param("assetId"))), eq(workAssets.workId, id)))
			.returning({ id: workAssets.id });

		if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
		return c.body(null, 204);
	})

	// ── A set-kind Work's source set ─────────────────────────────────────────────
	// The multi-PDF ruling (Parker, 2026-10-10): a comic or book is made from one PDF or
	// several, each file's rendered pages a contiguous run in the creator's arrangement.
	// The image kind rides the same rail (2026-10-18): its set IS the gallery the Work
	// displays, and the service follows its column to the set's first file instead of its
	// newest. These routes are thin over `services/work-source-files.ts`, which owns the
	// invariants.

	.get("/works/:id/source-files", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		// A 404 rather than a 403, the way the works routes answer a non-owner — the
		// existence of another creator's Work is not information to hand out.
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		const files = await listSourceFiles(item);
		return c.json({ files });
	})

	.post(
		"/works/:id/source-files",
		requireAuth,
		zValidator("json", sourceFilesSchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
			// A 404 rather than a 403, the way the works routes answer a non-owner — the
			// existence of another creator's Work is not information to hand out.
			if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
			if (!hasSourceSet(item.type)) {
				return c.json(
					{
						error: "Only a comic, a book or an image carries a set of files.",
						code: "sources_not_set",
					},
					400,
				);
			}
			if (item.visibility === "released") {
				return c.json(
					{
						error: "A released Work's files can't change. Make it private first.",
						code: "sources_not_private",
					},
					409,
				);
			}
			const data = c.req.valid("json");
			const files = "files" in data ? data.files : [data];
			// The set route signs these keys for the Work's owner, so a file naming another
			// creator's private original would hand it over. See `storage/keys.ts`. A whole pick
			// is refused on its first foreign reference, before anything is written.
			const owned = await Promise.all(files.map((file) => isOwnStorageRef(file.file, user.id)));
			if (owned.some((own) => !own)) return c.json(FOREIGN_FILE_REFUSAL, 400);
			const { rows, job, error, code } = await appendSourceFiles(item, files);
			if (error) {
				return c.json({ error, code: code ?? "sources_mixed_shapes" }, 400);
			}
			// Every file in the pick is a new object to scan. One call carrying the whole pick,
			// because the legacy column names only one of them and a per-file call would re-ask
			// for the Work's thumbnail once for every file. The column's value BEFORE this
			// mutation is dropped from the set: it was scanned when it arrived, and the pick is
			// what is new. Only the image kind's sources are scannable objects (a paged set's
			// PDFs and EPUB are not images to fingerprint), which is the coverage the single-file
			// route had.
			await queueScansForWork(
				{ ...item, sourceKey: "" },
				item.type === "image"
					? files.map((file) => ({ key: file.file, kind: "image" as const }))
					: [],
			);
			return c.json({ files: rows, transcoding: job }, 201);
		},
	)

	// ── A released (or draft) set's whole replacement: the new-version path ──
	// 🚨 **This is the one mutation a released set accepts.** Append, reorder and remove
	// edit the version a reader is looking at, so they stay draft-only; a new version is a
	// whole new set, archived first, with the Work's version date moved. See
	// `replaceSourceSet`.
	.put("/works/:id/source-files", requireAuth, zValidator("json", sourceFilesSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (!hasSourceSet(item.type)) {
			return c.json(
				{
					error: "Only a comic, a book or an image carries a set of files.",
					code: "sources_not_set",
				},
				400,
			);
		}
		const data = c.req.valid("json");
		const files = "files" in data ? data.files : [data];
		const owned = await Promise.all(files.map((file) => isOwnStorageRef(file.file, user.id)));
		if (owned.some((own) => !own)) return c.json(FOREIGN_FILE_REFUSAL, 400);
		const { rows, job, error, code } = await replaceSourceSet(item, files);
		if (error) {
			return c.json({ error, code: code ?? "sources_mixed_shapes" }, 400);
		}
		// Every file in the new set is a new object to scan, as in the append route.
		await queueScansForWork(
			{ ...item, sourceKey: "" },
			item.type === "image"
				? files.map((file) => ({ key: file.file, kind: "image" as const }))
				: [],
		);
		return c.json({ files: rows, transcoding: job }, 200);
	})

	.patch(
		"/works/:id/source-files",
		requireAuth,
		zValidator("json", sourceOrderSchema),
		async (c) => {
			const user = c.get("user");
			const id = Number(c.req.param("id"));
			const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
			if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
			if (item.visibility === "released") {
				return c.json(
					{
						error: "A released Work's files can't change. Make it private first.",
						code: "sources_not_private",
					},
					409,
				);
			}
			const { order } = c.req.valid("json");
			const { rows, error } = await reorderSourceFiles(item, order);
			if (error) return c.json({ error }, 400);
			return c.json({ files: rows });
		},
	)

	.delete("/works/:id/source-files/:fileId", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (item.visibility === "released") {
			return c.json(
				{
					error: "A released Work's files can't change. Make it private first.",
					code: "sources_not_private",
				},
				409,
			);
		}
		const job = await removeSourceFile(item, Number(c.req.param("fileId")));
		if (!job) return c.json({ error: "Not found" }, 404);
		return c.json({ transcoding: job });
	})

	// ── A physical Work's listing — the four answers a good needs ────────────
	// What shipping costs, how long the good takes to leave, what it is for tax,
	// and what choices the buyer makes. Everything else about selling a good —
	// its price, its art, its description — is the Work's own and is edited by
	// the fields that already edit it; this is only the part a digital Work has
	// no equivalent of. See `services/physical-listings.ts`.
	//
	// Both routes are owner-only and 404 a stranger's Work rather than 403: a
	// listing is a selling surface, and confirming that a private Work exists
	// would be answering a question a stranger cannot ask.
	.get("/works/:id/physical", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (item.type !== "physical") {
			return c.json(
				{ error: "Only a physical good carries a shipping listing.", code: "not_physical" },
				400,
			);
		}
		return c.json({ listing: await physicalListingFor(id) });
	})

	.put("/works/:id/physical", requireAuth, zValidator("json", physicalListingSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (item.type !== "physical") {
			return c.json(
				{ error: "Only a physical good carries a shipping listing.", code: "not_physical" },
				400,
			);
		}
		// The service collects every problem rather than throwing on the first, so a
		// form reports the whole set; the first message is the response's `error`
		// because that is what a caller renders without walking the list.
		const saved = await savePhysicalListing(id, c.req.valid("json"));
		if (!saved.ok) {
			return c.json(
				{
					error: saved.problems[0]?.message ?? "That listing didn't save.",
					problems: saved.problems,
				},
				400,
			);
		}
		return c.json({ listing: saved.listing });
	});

/** The creator's live frame extractions, one per Work — the request-scoped busy guard
 *  `POST thumbnail-frame` promises. A Set because one Work's extract is one at a time;
 *  two different Works extracting at once is fine (they are the creator's own requests,
 *  each bounded by `FRAME_EXTRACT_TIMEOUT_MS`).
 *
 *  ⚠️ This is process state, and the api component runs one instance today — the honest
 *  shape of a guard that protects one CPU rather than a distributed resource. If the api
 *  component ever runs more, the guard still protects each process's ffmpeg from stacking,
 *  and two extracts racing would need a shared lock — a deliberate step up, not assumed.
 */
export const frameExtractionsBusy = new Set<number>();

/**
 * Tell everyone who bought a Work that the creator has withdrawn it.
 *
 * 🚨 **This closes an asymmetry rather than adding a feature.** `services/account-deletion.ts`
 * has notified buyers since 2026-08-10 when a departing creator's Works are withdrawn.
 * The ordinary withdrawal — a creator deleting a preserved Work from the Studio — reached
 * the same outcome for the same buyer and told them **nothing**. One path told them and
 * the other did not, and which one you got depended on why the creator did it.
 *
 * ⚠️ **A Work saved by readers and bought by nobody has no buyers, so this sends nothing.**
 * Preservation is not a purchase, and the people who saved a withdrawn Work can still open
 * it — there is no lost thing to tell them about.
 *
 * ⚠️ **The dedupe key is deliberately the same namespace `account-deletion.ts` uses**, so a
 * creator who withdraws a Work and later closes their account does not mail the buyer twice
 * about one withdrawal. The two notices word it differently, and the buyer keeps whichever
 * arrived first — the actionable fact is identical in both, and being told twice that a
 * purchase left public circulation is noise rather than diligence.
 *
 * ⭐ **It names no date, because there is no deadline any more** (Parker, 2026-10-25).
 * Purchase preservation became a program: a Work anybody saved is kept indefinitely, so the
 * useful thing to tell a buyer is that nothing is required of them. A notice that named a
 * date would now be inventing one.
 */
export async function tellBuyersItWasWithdrawn(
	workId: number,
	title: string | null,
): Promise<void> {
	const buyers = (
		await db
			.select({ purchaseId: purchases.id, buyerId: purchases.buyerId })
			.from(purchases)
			.where(and(eq(purchases.workId, workId), eq(purchases.status, "completed")))
	).filter((r): r is { purchaseId: number; buyerId: number } => r.buyerId != null);
	if (buyers.length === 0) return;

	const name = title?.trim() || "A Work you bought";

	await notifyMany(
		buyers.map((b) => ({
			userId: b.buyerId,
			// Essential, so it reaches people who turned activity email off: a purchase
			// leaving public circulation is the kind of fact a buyer should not have to
			// go looking for.
			category: "essential" as const,
			kind: "work_withdrawn_by_creator",
			title: `“${name}” has been withdrawn`,
			body: `The creator has taken this out of public circulation. You still own it and it stays in your library — Anthers keeps it available, so there is nothing you need to do.`,
			linkPath: "/library",
			// Per purchase, so two people who bought the same Work each get told and
			// neither gets told twice.
			dedupeKey: `work-withdrawn:${b.purchaseId}`,
		})),
	);
}

export { workEditorRoutes };

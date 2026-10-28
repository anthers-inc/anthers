// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: the delivery door and the Work media it serves.
 *
 * Access issuance, downloads and grants, versions, transcodes, reader payloads, HLS. These
 * are the routes a reader reaches through a Work page, each gated on the Work it names.
 *
 * Split out of `routes/content.ts` on 2026-10-28; docblocks moved with their code.
 */

import { db } from "@anthers/db/client";
import {
	purchases,
	users,
	workAssets,
	workBuilds,
	workPages,
	workSaves,
	workSectionAssets,
	workSections,
	workSourceFiles,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import {
	badgeFor,
	SAVE_BLOB_MAX_BYTES_LABEL,
	SAVE_BLOB_MAX_CHARS,
	SAVE_SYNC_PERK_ERROR,
} from "@anthers/shared/constants";
import { isListened, isPaged } from "@anthers/shared/content";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { refreshQueuePositions } from "../../jobs/queue-position.js";
import { buildDeliveryHost, mintPlayToken, PLAY_TOKEN_TTL_SECONDS } from "../../lib/web-build.js";
import { zipStream } from "../../lib/zip-stream.js";
import { getOptionalUserId, requireAuth, requireCreator } from "../../middleware/auth.js";
import { invalidBody } from "../../middleware/validate.js";
import { heldAnthersBadgeAmount } from "../../services/access.js";
import { mintAccessGrant, verifyAccessGrant } from "../../services/access-grants.js";
import { receiptIdFor } from "../../services/access-receipts.js";
import { accessIssuerDocument, accessSigningKey } from "../../services/access-signing.js";
import { collectWorkMedia, sweepCollected } from "../../services/media-purge.js";
import { queueWorkSave, queueWorkSaveRemoval } from "../../services/reader-state-migration.js";
import { markPurchaseDownloaded } from "../../services/refunds.js";
import { storage } from "../../services/storage/index.js";
import { urlToKey } from "../../services/storage/keys.js";
import {
	findWorkVersion,
	listWorkVersions,
	publicWorkVersions,
	removeWorkVersion,
	summarizeVersion,
	versionFiles,
} from "../../services/work-versions.js";
import {
	buildHlsManifestUrl,
	type DeliveryCtx,
	deliveryCtx,
	findWorkRow,
	parentalTimeGate,
	publicAccessGate,
	publicOrigin,
	queueReaderWrite,
	requesterFor,
	SIGNED_MEDIA_TTL_SECONDS,
	serializeWork,
	userTranscoding,
	workAccessFor,
	workAccessRequestFor,
	workReachability,
} from "../content.js";
import { parseNumericId, requireUserOrShareLink } from "./access.js";
import { grantBody, grantRefusal, saveBlobSchema } from "./schemas.js";

const workMediaRoutes = new Hono()
	.get("/access/issuer.json", (c) => {
		const document = accessIssuerDocument();
		if (!document) return c.json({ error: "No access key is configured." }, 503);
		return c.json(document, 200, { "Cache-Control": "public, max-age=300" });
	})

	/**
	 * Mint a short-lived grant for one file of one Work.
	 *
	 * ⭐ **The grant names the file the download is about to serve**, so a grant for one
	 * asset cannot open another. The ledger decides whether there is anything to grant;
	 * this only states it in a form delivery can check and a third party could verify.
	 *
	 * ⚠️ **A share link is not a grant and cannot mint one.** A recipient with no account
	 * has no DID for the grant to name; the share token is their credential and the download
	 * route accepts it in place of a grant.
	 */
	.post("/works/:id/grant", requireAuth, grantBody, async (c) => {
		const work = await findWorkRow(c.req.param("id") ?? "");
		if (!work) return c.json({ error: "Work not found" }, 404);
		const user = c.get("user");

		const access = await workAccessFor(c, work);
		if (!access.canAccess) {
			return c.json({ error: "Purchase or subscription required", access }, 403);
		}

		const [asset] = await db
			.select({ file: workAssets.file })
			.from(workAssets)
			.where(and(eq(workAssets.id, c.req.valid("json").assetId), eq(workAssets.workId, work.id)))
			.limit(1);
		if (!asset) return c.json({ error: "Asset not found" }, 404);

		const [reader] = await db
			.select({ did: users.atprotoDid })
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);
		if (!reader?.did) return c.json({ error: "This account has no identity." }, 409);

		if (!accessSigningKey()) {
			return c.json({ error: "Access grants are not available right now." }, 503);
		}

		const [purchase] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, user.id),
					eq(purchases.workId, work.id),
					eq(purchases.status, "completed"),
				),
			)
			.orderBy(desc(purchases.id))
			.limit(1);

		try {
			const { token, payload } = mintAccessGrant({
				workId: work.id,
				workUri: work.atprotoUri,
				receipt: purchase ? receiptIdFor(purchase.id, "purchase") : null,
				reader: reader.did,
				basis: access.reason,
				files: [asset.file],
			});
			return c.json({ grant: token, expiresAt: payload.expiresAt });
		} catch {
			return c.json({ error: "Access grants are not available right now." }, 503);
		}
	})

	/*
	 * ── Access-checked asset download ─────────────────────────────────────────────
	 * Assets belong to a Work, and the Work carries the gate. No post is involved: an
	 * entitled user can download from the Catalog whether or not anything was announced.
	 *
	 * 🚨 **A signed-in download must present a grant; a share link is its own credential.**
	 * The ledger is read first and still decides, exactly as before — the grant adds the
	 * scope (this reader, this Work, this file) and the ten-minute life that makes a refund
	 * stop delivery at the next grant rather than never. Expiry is enforced here so a
	 * client that cached one must ask again.
	 */
	.post("/works/:id/assets/:assetId/download", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const [asset] = await db
			.select()
			.from(workAssets)
			.where(and(eq(workAssets.id, Number(c.req.param("assetId"))), eq(workAssets.workId, work.id)))
			.limit(1);
		if (!asset) return c.json({ error: "Asset not found" }, 404);

		// Enforce access server-side — the UI gate is not the source of truth.
		const { access, userId, sharedBy } = await workAccessRequestFor(c, work);
		if (!access.canAccess) {
			return c.json({ error: "Purchase or subscription required", access }, 403);
		}

		if (sharedBy === null) {
			const token = c.req.header("x-anthers-grant")?.trim() ?? "";
			const [reader] = userId
				? await db
						.select({ did: users.atprotoDid })
						.from(users)
						.where(eq(users.id, userId))
						.limit(1)
				: [];
			const verdict =
				reader?.did && token
					? verifyAccessGrant(token, {
							readerDid: reader.did,
							workId: work.id,
							fileKey: asset.file,
						})
					: ({ ok: false, reason: token ? "wrong_reader" : "malformed" } as const);
			if (!verdict.ok) return c.json(grantRefusal(verdict.reason), 403);
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
		// The stamp is a no-op for a downloader who was entitled rather than a buyer,
		// since there is no purchase of theirs to stamp — and for a share-link recipient,
		// who has no account and therefore no purchase at all.
		const downloaderId = await getOptionalUserId(c);
		if (downloaderId != null) void markPurchaseDownloaded(downloaderId, work.id);

		// Assets are stored private; hand back a short-lived signed URL (local mode
		// ignores signing and serves via /content).
		const url = await storage.getUrl(asset.file, { signed: true, expiresIn: 300 });
		return c.json({ url });
	})

	// ── A Work's media versions ──────────────────────────────────────────────────
	//
	// One public read and the creator's archive. `GET …/versions/history` carries the name
	// and date of every version added at or after the Work's first release — maintenance is
	// a reader's fact, and nothing else about a version is. Everything below it is
	// owner-only: a version holds the ORIGINAL bytes a replacement retired, the current media
	// is the Work row, the source set and the build tables, and no file, size, key or
	// download is reachable from a share link or a reader's payload. A non-owner gets the
	// same 404 as a missing Work, because the existence of an old version's files is not
	// something a stranger's request should confirm.

	.get("/works/:id/versions/history", async (c) => {
		const work = await findWorkRow(c.req.param("id") ?? "");
		if (!work) return c.json({ error: "Work not found" }, 404);
		// The same reachability the Work page itself answers: a private Work's history is as
		// absent as the Work, an Adult Work's is as absent as its title, and a buyer reaches
		// the withdrawn Work they own.
		const reach = await workReachability(c, work);
		if ("refusal" in reach) return reach.refusal;
		return c.json({ versions: await publicWorkVersions(work) });
	})

	.get("/works/:id/versions", requireAuth, requireCreator, async (c) => {
		const work = await findWorkRow(c.req.param("id") ?? "");
		if (!work) return c.json({ error: "Work not found" }, 404);
		const userId = await getOptionalUserId(c);
		if (userId !== work.creatorId) return c.json({ error: "Work not found" }, 404);

		const rows = await listWorkVersions(work.id);
		// Each archived version carries its own flag; the Work's current version carries
		// the one on the Work row, and the tab states it beside "Current version".
		return c.json({
			versions: rows.map(summarizeVersion),
			preserved: work.preserved,
		});
	})

	.get("/works/:id/versions/:versionId/download", requireAuth, requireCreator, async (c) => {
		const work = await findWorkRow(c.req.param("id") ?? "");
		if (!work) return c.json({ error: "Work not found" }, 404);
		const userId = await getOptionalUserId(c);
		if (userId !== work.creatorId) return c.json({ error: "Work not found" }, 404);

		const versionId = parseNumericId(c.req.param("versionId") ?? "");
		if (versionId == null) return c.json({ error: "Version not found" }, 404);
		const version = await findWorkVersion(work.id, versionId);
		if (!version) return c.json({ error: "Version not found" }, 404);

		const files = versionFiles(version);
		if (files.length === 0) return c.json({ error: "Version not found" }, 404);
		if (files.length === 1) {
			// A single original is one attachment URL; the browser saves it without this
			// process touching the bytes.
			const url = await storage.getUrl(files[0].file, {
				signed: true,
				expiresIn: 300,
				download: files[0].filename,
			});
			c.header("Cache-Control", "no-store");
			return c.redirect(url, 302);
		}
		// A set or build version is many originals. Stream a store-only zip; see
		// `lib/zip-stream.ts` for why it never materialises the archive.
		return new Response(zipStream(files), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="version-${version.id}.zip"`,
				"Cache-Control": "no-store",
			},
		});
	})

	.delete("/works/:id/versions/:versionId", requireAuth, requireCreator, async (c) => {
		const work = await findWorkRow(c.req.param("id") ?? "");
		if (!work) return c.json({ error: "Work not found" }, 404);
		const userId = await getOptionalUserId(c);
		if (userId !== work.creatorId) return c.json({ error: "Work not found" }, 404);

		const versionId = parseNumericId(c.req.param("versionId") ?? "");
		if (versionId == null) return c.json({ error: "Version not found" }, 404);
		const removed = await removeWorkVersion(work, versionId);
		if (!removed) return c.json({ error: "Version not found" }, 404);
		return c.json({ removed: true as const });
	})

	// ── Transcoding status for a Work ────────────────────────────────────────────
	.get("/works/:id/transcoding", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const jobs = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.workId, work.id))
			.orderBy(desc(workTranscodingJobs.createdAt));

		// Serialized exactly as Work detail does — same helper, same rule. That matters:
		// this route is a second way to reach the same rows, so anything Work detail
		// withholds has to be withheld here too or the poller becomes the side channel
		// around it. Status still flows to a denied user; only the payload URLs don't.
		const access = await workAccessFor(c, work);
		return c.json({
			jobs: await Promise.all(
				jobs.map((job) => userTranscoding(job, access.canAccess, deliveryCtx())),
			),
		});
	})

	/**
	 * Cancel one of the Work's in-flight processing jobs (owner-only).
	 *
	 * 🚨 **Cancel is a mark, not an interrupt.** The route sets the row `canceled`; the
	 * handlers discover it at the checkpoints they already run — the claim-time guards
	 * refuse to resurrect a canceled row past a stale redelivery, the video job's
	 * supersession re-checks abandon before touching storage, and the audio and paged
	 * jobs check before their own upload or page pass. A run already past its last
	 * checkpoint finishes, like the video job's documented per-variant bound. A
	 * `completed` job has nothing to cancel (409), and a `failed` one is already
	 * settled — the Studio's exit from a failure is replace or remove, not cancel.
	 *
	 * Only a pending or processing job cancels: the state this route exists to make
	 * exitable is the one whose exit is otherwise "wait it out".
	 */
	.delete("/works/:id/transcoding/:jobId", requireAuth, async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		const jobId = Number(c.req.param("jobId"));

		// A quarantined Work is untouchable at 404, on the same reasoning as the PATCH —
		// and this route's storage-adjacent half makes it the more important one here.
		if (work.quarantineStatus === "quarantined") {
			return c.json({ error: "Work not found" }, 404);
		}

		const [job] = await db
			.select()
			.from(workTranscodingJobs)
			.where(and(eq(workTranscodingJobs.id, jobId), eq(workTranscodingJobs.workId, work.id)))
			.limit(1);
		if (!job) return c.json({ error: "Job not found" }, 404);
		if (job.status === "completed") {
			return c.json({ error: "This job has already completed." }, 409);
		}
		if (job.status === "failed") {
			return c.json({ error: "This job already failed — replace the media or remove it." }, 409);
		}
		if (job.status === "canceled") {
			return c.json({ work: await serializeWork(work, [], null, [], deliveryCtx()) }, 200);
		}

		await db
			.update(workTranscodingJobs)
			.set({ status: "canceled", etaSeconds: null, updatedAt: new Date() })
			.where(eq(workTranscodingJobs.id, jobId));
		// The canceled row leaves the queue; the ones behind it move up.
		await refreshQueuePositions();

		const [jobRow] = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.id, jobId));
		return c.json(
			{ work: await serializeWork(work, [], jobRow, [], deliveryCtx()), job: jobRow },
			200,
		);
	})

	/**
	 * Remove an unpublished Work's media outright (owner-only) — the creator's clean
	 * slate: everything the Work names in storage leaves (source, the remux-retained
	 * original, derived outputs, the paged set, the ebook prefix, thumbnail, assets and
	 * browser builds), and the row returns to the no-media shape a draft is created in.
	 *
	 * 🚨 **Unpublished only — never-released is the gate, `releasedAt` is its test.** A
	 * released Work's media is behind somebody's purchase or the Time Pool, and a
	 * withdrawn one serves people who bought it; no creator gesture returns either to a
	 * draft. A Work scheduled to release can still call this — removing its media makes
	 * the schedule unmeetable, so the schedule is cleared with the media rather than
	 * left promising a release that can never pass its gate.
	 *
	 * 🚨 **Enumeration before the rows go; sweep after.** `collectWorkMedia` reads the
	 * very rows this route deletes, and `media-purge.ts` owns what may be deleted —
	 * the same straddle the account-erase path runs.
	 */
	.delete("/works/:id/media", requireAuth, async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (work.quarantineStatus === "quarantined") {
			return c.json({ error: "Work not found" }, 404);
		}
		if (work.releasedAt) {
			return c.json(
				{
					error: "Only an unpublished Work's media can be removed.",
					code: "media_removal_published",
				},
				409,
			);
		}

		// Enumerate first — the rows below are what the enumeration reads.
		const collected = await collectWorkMedia([work.id]);

		await db.transaction(async (tx) => {
			await tx.delete(workBuilds).where(eq(workBuilds.workId, work.id));
			await tx.delete(workAssets).where(eq(workAssets.workId, work.id));
			await tx.delete(workSections).where(eq(workSections.workId, work.id));
			await tx.delete(workSectionAssets).where(eq(workSectionAssets.workId, work.id));
			await tx.delete(workPages).where(eq(workPages.workId, work.id));
			await tx.delete(workSourceFiles).where(eq(workSourceFiles.workId, work.id));
			await tx.delete(workTranscodingJobs).where(eq(workTranscodingJobs.workId, work.id));
			await tx
				.update(works)
				.set({
					sourceKey: "",
					sourceOriginalKey: "",
					thumbnail: "",
					thumbnailSource: "",
					thumbnailCrop: null,
					durationSeconds: null,
					scheduledReleaseAt: null,
					updatedAt: new Date(),
				})
				.where(eq(works.id, work.id));
		});

		await sweepCollected(collected);

		const [row] = await db.select().from(works).where(eq(works.id, work.id));
		return c.json({ work: await serializeWork(row, [], null, [], deliveryCtx()) }, 200);
	})

	// ── Audio delivery (access-checked, signed) ──────────────────────────────────
	// The audio counterpart of the HLS endpoint below. Processed audio is stored private,
	// so this is the only way to reach it: access is re-checked here on every request,
	// then we redirect to a short-lived signed CDN URL. A redirect rather than a proxy so
	// range requests (seeking) go straight to the CDN instead of through the API.
	.get("/works/:id/audio", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		// 402, not 403: the user is not forbidden, they have spent a monthly allowance
		// that the Public Access price removes. The status code is the difference between "you may not"
		// and "you may, and here is how".
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		// A household's own limit, which is a refusal rather than a price — see
		// `parentalTimeGate` for why the two gates stay separate.
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const [job] = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.workId, work.id))
			.orderBy(desc(workTranscodingJobs.createdAt))
			.limit(1);
		if (!job?.outputFileUrl) return c.json({ error: "Not found" }, 404);

		const url = await storage.getUrl(urlToKey(job.outputFileUrl), {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		// no-store so the 302 (which carries a signed URL, and is access-dependent) is
		// never cached by a proxy and replayed at a user who shouldn't have it.
		c.header("Cache-Control", "no-store");
		return c.redirect(url, 302);
	})

	// ── Original delivery (access-checked, signed) ───────────────────────────────
	//
	// A Work's original is playable from the moment it exists — the 2026-10-11
	// ruling for video (wiki 70.06), widened to the listened kinds on 2026-10-16 so
	// a track under processing plays the bytes the creator uploaded while its MP3
	// rendition and waveform are made. What plays here is the Work's own stored
	// original, ranged-streamed over a short-lived signed address. Same gate ladder
	// as the audio route above: access, the Public Access meter, the household
	// limit; a fresh signed URL minted only after every gate answered. The
	// processed deliverable stays the offered experience when it exists, and this
	// route is what the client falls back to before one does — or permanently, for
	// an original whose processing failed.
	.get("/works/:id/original", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);
		// The original is the play surface for a video and for the listened kinds;
		// a paged or written kind's source is not a play surface at all.
		if ((work.type !== "video" && !isListened(work.type)) || !work.sourceKey) {
			return c.json({ error: "Not found" }, 404);
		}

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		// 402, not 403, on exactly the reasoning the audio route carries above.
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const url = await storage.getUrl(work.sourceKey, {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		// no-store, for the same reason as the audio redirect: this 302 carries a
		// signed URL and is access-dependent, so a proxy must never replay it.
		c.header("Cache-Control", "no-store");
		return c.redirect(url, 302);
	})

	// ── Ebook page delivery (access-checked, signed) ─────────────────────────────
	//
	// The reason `work_pages` exists, in one endpoint: a book is served ONE PAGE AT A TIME,
	// through a check, rather than as a single file whose URL is the whole book. Same shape
	// as the audio route above — re-resolve access, meter the commons, redirect to a
	// short-lived signed URL.
	.get("/works/:id/pages/:page", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const pageNumber = parseNumericId(c.req.param("page"));
		if (pageNumber == null) return c.json({ error: "Not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		// 402, not 403: the user is not forbidden, they have spent a monthly allowance
		// that the Public Access price removes. Reading the commons draws it exactly as watching does —
		// the equal-time principle is about what a minute IS, not about which medium.
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		// A household's own limit, which is a refusal rather than a price — see
		// `parentalTimeGate` for why the two gates stay separate.
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

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

	// ── Ebook reflow delivery: sections and assets (access-checked, signed) ─────
	//
	// The reflow counterpart of the page route's ladder. An EPUB's ingest extracted the
	// container into `work_sections` (chapters, in reading order) and `work_section_assets`
	// (the images, stylesheets and fonts those chapters reference), stored private under
	// the same rule the pages are — so `downloadEnabled: false` stays honest for a reflow
	// book too: no one URL the whole title falls out of. The manifest is what the reader's
	// loader maps references through (it carries container-relative paths, the stable
	// identity a re-ingest keeps), and the two unit routes mint short-lived signed URLs
	// behind the same gate ladder the page route runs — access, the Public Access meter,
	// the household limit.
	//
	// The manifest is metadata: it gates on access and the household limit (chapter titles
	// are part of the Work), but the meter draws on the units, where attention actually
	// goes — there is no minute spent opening a table of contents.
	.get("/works/:id/sections", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const [sectionRows, assetRows] = await Promise.all([
			db
				.select()
				.from(workSections)
				.where(eq(workSections.workId, work.id))
				.orderBy(asc(workSections.position)),
			db
				.select()
				.from(workSectionAssets)
				.where(eq(workSectionAssets.workId, work.id))
				.orderBy(asc(workSectionAssets.id)),
		]);
		return c.json({
			sections: sectionRows.map((s) => ({
				position: s.position,
				href: s.href,
				title: s.title,
				// The byte size the reading progress math reads (foliate's SectionProgress
				// weights a book's locations by section size); never a width or height —
				// reflow has no fixed geometry.
				size: s.sizeBytes,
				// Paths the client prefixes with its API base the way the page reader
				// composes its page URLs (`${apiBase}/api/content/works/…`); never a
				// hand-rolled origin.
				url: `/api/content/works/${work.id}/sections/${s.position}`,
			})),
			assets: assetRows.map((a) => ({
				path: a.path,
				mimeType: a.mimeType,
				url: `/api/content/works/${work.id}/assets/${a.id}`,
			})),
		});
	})

	// One reflow section, one check, one signed address — the page route's shape to the
	// byte, because the reader's loader must never learn a second way to ask.
	.get("/works/:id/sections/:section", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const position = parseNumericId(c.req.param("section"));
		if (position == null) return c.json({ error: "Not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		// 402, not 403, for the reason the page route carries: reading the commons draws
		// the allowance exactly as watching does — the equal-time principle is about what
		// a minute IS, not about which medium.
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const [section] = await db
			.select()
			.from(workSections)
			.where(and(eq(workSections.workId, work.id), eq(workSections.position, position)))
			.limit(1);
		if (!section) return c.json({ error: "Not found" }, 404);

		const url = await storage.getUrl(section.file, {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		// no-store: this 302 carries a signed URL and is access-dependent, for the same
		// reason as every redirect above.
		c.header("Cache-Control", "no-store");
		return c.redirect(url, 302);
	})

	// One asset — an image, a stylesheet, a font a chapter's XHTML references — through
	// its own check. The manifest is what makes this possible: the reader maps a
	// chapter's references from container-relative paths to these routes, so serving a
	// picture to a page never re-serves the book.
	.get("/works/:id/assets/:assetId", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const assetId = parseNumericId(c.req.param("assetId"));
		if (assetId == null) return c.json({ error: "Not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const [asset] = await db
			.select()
			.from(workSectionAssets)
			.where(and(eq(workSectionAssets.workId, work.id), eq(workSectionAssets.id, assetId)))
			.limit(1);
		if (!asset) return c.json({ error: "Not found" }, 404);

		const url = await storage.getUrl(asset.file, {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		c.header("Cache-Control", "no-store");
		return c.redirect(url, 302);
	})
	//
	// A hosted build's files answer on the Work's delivery origin, where the Anthers
	// session never arrives — so the entitlement is this route's answer: signed, per
	// request, minted at a moment the same gate ladder the audio and page routes ran was
	// just checked. *How a File Reaches You*'s rule, carried to creator code; the delivery
	// module (`routes/build-delivery.ts`) is the serve half.
	.get("/works/:id/play", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		// The meter and the household limit are checked at the MINT, on the same reasoning
		// as the HLS playlist: the delivery origin never calls back to the API per file,
		// so this route is the last point at which the commons can be declined. Refusing
		// here is what stops a play session continuing.
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		// The primary build is what "play" means; a non-primary variant is registered
		// storage, not the Work's playable state.
		const [build] = await db
			.select({ id: workBuilds.id, entryPath: workBuilds.entryPath })
			.from(workBuilds)
			.where(and(eq(workBuilds.workId, work.id), eq(workBuilds.isPrimary, true)))
			.limit(1);
		if (!build) return c.json({ error: "This Work has no hosted build." }, 404);

		const host = buildDeliveryHost(work.publicId, process.env, new URL(c.req.url).host);
		if (!host) {
			// A public deployment without a delivery origin configured is OFF, not weakened:
			// the feature refuses rather than serving from a host that shares ancestry with
			// the session cookie. A checkout answers on its own origin instead.
			return c.json({ error: "Hosted build delivery is not configured." }, 501);
		}
		const token = mintPlayToken(work.id, PLAY_TOKEN_TTL_SECONDS);
		// The token is the path PREFIX, so the build's own relative references — the wasm,
		// the pck, the worklets — resolve underneath it with no HTML rewriting.
		//
		// Scheme: a per-Work host (suffix set) is a real or portless-CA'd https origin
		// in every environment that names one — https always. A checkout serving on its
		// own host takes the request's own scheme, because dev's http localhost would
		// otherwise mint a mixed-content iframe that never loads — but behind the dev
		// proxy the loopback request is plain http while the origin the browser reached
		// is https, and the proxy's X-Forwarded-Proto says so (a minted src in the other
		// scheme upgrades in Chrome to a frame whose `event.origin` then fails the
		// parent's every sender check, silently killing the save relay; found live,
		// 2026-10-17).
		const suffixSet = Boolean(process.env.BUILD_ORIGIN_SUFFIX?.trim());
		const scheme = suffixSet
			? "https"
			: (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", ""));
		const src = `${scheme}://${host}/build/${token}/${build.entryPath}`;
		// no-store: the answer carries an entitlement and is access-dependent — the same
		// reasoning the audio route's 302 carries.
		c.header("Cache-Control", "no-store");
		return c.json({ src, expiresIn: PLAY_TOKEN_TTL_SECONDS });
	})

	// ── Cloud saves — the serving half of the settled save design ────────────────
	//
	// One blob per (player, Work), newest write wins; the full contract lives on
	// `workSaves`'s schema doc. Three rules govern these routes:
	//
	// 🚨 **The caller is the page, never the build.** The request holds the Anthers
	// session, which by design never reaches the delivery origin — so a request here is
	// one the player's own page made. A build could only reach these routes through the
	// player's credentials, which is the same wall every other user-facing route sits
	// behind.
	//
	// 🚨 **Sync is the Badge perk; the local save is the floor.** Both directions check
	// the held Anthers Badge: a lapsed holder's writes are refused with the local copy
	// untouched — what lapsing costs is portability, never the save. The read is
	// Badge-gated too (it is the same syncing act in the other direction).
	//
	// 🚨 **Reads and writes pass the same access check as delivery** — you sync a save
	// only for a Work you can currently reach. Share links do not carry saves: a save
	// belongs to the player's account, and a link is not an account (the refusal is
	// `requireAuth`, which is also why this route does not take `requireUserOrShareLink`).
	.put("/works/:id/save", requireAuth, zValidator("json", saveBlobSchema), async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		// The perk is a held Anthers Badge, read the same way the Badges page reads it.
		const held = await heldAnthersBadgeAmount(user.id);
		if (badgeFor(held).badge === null) {
			return c.json({ error: SAVE_SYNC_PERK_ERROR }, 402);
		}

		const { blob, runtime, note } = c.req.valid("json");
		const bytes = blob.length; // a base64 string's length bounds the bytes above it
		if (bytes > SAVE_BLOB_MAX_CHARS) {
			return c.json({ error: `That save is over the ${SAVE_BLOB_MAX_BYTES_LABEL} limit.` }, 413);
		}

		// The upsert IS the newest-write-wins rule: one row, replaced whole.
		const [save] = await db
			.insert(workSaves)
			.values({ userId: user.id, workId: work.id, blob, runtime, note, byteSize: bytes })
			.onConflictDoUpdate({
				target: [workSaves.userId, workSaves.workId],
				set: {
					blob: sql`excluded.blob`,
					runtime: sql`excluded.runtime`,
					note: sql`excluded.note`,
					byteSize: sql`excluded.byte_size`,
					updatedAt: new Date(),
				},
			})
			.returning({ id: workSaves.id, updatedAt: workSaves.updatedAt });
		queueReaderWrite(() => queueWorkSave(user.id, work.id));
		return c.json({ saved: true as const, updatedAt: save.updatedAt });
	})
	.get("/works/:id/save", requireAuth, async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);

		const held = await heldAnthersBadgeAmount(user.id);
		if (badgeFor(held).badge === null) {
			return c.json({ error: SAVE_SYNC_PERK_ERROR }, 402);
		}

		const [save] = await db
			.select()
			.from(workSaves)
			.where(and(eq(workSaves.userId, user.id), eq(workSaves.workId, work.id)))
			.limit(1);
		// A Work with no cloud save yet is a 200 with `save: null` — that is the shape a
		// shim restores from: play locally, sync when there is something to sync.
		return c.json({
			save: save
				? { blob: save.blob, runtime: save.runtime, note: save.note, updatedAt: save.updatedAt }
				: null,
		});
	})
	.delete("/works/:id/save", requireAuth, async (c) => {
		const user = c.get("user");
		const [deleted] = await db
			.delete(workSaves)
			.where(and(eq(workSaves.userId, user.id), eq(workSaves.workId, Number(c.req.param("id")))))
			.returning({ id: workSaves.id });
		// Deleting your own save is a playerRight-shaped act and needs no gate beyond
		// owning it: it removes only the synced copy, never the game's local one.
		if (deleted != null) {
			queueReaderWrite(() => queueWorkSaveRemoval(user.id, Number(c.req.param("id"))));
		}
		return c.json({ deleted: deleted != null });
	})

	// ── Panels (comic page regions) ──────────────────────────────────────────────
	// The panel geometry for a Work, for the user's panel mode and the Studio's
	// correction surface. Same access gates as `/pages/:n`: a share link recipient can read
	// it, but a signed-out caller cannot, and the same public-access / parental gates apply.
	//
	// ⭐ **Guided view is off until the creator turns it on for that page, and detection
	// proposes to the creator and to nobody else.** A page's `guided_view` flag is the
	// opt-in; its `panels` are only proposals until a creator confirms them. So the
	// Work's owner reads both, and every other caller gets geometry only for pages that
	// are enabled *and* confirmed. Everything else comes back as a page with no panels,
	// which the reader treats as a whole page — a comic publishes with no panel work at
	// all.
	.get("/works/:id/panels", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);

		const viewerId = await getOptionalUserId(c);
		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		const metered = await publicAccessGate(c, work, access);
		if (metered) return c.json(metered, 402);
		const limited = await parentalTimeGate(viewerId, work);
		if (limited) return c.json(limited, 403);

		const correcting = viewerId != null && viewerId === work.creatorId;
		const pages = await db
			.select({
				pageNumber: workPages.pageNumber,
				width: workPages.width,
				height: workPages.height,
				guidedView: workPages.guidedView,
				panels: workPages.panels,
			})
			.from(workPages)
			.where(eq(workPages.workId, work.id))
			.orderBy(workPages.pageNumber);

		return c.json({
			pages: pages.map((page) => ({
				...page,
				// The owner sees every region, proposals included. Every other caller gets
				// the confirmed regions of an enabled page, and nothing for the rest.
				panels: correcting
					? page.panels
					: page.guidedView
						? page.panels.filter((panel) => !panel.auto)
						: [],
			})),
		});
	})

	/**
	 * Turn guided view on or off for one page, and/or replace that page's panels.
	 *
	 * 🚩 **`enabled` and `panels` are separate acts, and turning guided view on is the
	 * opt-in.** `enabled: true` alone keeps the detector's proposals as proposals, which
	 * the Studio shows for confirming; sending `panels` is what defines them (every region
	 * a save writes is `auto: false`). `enabled: false` leaves the proposals in place so
	 * turning the page back on does not lose them, and the reader ignores them either way.
	 * A request carrying neither is refused rather than read as an accidental no-op.
	 */
	.patch(
		"/works/:id/panels",
		requireAuth,
		requireCreator,
		zValidator(
			"json",
			z.object({
				pageNumber: z.number().int().positive(),
				enabled: z.boolean().optional(),
				panels: z
					.array(
						z.object({
							panelNumber: z.number().int().positive().optional(),
							x: z.number().min(0).max(1),
							y: z.number().min(0).max(1),
							width: z.number().min(0).max(1),
							height: z.number().min(0).max(1),
						}),
					)
					.optional(),
			}),
			invalidBody,
		),
		async (c) => {
			const work = await findWorkRow(c.req.param("id") ?? "");
			if (!work) return c.json({ error: "Work not found" }, 404);

			const userId = await getOptionalUserId(c);
			if (userId !== work.creatorId) return c.json({ error: "Forbidden" }, 403);
			if (!isPaged(work.type)) return c.json({ error: "Not a paged Work" }, 400);

			const { pageNumber, enabled, panels } = c.req.valid("json");
			if (enabled === undefined && panels === undefined) {
				return c.json({ error: "Send enabled, panels, or both" }, 400);
			}
			for (const p of panels ?? []) {
				if (p.width === 0 || p.height === 0) {
					return c.json({ error: "Panel width and height must be greater than 0" }, 400);
				}
				if (p.x + p.width > 1 || p.y + p.height > 1) {
					return c.json({ error: "Panel exceeds page bounds" }, 400);
				}
			}

			const [page] = await db
				.select({
					id: workPages.id,
					guidedView: workPages.guidedView,
				})
				.from(workPages)
				.where(and(eq(workPages.workId, work.id), eq(workPages.pageNumber, pageNumber)))
				.limit(1);
			if (!page) return c.json({ error: "Page not found" }, 404);

			const update: Record<string, unknown> = {};
			if (enabled !== undefined) update.guidedView = enabled;
			if (panels !== undefined) {
				update.panels = panels
					.sort((a, b) => {
						const rowA = Math.round(a.y * 100);
						const rowB = Math.round(b.y * 100);
						if (rowA !== rowB) return rowA - rowB;
						return Math.round(a.x * 100) - Math.round(b.x * 100);
					})
					.map((p, i) => ({
						panelNumber: i + 1,
						x: p.x,
						y: p.y,
						width: p.width,
						height: p.height,
						auto: false,
					}));
			}

			await db.update(workPages).set(update).where(eq(workPages.id, page.id));

			return c.json({ ok: true, guidedView: enabled ?? page.guidedView });
		},
	)

	// ── HLS delivery (access-checked, signed segments) ───────────────────────────
	// Serves the master + variant playlists for a video Work, rewriting segment refs to
	// short-lived signed CDN URLs. Segments are always private, so EVERY accessible Work
	// (free or gated) is pointed here by serializeWorkForUser; this check is the gate.
	.get("/works/:id/hls/:file", requireUserOrShareLink, async (c) => {
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
		// A household's own limit, which is a refusal rather than a price — see
		// `parentalTimeGate` for why the two gates stay separate.
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const workId = work.id;
		const [job] = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.workId, workId))
			.orderBy(desc(workTranscodingJobs.createdAt))
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

		// 🚨 **A recipient's token rides onto the variant URLs, or a shared video never starts.**
		// hls.js requests each variant exactly as the master lists it, and somebody watching by
		// share link has no session to fall back on, so a variant URL without the token is a 401
		// while the page and the master playlist both look fine. Carried only when the user
		// really arrived by the link, the same rule the Work page applies.
		const { sharedBy } = await requesterFor(c, workId);
		const rewritten = await rewriteHlsPlaylist(new TextDecoder().decode(bytes), {
			isMaster: file === "master.m3u8",
			prefixKey,
			ctx: {
				origin: publicOrigin(),
				share: sharedBy != null ? (c.req.query("share") ?? null) : null,
			},
			workId,
		});
		return c.body(rewritten, 200, {
			"Content-Type": "application/vnd.apple.mpegurl",
			"Cache-Control": "no-store",
		});
	});

/**
 * Rewrite an HLS playlist for signed delivery. In the master, child variant playlists
 * are pointed back through this access-checked endpoint; in a variant playlist, each
 * segment (.ts) becomes a short-lived signed CDN URL. Comment/tag lines pass through.
 */
export async function rewriteHlsPlaylist(
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

export { workMediaRoutes };

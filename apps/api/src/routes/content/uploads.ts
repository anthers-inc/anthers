// SPDX-License-Identifier: Apache-2.0
/**
 * Content routes: uploads and the media a Work or post embeds.
 *
 * The multipart and direct upload doors, captions and previews, and inline images.
 *
 * Split out of `routes/content.ts` on 2026-10-28; docblocks moved with their code.
 */

import { db } from "@anthers/db/client";
import { inlineImages, workCaptionTracks, works } from "@anthers/db/schema";
import { isImageFrameType, normalizeCrop } from "@anthers/shared/image-frame";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getOptionalUserId, requireAuth } from "../../middleware/auth.js";
import {
	attachCaptionTrack,
	attachPreviewCaptionTrack,
	type CaptionTrackRow,
	deleteCaptionTrack,
	deletePreviewCaptionTrack,
	listCaptionTracks,
	listPreviewCaptionTracks,
	listPreviewCaptionTracksForWork,
	VttRefusal,
} from "../../services/captions.js";
import { framedImageKey, frameImage, ImageFrameRefusal } from "../../services/image-framing.js";
import { scanInlineUpload } from "../../services/safety-scan.js";
import { aclForMediaType, scannedObjectKind } from "../../services/storage/acl.js";
import { isLocalStorage, storage } from "../../services/storage/index.js";
import { FOREIGN_FILE_REFUSAL, isOwnStorageRef, urlToKey } from "../../services/storage/keys.js";
import { mediaUploadKeyFor } from "../../services/upload-sessions.js";
import {
	attachPreviewMedia,
	findPreviewMedia,
	listPreviewMedia,
	PreviewMediaRefusal,
	removePreviewMedia,
	reorderPreviewMedia,
	updatePreviewMedia,
} from "../../services/work-preview-media.js";
import {
	buildCaptionUrl,
	type DeliveryCtx,
	deliveryCtx,
	findWorkRow,
	localDelivery,
	parentalTimeGate,
	SIGNED_MEDIA_TTL_SECONDS,
	serializePreviewCaptionRow,
	serializePreviewMedia,
	workAccessFor,
	workReachability,
} from "../content.js";
import { requireUserOrShareLink } from "./access.js";
import {
	captionAttachSchema,
	previewAttachSchema,
	previewOrderSchema,
	previewUpdateSchema,
} from "./schemas.js";

const uploadsRoutes = new Hono()
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
				mediaType: z.enum(["video", "audio", "asset", "preview-video"]),
			}),
		),
		async (c) => {
			const { filename, contentType, mediaType } = c.req.valid("json");
			const user = c.get("user");

			// The key naming is the session service's one naming — a session's destination
			// and a presign's destination are the same layout by construction now, not by
			// two kept-in-step literals.
			const key = mediaUploadKeyFor(user.id, mediaType, filename);

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
	 * Direct multipart upload — local dev, and small files (avatars, banners, thumbnails)
	 * in all modes.
	 */
	.post("/media-upload/direct", requireAuth, async (c) => {
		const user = c.get("user");
		const formData = await c.req.formData();
		const file = formData.get("file");
		const mediaType = formData.get("mediaType") as string | null;
		const entityId = formData.get("entityId") as string | null;

		if (!(file instanceof File)) return c.json({ error: "No file provided" }, 400);

		const isMedia =
			mediaType === "video" ||
			mediaType === "audio" ||
			mediaType === "asset" ||
			mediaType === "preview-video";
		const maxSize = isMedia ? 500 * 1024 * 1024 : 10 * 1024 * 1024;
		if (file.size > maxSize) {
			return c.json({ error: `File too large (max ${isMedia ? "500MB" : "10MB"})` }, 413);
		}

		const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
		const uuid = crypto.randomUUID().replace(/-/g, "");
		const prefix = `creators/${user.id}`;
		let key: string;
		// Which quarantine subject a match on this object would name. `null` means the
		// object is not scanned here at all — see `scannedObjectKind`.
		const objectKind = scannedObjectKind(mediaType);

		switch (mediaType) {
			case "video":
				key = `${prefix}/videos/originals/${uuid}.${ext}`;
				break;
			case "audio":
				key = `${prefix}/audio/originals/${uuid}.${ext}`;
				break;
			case "caption":
				// A caption upload lands under the entityId'd Work's directory and is
				// validated as WebVTT at attach (`services/captions.ts`), which is also why
				// it is not perceptually scanned here: a hash of still frames has nothing to
				// read in a text file, and anything disguised as a caption dies at that
				// parse — a refusal that leaves a row never created.
				key = `${prefix}/captions/${entityId ?? "unknown"}/${uuid}.vtt`;
				break;
			case "preview-caption":
				// The trailer's counterpart: `entityId` is the preview row, so one preview's
				// tracks share a directory and the purge can name them. Same WebVTT parse at
				// attach, same reason for no perceptual scan.
				key = `${prefix}/previews/captions/${entityId ?? "unknown"}/${uuid}.vtt`;
				break;
			case "preview-image":
				// Every preview object sits under one `previews/` prefix. The screenshot's
				// directory is the Work, so a creator's set is legible on disk as well as in
				// the table.
				key = `${prefix}/previews/images/${entityId ?? "unknown"}/${uuid}.${ext}`;
				break;
			case "preview-video":
				key = `${prefix}/previews/videos/${uuid}.${ext}`;
				break;
			case "avatar":
				key = `${prefix}/avatars/${uuid}.${ext}`;
				break;
			// ⚠️ `header` and `cover` are the retired words, kept as accepted aliases for a tab
			// opened before the rename: the media-type allowlist fails closed, so dropping one
			// would store that tab's upload private. New requests send `banner` and `thumbnail`.
			case "banner":
			case "header":
				key = `${prefix}/banners/${uuid}.${ext}`;
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
		// mediaType this route doesn't recognize (it arrives unvalidated off the form).
		const acl = aclForMediaType(mediaType);

		const buffer = Buffer.from(await file.arrayBuffer());
		await storage.upload(key, buffer, file.type, acl);
		// 🚨 **Scanned inline, and this is the door the child-safety coverage map describes as
		// the inline path.** The bytes are fully buffered here, so there is nothing to defer to a
		// job — and unlike a Work there is no release gate behind which a queued scan could
		// catch up, because an avatar is visible the moment the row points at it.
		//
		// ⭐ **A match quarantines the object rather than deleting it**, through
		// `scanInlineUpload` → `quarantineObject`: the § 2258A(h) hold is placed on the
		// uploader and the finding reaches the operator queue, which is exactly what a Work's
		// match gets. Only the video, audio and asset branches are skipped, because a
		// perceptual image hash has nothing to say about any of them and the file may be
		// 500 MB. Those go through `QUEUES.SCAN_MEDIA` once they are attached to a Work.
		if (objectKind) {
			// The bytes are the ones this request just buffered and PUT — the scan reads
			// them in hand rather than pulling the object back out of storage, sparing the
			// save a second full pass of the image across the network.
			const outcome = await scanInlineUpload(key, { uploaderId: user.id, objectKind }, buffer);
			if (outcome.quarantine) {
				return c.json({ error: "That image cannot be used.", code: "refused" }, 422);
			}
		}

		const url = await storage.getUrl(key);

		return c.json({ key, url }, 201);
	})

	/**
	 * Frame a stored display image at the surface's display aspect, nondestructively.
	 *
	 * ⭐ **The body names the full source and a window on it, never a new file.** The route reads
	 * the object the creator already uploaded, crops that window with sharp, and writes a
	 * derivative beside it; the surface saves the derivative in its display column and keeps the
	 * source in its `*_source` column. A later reposition therefore starts from the whole picture
	 * again rather than from the last crop, which is what makes zooming back out work.
	 *
	 * 🚨 **The source is validated as the creator's own upload.** It is a client-supplied
	 * reference that the route reads bytes from, so a foreign one would let a creator frame
	 * somebody else's file into their own public surface — the same door `isOwnStorageRef`
	 * closes on every other stored-reference write.
	 *
	 * The derivative takes the same inline scan the direct upload does, because it is display
	 * chrome visible the moment the row points at it.
	 */
	.post(
		"/media-upload/frame",
		requireAuth,
		zValidator(
			"json",
			z.object({
				source: z.string().min(1).max(500),
				mediaType: z.string(),
				crop: z.unknown(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { source, mediaType, crop: rawCrop } = c.req.valid("json");
			if (!isImageFrameType(mediaType)) {
				return c.json({ error: "That image surface can't be framed.", code: "frame_type" }, 400);
			}
			const crop = normalizeCrop(rawCrop);
			if (!crop) {
				return c.json({ error: "That frame isn't a valid window.", code: "frame_crop" }, 400);
			}
			if (!(await isOwnStorageRef(source, user.id))) {
				return c.json(FOREIGN_FILE_REFUSAL, 403);
			}
			const sourceKey = urlToKey(source);
			const bytes = await storage.read(sourceKey);
			if (!bytes) {
				return c.json(
					{ error: "That image isn't there any more. Upload it again.", code: "frame_source" },
					404,
				);
			}
			let framed: Buffer;
			try {
				framed = await frameImage(Buffer.from(bytes), mediaType, crop);
			} catch (err) {
				if (err instanceof ImageFrameRefusal) {
					return c.json({ error: err.message, code: "frame_failed" }, 400);
				}
				throw err;
			}
			const key = framedImageKey(user.id, mediaType);
			await storage.upload(key, framed, "image/webp", "public");
			const objectKind = scannedObjectKind(mediaType);
			if (objectKind) {
				const outcome = await scanInlineUpload(key, { uploaderId: user.id, objectKind }, framed);
				if (outcome.quarantine) {
					return c.json({ error: "That image cannot be used.", code: "refused" }, 422);
				}
			}
			return c.json({ key, url: await storage.getUrl(key) }, 201);
		},
	)

	// ── Caption tracks — the WebVTT a creator authors onto their video Works ─────────
	// See `services/captions.ts` for the invariants: parse is the ingest gate, serving is
	// access-checked storage read, and a released Work may gain captions.

	.post("/works/:id/captions", requireAuth, zValidator("json", captionAttachSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		// A 404 rather than a 403, the way the works routes answer a non-owner — the
		// existence of another creator's Work is not information to hand out.
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (item.type !== "video") {
			return c.json(
				{ error: "Only a video carries caption tracks.", code: "captions_not_video" },
				400,
			);
		}
		const data = c.req.valid("json");
		try {
			const row = await attachCaptionTrack({
				work: item,
				requesterId: user.id,
				key: data.key,
				language: data.language,
				label: data.label || null,
				kind: data.kind,
			});
			return c.json(
				{ caption: serializeCaptionRow(row, item.id, deliveryCtx() ?? localDelivery) },
				201,
			);
		} catch (err) {
			if (err instanceof VttRefusal) {
				return c.json({ error: err.message, code: "captions_refused" }, 400);
			}
			throw err;
		}
	})

	.delete("/works/:id/captions/:trackId", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		const trackId = Number(c.req.param("trackId"));
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item || item.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		if (!Number.isInteger(trackId) || trackId <= 0) return c.json({ error: "Not found" }, 404);
		const [track] = await db
			.select()
			.from(workCaptionTracks)
			.where(and(eq(workCaptionTracks.workId, item.id), eq(workCaptionTracks.id, trackId)));
		if (!track) return c.json({ error: "Not found" }, 404);
		await deleteCaptionTrack(track, item.creatorId);
		const remaining = await listCaptionTracks(item.id);
		return c.json({
			captions: remaining.map((t) =>
				serializeCaptionRow(t, item.id, deliveryCtx() ?? localDelivery),
			),
		});
	})

	/**
	 * Serve one caption track. The same gates as the HLS route — access, the household
	 * time limit, the share token — and deliberately the same ONE missing gate: no
	 * Public-Access meter. **The meter measures attention, not bytes** (the download
	 * note below says the same), and a caption file is bytes you are entitled to read
	 * once you can reach the Work at all. The player that renders the track is stopped
	 * by the meter at its playlist; the text of the thing is not a second copy of the
	 * video to meter.
	 */
	.get("/works/:id/captions/:trackId", requireUserOrShareLink, async (c) => {
		const trackId = Number(c.req.param("trackId"));
		if (!Number.isInteger(trackId) || trackId <= 0) return c.json({ error: "Not found" }, 404);
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);
		const access = await workAccessFor(c, work);
		if (!access.canAccess) return c.json({ error: "Access required", access }, 403);
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) return c.json(limited, 403);

		const [track] = await db
			.select()
			.from(workCaptionTracks)
			.where(and(eq(workCaptionTracks.workId, work.id), eq(workCaptionTracks.id, trackId)));
		if (!track) return c.json({ error: "Not found" }, 404);
		const bytes = await storage.read(track.storageKey);
		if (!bytes) return c.json({ error: "Not found" }, 404);
		return c.body(new TextDecoder().decode(bytes), 200, {
			"Content-Type": "text/vtt; charset=utf-8",
			"Cache-Control": "no-store",
		});
	})

	// ── Preview media — the storefront a locked viewer sees ─────────────────────
	//
	// Screenshots and a trailer under the locked composition, in the creator's order
	// (Parker, 2026-10-19). The owner writes the set here; every viewer reads it through
	// the two delivery routes below, which run the SAME reachability ladder the Work detail
	// route runs and NOT the access check — a locked viewer is this feature's audience.
	//
	// 🚨 Neither route signs anything before `workReachability` has answered. A preview that
	// skipped it would serve a suspended creator's storefront or an Adult Work's screenshots
	// to somebody the Work is invisible to, which is the one failure here with no acceptable
	// version. Storage is private on purpose: `previews/` is absent from `PUBLIC_KEY_PREFIXES`.
	//
	// ⚠️ **No auth middleware on the two delivery routes, and that is the feature rather
	// than an omission.** A signed-out visitor is the most locked viewer there is, and a
	// storefront that vanishes until you make an account sells nothing; the reachability
	// ladder — not a session — decides whether this Work may be seen at all. The share token
	// is unnecessary here for the same reason: the route is public to exactly the audience
	// the Work itself is public to.

	.post("/works/:id/previews", requireAuth, zValidator("json", previewAttachSchema), async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		// 404 rather than 403, the way every owner route answers a non-owner: the existence
		// of another creator's Work is not information to hand out.
		if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		const data = c.req.valid("json");
		try {
			await attachPreviewMedia({
				work,
				requesterId: user.id,
				kind: data.kind,
				key: data.key,
				alt: data.alt,
			});
			return c.json({ previewMedia: await previewMediaPayload(work) }, 201);
		} catch (err) {
			if (err instanceof PreviewMediaRefusal) {
				return c.json({ error: err.message, code: "preview_refused" }, 400);
			}
			throw err;
		}
	})

	.put(
		"/works/:id/previews/order",
		requireAuth,
		zValidator("json", previewOrderSchema),
		async (c) => {
			const user = c.get("user");
			const work = await findWorkRow(c.req.param("id"));
			if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
			try {
				await reorderPreviewMedia(work, c.req.valid("json").previewIds);
				return c.json({ previewMedia: await previewMediaPayload(work) });
			} catch (err) {
				if (err instanceof PreviewMediaRefusal) {
					return c.json({ error: err.message, code: "preview_refused" }, 400);
				}
				throw err;
			}
		},
	)

	.patch(
		"/works/:id/previews/:previewId",
		requireAuth,
		zValidator("json", previewUpdateSchema),
		async (c) => {
			const user = c.get("user");
			const work = await findWorkRow(c.req.param("id"));
			if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
			const previewId = Number(c.req.param("previewId"));
			if (!Number.isInteger(previewId) || previewId <= 0) {
				return c.json({ error: "Not found" }, 404);
			}
			const updated = await updatePreviewMedia(work, previewId, c.req.valid("json"));
			if (!updated) return c.json({ error: "Not found" }, 404);
			return c.json({ previewMedia: await previewMediaPayload(work) });
		},
	)

	.delete("/works/:id/previews/:previewId", requireAuth, async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		const previewId = Number(c.req.param("previewId"));
		if (!Number.isInteger(previewId) || previewId <= 0) {
			return c.json({ error: "Not found" }, 404);
		}
		const preview = await findPreviewMedia(work.id, previewId);
		if (!preview) return c.json({ error: "Not found" }, 404);
		await removePreviewMedia(work, previewId);
		return c.json({ previewMedia: await previewMediaPayload(work) });
	})

	.post(
		"/works/:id/previews/:previewId/captions",
		requireAuth,
		zValidator("json", captionAttachSchema),
		async (c) => {
			const user = c.get("user");
			const work = await findWorkRow(c.req.param("id"));
			if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
			const previewId = Number(c.req.param("previewId"));
			if (!Number.isInteger(previewId) || previewId <= 0) {
				return c.json({ error: "Not found" }, 404);
			}
			const preview = await findPreviewMedia(work.id, previewId);
			if (!preview) return c.json({ error: "Not found" }, 404);
			const data = c.req.valid("json");
			try {
				const row = await attachPreviewCaptionTrack({
					work,
					preview,
					requesterId: user.id,
					key: data.key,
					language: data.language,
					label: data.label || null,
					kind: data.kind,
				});
				return c.json(
					{
						caption: serializePreviewCaptionRow(
							row,
							work.id,
							preview.id,
							deliveryCtx() ?? localDelivery,
						),
					},
					201,
				);
			} catch (err) {
				if (err instanceof VttRefusal) {
					return c.json({ error: err.message, code: "captions_refused" }, 400);
				}
				throw err;
			}
		},
	)

	.delete("/works/:id/previews/:previewId/captions/:trackId", requireAuth, async (c) => {
		const user = c.get("user");
		const work = await findWorkRow(c.req.param("id"));
		if (!work || work.creatorId !== user.id) return c.json({ error: "Work not found" }, 404);
		const previewId = Number(c.req.param("previewId"));
		const trackId = Number(c.req.param("trackId"));
		if (
			!Number.isInteger(previewId) ||
			previewId <= 0 ||
			!Number.isInteger(trackId) ||
			trackId <= 0
		) {
			return c.json({ error: "Not found" }, 404);
		}
		const [track] = await db
			.select()
			.from(workCaptionTracks)
			.where(and(eq(workCaptionTracks.previewId, previewId), eq(workCaptionTracks.id, trackId)));
		if (!track) return c.json({ error: "Not found" }, 404);
		await deletePreviewCaptionTrack(track, work.creatorId ?? -1);
		const remaining = await listPreviewCaptionTracks(previewId);
		const ctx = deliveryCtx() ?? localDelivery;
		return c.json({
			captions: remaining.map((t) => serializePreviewCaptionRow(t, work.id, previewId, ctx)),
		});
	})

	/**
	 * Serve one preview item. A short-lived signed redirect with `no-store`, the shape every
	 * gated delivery route here uses — and deliberately no access check and no meter: the
	 * locked viewer is who the storefront is for, and a screenshot is not attention drawn
	 * from the commons.
	 */
	.get("/works/:id/previews/:previewId", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);
		const reach = await workReachability(c, work);
		if ("refusal" in reach) return reach.refusal;
		const previewId = Number(c.req.param("previewId"));
		if (!Number.isInteger(previewId) || previewId <= 0) {
			return c.json({ error: "Not found" }, 404);
		}
		const preview = await findPreviewMedia(work.id, previewId);
		if (!preview) return c.json({ error: "Not found" }, 404);
		const url = await storage.getUrl(preview.file, {
			signed: true,
			expiresIn: SIGNED_MEDIA_TTL_SECONDS,
		});
		c.header("Cache-Control", "no-store");
		return c.redirect(url, 302);
	})

	/** One trailer caption — reachability-checked with its preview, never access-checked. */
	.get("/works/:id/previews/:previewId/captions/:trackId", async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work) return c.json({ error: "Work not found" }, 404);
		const reach = await workReachability(c, work);
		if ("refusal" in reach) return reach.refusal;
		const previewId = Number(c.req.param("previewId"));
		const trackId = Number(c.req.param("trackId"));
		if (
			!Number.isInteger(previewId) ||
			previewId <= 0 ||
			!Number.isInteger(trackId) ||
			trackId <= 0
		) {
			return c.json({ error: "Not found" }, 404);
		}
		const [track] = await db
			.select()
			.from(workCaptionTracks)
			.where(and(eq(workCaptionTracks.previewId, previewId), eq(workCaptionTracks.id, trackId)));
		if (!track) return c.json({ error: "Not found" }, 404);
		const bytes = await storage.read(track.storageKey);
		if (!bytes) return c.json({ error: "Not found" }, 404);
		return c.body(new TextDecoder().decode(bytes), 200, {
			"Content-Type": "text/vtt; charset=utf-8",
			"Cache-Control": "no-store",
		});
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
	});

// ── The Library ──────────────────────────────────────────────────────────────
//
// What a user has KEPT: everything they bought, plus everything free they chose to
// save. Curation, never entitlement — `services/library.ts` and the table's own doc
// comment carry the reasoning, and `resolveAccess` does not read any of it.

/**
 * The user's Library.
 *
 * Access is resolved per item exactly as the Catalog resolves it, because a Library can
 * hold a Work its owner cannot currently open: a free Work they saved and its creator
 * later gated, or a refunded purchase. Those render locked with the route to unlock,
 * which is the same behavior a gated track gets in the play queue.
 *
 * `?hidden=1` includes tidied-away entries — the "show hidden" toggle. They are
 * excluded by default and never deleted.
 *
 * At most `LIBRARY_LIMIT` entries come back, the newest ones, still in saved order; `truncated`
 * says whether older entries were left out.
 */

/**
 * One caption track as its consumer needs it: the play-facing URL beside the row's shape.
 * The owner shape keeps the counts (the Studio's editor shows them); the read shape is
 * what a `<track>` element wants and nothing more (the serializers).
 */
export function serializeCaptionRow(row: CaptionTrackRow, workId: number, ctx: DeliveryCtx) {
	return {
		id: row.id,
		language: row.language,
		label: row.label || row.language,
		kind: row.kind,
		url: buildCaptionUrl(ctx, workId, row.id),
		byteSize: row.byteSize,
		cueCount: row.cueCount,
	};
}

/** The owner's preview set as the Manage tab reads it — every mutation answers the same shape. */
export async function previewMediaPayload(work: typeof works.$inferSelect) {
	const previews = await listPreviewMedia(work.id);
	const captions = await listPreviewCaptionTracksForWork(work.id);
	const ctx = deliveryCtx() ?? localDelivery;
	return previews.map((p) => serializePreviewMedia(p, work.id, ctx, captions.get(p.id) ?? []));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export { uploadsRoutes };

// SPDX-License-Identifier: Apache-2.0
/**
 * The storefront's preview media — the one writer of `work_preview_media` rows.
 *
 * A Work's preview set is what a locked viewer sees before buying: screenshots and a
 * trailer, in the order the carousel and its strip render them (Parker, 2026-10-19).
 * This service owns every write — append, alt text, reorder and remove — the way
 * `work-source-files.ts` owns its table: routes stay thin and the invariants live here
 * where they can be seen.
 *
 * 🚨 **Preview media is storefront chrome, never the deliverable.** It is shown to
 * somebody who has not unlocked the Work, but it is not public: every object stays in
 * the private bucket and reaches a viewer only through the reachability-checked preview
 * route. Attaching a trailer queues a scan for it exactly as a Work's source does, and
 * the release gate and the owed-scan sweep load these rows too (`services/safety-scan.ts`)
 * — a coverage map that could not name them would be false.
 */

import { db } from "@anthers/db/client";
import { workPreviewMedia, type works } from "@anthers/db/schema";
import { MAX_PREVIEW_MEDIA, supportsPreviewMedia } from "@anthers/shared/content";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { queueScansForWork } from "../jobs/scan-media.js";
import { deletePreviewCaptionTracksForPreview } from "./captions.js";
import { storage } from "./storage/index.js";
import { isKeyUnder, isOwnStorageRef, urlToKey } from "./storage/keys.js";

type WorkRow = typeof works.$inferSelect;
export type PreviewMediaRow = typeof workPreviewMedia.$inferSelect;

export const PREVIEW_MEDIA_KINDS = ["image", "video"] as const;
export type PreviewMediaKind = (typeof PREVIEW_MEDIA_KINDS)[number];

export function isPreviewMediaKind(value: unknown): value is PreviewMediaKind {
	return PREVIEW_MEDIA_KINDS.includes(value as PreviewMediaKind);
}

/**
 * A refusal the routes translate to 400. Anything else this module throws is a 500, which
 * is the honest shape for a broken invariant rather than a creator's mistake.
 */
export class PreviewMediaRefusal extends Error {}

/** A Work's preview items, in dense position order — the order the carousel renders. */
export async function listPreviewMedia(workId: number): Promise<PreviewMediaRow[]> {
	return db
		.select()
		.from(workPreviewMedia)
		.where(eq(workPreviewMedia.workId, workId))
		.orderBy(asc(workPreviewMedia.position));
}

export interface AttachPreviewInput {
	work: WorkRow;
	/** The uploader's account id — the only creator whose prefix the key may sit under. */
	requesterId: number;
	kind: PreviewMediaKind;
	/** The storage key the upload route handed back. Normalized to a key, never trusted as a URL. */
	key: string;
	alt?: string | null;
}

/**
 * Append one preview item at the end of the set.
 *
 * The checks happen before anything is written, so a refused add leaves the set exactly as
 * it was: the kind is supported by the Work, the key sits under the requester's own prefix,
 * and the set is under its cap. A trailer's scan is queued after its row exists, so the
 * object is already the Work's when the job asks what is owed.
 */
export async function attachPreviewMedia(input: AttachPreviewInput): Promise<PreviewMediaRow> {
	const { work, requesterId, kind } = input;
	if (work.creatorId !== requesterId) {
		throw new Error("Only the Work's creator may attach preview media.");
	}
	if (!supportsPreviewMedia(work.type)) {
		throw new PreviewMediaRefusal("This kind of Work does not take preview media.");
	}
	const key = urlToKey(input.key);
	// 🚨 A preview key names an object the delivery route signs, so a reference outside the
	// writer's own prefix is the foreign-file door this codebase closes everywhere else.
	if (!(await isOwnStorageRef(key, requesterId))) {
		throw new PreviewMediaRefusal("That file does not belong to this account.");
	}

	const existing = await listPreviewMedia(work.id);
	if (existing.length >= MAX_PREVIEW_MEDIA) {
		throw new PreviewMediaRefusal(
			`A Work carries at most ${MAX_PREVIEW_MEDIA} preview items. Remove one to add another.`,
		);
	}

	const [{ highest }] = await db
		.select({ highest: max(workPreviewMedia.position) })
		.from(workPreviewMedia)
		.where(eq(workPreviewMedia.workId, work.id));
	const [row] = await db
		.insert(workPreviewMedia)
		.values({
			workId: work.id,
			kind,
			file: key,
			alt: kind === "image" ? (input.alt ?? "").trim() : "",
			position: (highest ?? -1) + 1,
		})
		.returning();

	// The one call every writer that attaches an object to a Work makes: a trailer is
	// scanned as a video, and a screenshot's inline answer (or its absence) is read from
	// the same key set. `beginScans` decides what is owed; this never guesses.
	await queueScansForWork(work);
	return row;
}

/** Save an image's alt text. A trailer carries none — its captions are its text. */
export async function updatePreviewMedia(
	work: WorkRow,
	previewId: number,
	input: { alt: string },
): Promise<PreviewMediaRow | null> {
	const [row] = await db
		.select()
		.from(workPreviewMedia)
		.where(and(eq(workPreviewMedia.workId, work.id), eq(workPreviewMedia.id, previewId)))
		.limit(1);
	if (!row) return null;
	const alt = row.kind === "image" ? input.alt.trim() : "";
	const [updated] = await db
		.update(workPreviewMedia)
		.set({ alt })
		.where(eq(workPreviewMedia.id, row.id))
		.returning();
	return updated ?? null;
}

/**
 * Reorder the set to an explicit id list. The client sends the whole arrangement it is
 * showing, so a stale id list (one naming an item the set has lost) is refused rather than
 * partially written, and the renumber is dense by construction.
 */
export async function reorderPreviewMedia(
	work: WorkRow,
	order: number[],
): Promise<PreviewMediaRow[]> {
	const current = await db
		.select({ id: workPreviewMedia.id })
		.from(workPreviewMedia)
		.where(eq(workPreviewMedia.workId, work.id));
	const byId = new Set(current.map((r) => r.id));
	if (
		order.length !== current.length ||
		!order.every((id) => byId.has(id)) ||
		new Set(order).size !== order.length
	) {
		throw new PreviewMediaRefusal("That order doesn't match this Work's preview items.");
	}
	// Renumbering into occupied positions collides with the unique index, so the whole set
	// is shifted past the list's length first, then written into the emptied range — the
	// same pass `work-source-files.ts` runs.
	await db
		.update(workPreviewMedia)
		.set({ position: sql`${workPreviewMedia.position} + ${current.length}` })
		.where(eq(workPreviewMedia.workId, work.id));
	for (const [position, id] of order.entries()) {
		await db
			.update(workPreviewMedia)
			.set({ position })
			.where(and(eq(workPreviewMedia.id, id), eq(workPreviewMedia.workId, work.id)));
	}
	return listPreviewMedia(work.id);
}

/**
 * Remove one preview item, renumber the rest densely, and take its objects with it — the
 * trailer's caption files first, then the media itself. The deletion stays inside the
 * owner's prefix by the same rule `media-purge.ts` holds.
 */
export async function removePreviewMedia(
	work: WorkRow,
	previewId: number,
): Promise<PreviewMediaRow[]> {
	const [deleted] = await db
		.delete(workPreviewMedia)
		.where(and(eq(workPreviewMedia.workId, work.id), eq(workPreviewMedia.id, previewId)))
		.returning();
	if (!deleted) return listPreviewMedia(work.id);

	await deletePreviewCaptionTracksForPreview(deleted.id, work.creatorId ?? -1);
	if (work.creatorId != null && isKeyUnder(deleted.file, work.creatorId)) {
		await storage.delete(deleted.file);
	}

	const remaining = await db
		.select({ id: workPreviewMedia.id })
		.from(workPreviewMedia)
		.where(eq(workPreviewMedia.workId, work.id))
		.orderBy(asc(workPreviewMedia.position));
	for (const [position, row] of remaining.entries()) {
		await db.update(workPreviewMedia).set({ position }).where(eq(workPreviewMedia.id, row.id));
	}
	return listPreviewMedia(work.id);
}

/** One preview item of this Work, or null — the delivery and caption routes' lookup. */
export async function findPreviewMedia(
	workId: number,
	previewId: number,
): Promise<PreviewMediaRow | null> {
	const [row] = await db
		.select()
		.from(workPreviewMedia)
		.where(and(eq(workPreviewMedia.workId, workId), eq(workPreviewMedia.id, previewId)))
		.limit(1);
	return row ?? null;
}

/** Whether a key is one of this Work's preview objects — the purge's ownership test. */
export function isPreviewKey(file: string): boolean {
	return urlToKey(file).includes("/previews/");
}

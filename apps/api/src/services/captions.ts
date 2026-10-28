// SPDX-License-Identifier: Apache-2.0
/**
 * Caption tracks on a video Work — authored WebVTT, the plainest accessibility gap the
 * platform had (the captions task).
 *
 * This module is the only writer of `work_caption_tracks`, the way `work-source-files.ts`
 * is the only writer of that table: attach, replace-by-language and delete live here so
 * the routes stay thin and every write passes the same gates.
 *
 * **The invariants the routes lean on this file for:**
 *
 * - **The parse is the ingest gate.** Bytes are read back from storage and validated as
 *   WebVTT before a row exists, so whatever reached the upload route, a served track is
 *   a caption file with cues in it. That is also why the `caption` upload branch is not
 *   perceptually scanned (`scannedObjectKind` does not know it): a text file gives a
 *   perceptual hash nothing to read, and anything disguised as a caption dies right
 *   here — an image has no `WEBVTT` header, and the refusal leaves a row that was never
 *   created rather than a track that was never validated.
 * - **Serving is storage `read`, not a signed redirect.** A track is a few hundred KB at
 *   most, gated by the same access check as the video itself; the route that serves one
 *   re-checks access per request, and nothing the file contains points anywhere else —
 *   there is no playlist to rewrite and no token to ride.
 * - **A released Work may gain captions.** Unlike source files, which freeze at release,
 *   caption tracks are the accessibility work that happens *after* the creator pressed
 *   publish — freezing them at `released` would make the gap permanent for every video
 *   already live.
 */

import { db } from "@anthers/db/client";
import type { works } from "@anthers/db/schema";
import { workCaptionTracks, workPreviewMedia } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { storage } from "./storage/index.js";
import { isKeyUnder, urlToKey } from "./storage/keys.js";

type WorkRow = typeof works.$inferSelect;
type PreviewMediaRow = typeof workPreviewMedia.$inferSelect;

/** A caption file over this is not a caption file. Two MB of VTT is a feature film with dense SDH. */
export const MAX_CAPTION_BYTES = 2 * 1024 * 1024;

export type CaptionTrackRow = typeof workCaptionTracks.$inferSelect;

/**
 * The two `<track>` kinds a row can render as. `captions` is the default — an accessibility
 * track carrying sound descriptions and speaker labels — and `subtitles` is the same shape
 * carrying translation, which is where localization will land when it is designed (the
 * statement page's "together rather than twice").
 */
export const CAPTION_KINDS = ["captions", "subtitles"] as const;
export type CaptionKind = (typeof CAPTION_KINDS)[number];

export function isCaptionKind(value: unknown): value is CaptionKind {
	return CAPTION_KINDS.includes(value as CaptionKind);
}

/** How a language tag must look before it becomes a row. Deliberately loose: BCP-47 shape, not a whitelist — a language we have never heard of is still a language. */
const LANGUAGE_SHAPE = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;

const MAX_LABEL_LENGTH = 100;

/**
 * Validate WebVTT and count its cues.
 *
 * What "valid" means here is the subset browsers genuinely need: the `WEBVTT` header (an
 * optional BOM admitted), cue blocks with a `-->` line whose two timestamps parse, and
 * text between the cues. `NOTE`/`STYLE`/`REGION` blocks are skipped the way the spec
 * defines them. Timestamps are checked for shape and order within a cue, not against the
 * video's duration — a caption file that slightly overshoots is a normal export artifact,
 * and refusing it would punish correct work for a rounding difference.
 *
 * A file with zero cues is refused: an empty track renders as nothing while telling the
 * user captions exist, which is worse than no track at all.
 */
export function parseVtt(
	text: string,
): { ok: true; cueCount: number } | { ok: false; error: string } {
	const body = text.replace(/^\uFEFF/, "");
	if (!/^WEBVTT($|[ \t])/m.test(body.slice(0, 7)) || !body.startsWith("WEBVTT")) {
		return { ok: false, error: "Not a WebVTT file — the WEBVTT header is missing." };
	}

	const lines = body.split(/\r\n|\n|\r/);
	let cues = 0;
	let i = 0;

	// The header line (and any metadata after it) up to the first blank line.
	while (i < lines.length && lines[i].trim() !== "") i++;
	i++; // past the blank line

	const timestamp = /^\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/;
	const toSeconds = (stamp: string): number => {
		const parts = stamp.split(":");
		const seconds = Number(parts[parts.length - 1]);
		const minutes = parts.length > 1 ? Number(parts[parts.length - 2]) : 0;
		const hours = parts.length > 2 ? Number(parts[parts.length - 3]) : 0;
		return hours * 3600 + minutes * 60 + seconds;
	};

	while (i < lines.length) {
		const line = lines[i].trim();
		if (line === "") {
			i++;
			continue;
		}
		// A NOTE/STYLE/REGION block runs to the next blank line and is none of our business.
		if (/^(NOTE|STYLE|REGION)/.test(line)) {
			i++;
			while (i < lines.length && lines[i].trim() !== "") i++;
			continue;
		}
		// A cue can carry an identifier line before its timestamp line; look down one.
		const match =
			timestamp.exec(line) ?? (i + 1 < lines.length ? timestamp.exec(lines[i + 1]) : null);
		if (!match) {
			return {
				ok: false,
				error: `Malformed WebVTT near line ${i + 1}: a cue needs two "clock --> clock" timestamps.`,
			};
		}
		const start = toSeconds(match[1]);
		const end = toSeconds(match[2]);
		if (!(end > start)) {
			return {
				ok: false,
				error: `Malformed WebVTT near line ${i + 1}: a cue's end must come after its start.`,
			};
		}
		i += line === match[0] ? 1 : 2; // past the identifier line if there was one
		let hadText = false;
		while (i < lines.length && lines[i].trim() !== "") {
			hadText = true;
			i++;
		}
		if (!hadText) {
			return { ok: false, error: `Malformed WebVTT near line ${i + 1}: a cue with no text.` };
		}
		cues++;
	}

	if (cues === 0) return { ok: false, error: "The file has no caption cues in it." };
	return { ok: true, cueCount: cues };
}

export interface AttachCaptionInput {
	work: WorkRow;
	/** The uploader's account id — the only creator whose prefix the key may sit under and the only one who may attach. */
	requesterId: number;
	/** The storage key the upload route handed back. Normalized to a key, never trusted as a URL. */
	key: string;
	language: string;
	label?: string | null;
	kind?: CaptionKind;
}

/**
 * Validate and attach one caption track, replacing any existing track of the same
 * language and kind (replacement is re-upload, never a merge — a creator correcting a
 * typo in one cue does not want the old file served from a second row).
 *
 * The returned row is the attached one; the caller serializes it back to the Studio.
 */
export async function attachCaptionTrack(input: AttachCaptionInput): Promise<CaptionTrackRow> {
	const { work, requesterId } = input;
	if (work.creatorId !== requesterId) {
		// The routes answer 404 for a non-owner before reaching here; this is the backstop
		// for any future caller that forgets, stated as an error rather than a silent write.
		throw new Error("Only the Work's creator may attach captions.");
	}
	const validated = await validateVttUpload(input);

	// Replace by (language, kind), taking the old object's bytes with the old row so no
	// orphaned caption file lingers in the private bucket past its track.
	const [previous] = await db
		.select()
		.from(workCaptionTracks)
		.where(
			and(
				eq(workCaptionTracks.workId, work.id),
				eq(workCaptionTracks.language, validated.language),
				eq(workCaptionTracks.kind, validated.kind),
			),
		);
	if (previous) {
		await deleteCaptionTrack(previous, work.creatorId);
	}

	const [row] = await db
		.insert(workCaptionTracks)
		.values({
			workId: work.id,
			language: validated.language,
			label: validated.label,
			kind: validated.kind,
			storageKey: validated.key,
			byteSize: validated.byteSize,
			cueCount: validated.cueCount,
		})
		.returning();
	return row;
}

/** The shared ingest gate both caption tables pass: language shape, owned key, WebVTT parse. */
async function validateVttUpload(input: {
	requesterId: number;
	key: string;
	language: string;
	label?: string | null;
	kind?: CaptionKind;
}) {
	const language = input.language.trim();
	if (!LANGUAGE_SHAPE.test(language)) {
		throw new VttRefusal("The language needs to be a tag like `en` or `pt-BR`.");
	}
	const label = (input.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
	const kind = input.kind ?? "captions";

	const key = urlToKey(input.key);
	// 🚨 A caption key names an object the serving route reads bytes from, so a reference
	// outside the writer's own prefix is the foreign-file door this codebase already
	// closes everywhere else. See `storage/keys.ts`.
	if (!isKeyUnder(key, input.requesterId)) {
		throw new VttRefusal("That file does not belong to this account.");
	}
	const bytes = await storage.read(key);
	if (!bytes) {
		throw new VttRefusal("The uploaded caption file could not be found — upload it again.");
	}
	if (bytes.byteLength > MAX_CAPTION_BYTES) {
		throw new VttRefusal("That caption file is too large — the limit is 2 MB.");
	}

	const parsed = parseVtt(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
	if (!parsed.ok) throw new VttRefusal(parsed.error);

	return {
		key,
		language: language.toLowerCase(),
		label,
		kind,
		byteSize: bytes.byteLength,
		cueCount: parsed.cueCount,
	};
}

export type PreviewCaptionTrackRow = typeof workCaptionTracks.$inferSelect;

/**
 * Attach one caption track to a trailer, replacing any existing track of the same language
 * and kind. Same gate as the Work's own: a trailer is a video and its captions are authored
 * WebVTT, not a second mechanism.
 */
export async function attachPreviewCaptionTrack(input: {
	work: WorkRow;
	preview: PreviewMediaRow;
	requesterId: number;
	key: string;
	language: string;
	label?: string | null;
	kind?: CaptionKind;
}): Promise<PreviewCaptionTrackRow> {
	const { work, preview, requesterId } = input;
	if (work.creatorId !== requesterId || preview.workId !== work.id) {
		throw new Error("Only the Work's creator may attach captions to its trailer.");
	}
	if (preview.kind !== "video") {
		throw new VttRefusal("A screenshot takes alt text, not caption tracks.");
	}
	const validated = await validateVttUpload(input);

	const [previous] = await db
		.select()
		.from(workCaptionTracks)
		.where(
			and(
				eq(workCaptionTracks.previewId, preview.id),
				eq(workCaptionTracks.language, validated.language),
				eq(workCaptionTracks.kind, validated.kind),
			),
		);
	if (previous) await deletePreviewCaptionTrack(previous, work.creatorId);

	const [row] = await db
		.insert(workCaptionTracks)
		.values({
			previewId: preview.id,
			language: validated.language,
			label: validated.label,
			kind: validated.kind,
			storageKey: validated.key,
			byteSize: validated.byteSize,
			cueCount: validated.cueCount,
		})
		.returning();
	return row;
}

/** A refusal the routes translate to 400; anything else this module throws is a 500. */
export class VttRefusal extends Error {}

/**
 * Delete one caption track, removing its object as well. Takes the Work's creator id so
 * the purge stays inside the owner's prefix — the same rule `media-purge.ts` holds.
 */
export async function deleteCaptionTrack(track: CaptionTrackRow, creatorId: number): Promise<void> {
	await db.delete(workCaptionTracks).where(eq(workCaptionTracks.id, track.id));
	if (isKeyUnder(track.storageKey, creatorId)) {
		await storage.delete(track.storageKey);
	}
}

/** List a Work's caption tracks, oldest first — the Studio's editor order. */
export async function listCaptionTracks(workId: number): Promise<CaptionTrackRow[]> {
	return db
		.select()
		.from(workCaptionTracks)
		.where(eq(workCaptionTracks.workId, workId))
		.orderBy(workCaptionTracks.createdAt, workCaptionTracks.id);
}

/** List one trailer's caption tracks, oldest first — the same editor order. */
export async function listPreviewCaptionTracks(
	previewId: number,
): Promise<PreviewCaptionTrackRow[]> {
	return db
		.select()
		.from(workCaptionTracks)
		.where(eq(workCaptionTracks.previewId, previewId))
		.orderBy(workCaptionTracks.createdAt, workCaptionTracks.id);
}

/**
 * Every caption track on a Work's trailers, grouped by preview id — the detail route's one
 * query, so the serializer does no per-preview lookup.
 */
export async function listPreviewCaptionTracksForWork(
	workId: number,
): Promise<Map<number, PreviewCaptionTrackRow[]>> {
	const rows = await db
		.select({ track: workCaptionTracks, previewId: workPreviewMedia.id })
		.from(workCaptionTracks)
		.innerJoin(workPreviewMedia, eq(workCaptionTracks.previewId, workPreviewMedia.id))
		.where(eq(workPreviewMedia.workId, workId))
		.orderBy(workCaptionTracks.createdAt, workCaptionTracks.id);
	const byPreview = new Map<number, PreviewCaptionTrackRow[]>();
	for (const { track, previewId } of rows) {
		const list = byPreview.get(previewId) ?? [];
		list.push(track);
		byPreview.set(previewId, list);
	}
	return byPreview;
}

/** Delete one trailer caption track, removing its object inside the owner's prefix. */
export async function deletePreviewCaptionTrack(
	track: PreviewCaptionTrackRow,
	creatorId: number,
): Promise<void> {
	await db.delete(workCaptionTracks).where(eq(workCaptionTracks.id, track.id));
	if (isKeyUnder(track.storageKey, creatorId)) {
		await storage.delete(track.storageKey);
	}
}

/** Delete every caption track on a trailer — the preview-removal half of the same rule. */
export async function deletePreviewCaptionTracksForPreview(
	previewId: number,
	creatorId: number,
): Promise<void> {
	const tracks = await listPreviewCaptionTracks(previewId);
	if (tracks.length === 0) return;
	await db.delete(workCaptionTracks).where(eq(workCaptionTracks.previewId, previewId));
	for (const track of tracks) {
		if (isKeyUnder(track.storageKey, creatorId)) await storage.delete(track.storageKey);
	}
}

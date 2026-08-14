// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turning a serialized **Work** into a **QueueTrack**.
 *
 * One conversion, in one place, because the interesting part is a rule that is invisible
 * if you write it twice: **`src` comes from `transcoding.outputFileUrl` and nothing else.**
 *
 * That field is the *delivery endpoint* for the Work — `/api/content/works/:id/audio` —
 * which re-resolves access on every request and redirects to a short-lived signed URL. The
 * API sets it to null for a viewer who cannot reach the track, so null carries the whole
 * locked state and there is no second flag beside it that could disagree. A queue built
 * from these is safe to sit on: every play goes back through the check.
 *
 * The mistake this file exists to prevent is reaching for `work.sourceKey`, which looks
 * like "the audio file" and is the raw private upload rather than the processed,
 * access-checked deliverable.
 */
import type { Work } from "@anthers/web-shared/types";
import type { QueueTrack } from "./music-queue";

/** How a creator is identified on a track, when the Work does not carry it. */
export interface TrackCreator {
	id?: number | null;
	username?: string | null;
	displayName?: string | null;
}

/** The Work shape these read — the serialized viewer form, with an optional creator. */
type WorkWithCreator = Work & {
	creator?: { username?: string | null; displayName?: string | null } | null;
};

export function trackFromWork(work: WorkWithCreator, creator?: TrackCreator | null): QueueTrack {
	const username = work.creator?.username ?? creator?.username ?? null;
	const display =
		work.creator?.displayName ?? creator?.displayName ?? username ?? "Unknown creator";

	return {
		workId: work.id,
		slug: work.slug ?? "",
		publicId: work.publicId ?? 0,
		title: work.title || "Untitled",
		creator: display,
		creatorUsername: username,
		creatorId: work.creatorId ?? creator?.id ?? null,
		thumbnail: work.thumbnail || null,
		durationSeconds: work.durationSeconds ?? null,
		waveform: (work.transcoding?.waveformData as number[] | null | undefined) ?? null,
		// See the file comment: the endpoint, never a signed URL, and never `sourceKey`.
		src: work.transcoding?.outputFileUrl || null,
		publicAccess: work.publicAccess ?? false,
		lyrics: work.lyrics ?? null,
	};
}

/**
 * The audio Works of a list, in the order given, as a queue.
 *
 * Order is the caller's — for a Project that is `project_items.sortOrder`, which is the
 * whole artifact of an EP and the reason that column exists.
 */
export function tracksFrom(works: WorkWithCreator[], creator?: TrackCreator | null): QueueTrack[] {
	return works.filter((w) => w.type === "audio").map((w) => trackFromWork(w, creator));
}

/**
 * Whether a list of Works reads as an album — every one of them is audio.
 *
 * Deliberately strict. A game Project holding five tracks *and* a build is not an album:
 * turning it into a track list would bury the game, and the grid it already has says
 * "here are some things" perfectly well. An album view is for something that IS a record.
 */
export function isAlbum(works: { type?: string }[]): boolean {
	return works.length > 0 && works.every((w) => w.type === "audio");
}

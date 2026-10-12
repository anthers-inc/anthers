// SPDX-License-Identifier: Apache-2.0
/**
 * The ingest three-way for a video's source file: what the browser already plays, what
 * a `-c copy` remux delivers, and what must be refused. The second ruling of the wiki's
 * *Originals and the Ladder* is behind the set: **what Anthers accepts is a product
 * sentence, deliberately widened by decision, never by silence** — an upload whose
 * codecs the pipeline cannot deliver natively is refused with the sentence that names
 * the set, never a silent store-now-may-not-play.
 *
 * The accepted set lives in `@anthers/shared/accepted-formats` — the pairs and the copy
 * sentence the refusal states are dataset and consequence there, so the upload page and
 * this refusal state the set alike and widen together:
 *
 *   - **H.264 + AAC**, whose native container is the mp4 family (.mp4/.m4v/.mov) — and
 *     whose pair remuxes into it from *any* container, MKV included, because OBS's
 *     default MKV capture is exactly this;
 *   - **VP9 + Opus**, whose native container is WebM.
 *
 * A silent file (video with no audio track) runs the same ladder as a spoke one; the
 * pair test applies to the audio only when the file carries one.
 *
 * The container the file IS is read from its key's extension, deliberately —
 * ffprobe's `format_name` reports "matroska,webm" for both, so the container an ffprobe
 * can distinguish is the mp4 family alone; anything else classifies cautious (remux a
 * deliverable pair into its native container rather than trusting a name no browser
 * honors). A copy is honest work the file needs at most once.
 *
 * Mutation-tested by `__tests__/video-remux.test.ts` (the classification) and exercised
 * end-to-end through the real job by `__tests__/transcode-remux.test.ts` (the remux and
 * the refusal), both against files ffmpeg itself produced.
 */

import {
	ACCEPTED_VIDEO_PAIRS,
	acceptedVideoFormatsSentence,
	type DeliverableContainer,
} from "@anthers/shared/accepted-formats";

export type { DeliverableContainer } from "@anthers/shared/accepted-formats";

export interface VideoFormatVerdict {
	/** The codec pair's native container, when the pair is deliverable at all. */
	container?: DeliverableContainer;
	/** True when the file is already in its pair's native container — it plays as it stands. */
	alreadyPlayable: boolean;
	/**
	 * When the codec pair is outside the accepted set: the sentence the creator read
	 * as the transcode's failure, naming the set and the way out. Mutually exclusive
	 * with `container`.
	 */
	refusal?: string;
}

/**
 * The refusal a file outside the set reads, composed from the shared sentence so it
 * can never drift from the copy the upload page states (both surfaces widen together).
 */
const ACCEPTED_CODECS_REFUSAL =
	"This file's video or audio codecs aren't ones the player can carry. The accepted set is " +
	`${acceptedVideoFormatsSentence()} — and any container is fine, because one that ` +
	"can't play as-is is remuxed at ingest to the browser-native form of its codec pair. " +
	"Re-export this file with a codec pair from that set and upload it again.";

/** The mp4-family extensions the browser plays an H.264+AAC file in, as the client named them. */
const MP4_FAMILY_EXTENSIONS = new Set(["mp4", "m4v", "mov"]);

export function classifyVideoStreams(
	probe: {
		streams?: Array<{ codec_type?: string; codec_name?: string }>;
	},
	sourceKey: string,
): VideoFormatVerdict {
	const video = probe.streams?.find((stream) => stream.codec_type === "video");
	const audio = probe.streams?.find((stream) => stream.codec_type === "audio");

	// The pair decides: one native container per pair, and a pair is deliverable only
	// when BOTH codecs are native to the container it remuxes into — an H.264+Opus file
	// plays in no browser's mp4 and no browser's WebM, so it is a refusal, not a remux.
	const pairs = ACCEPTED_VIDEO_PAIRS.filter(
		(pair) => video && pair.videoCodec === video.codec_name,
	);
	const pair =
		pairs.find((candidate) => !audio || candidate.audioCodec === audio.codec_name) ?? null;
	if (!pair) {
		return { alreadyPlayable: false, refusal: ACCEPTED_CODECS_REFUSAL };
	}
	const container = pair.container;

	// The file's own extension is what the container says it is. A deliverable pair
	// already in its native container plays without a copy; everything else — MKV
	// above all, OBS's default — remuxes.
	const ext = sourceKey.includes(".") ? sourceKey.split(".").pop()!.toLowerCase() : "";
	const alreadyPlayable = container === "mp4" ? MP4_FAMILY_EXTENSIONS.has(ext) : ext === "webm";
	return { container, alreadyPlayable, ...(alreadyPlayable ? {} : { refusal: undefined }) };
}

/**
 * The destination key for a remuxed source: the original's own, beside it in the same
 * directory, the old extension swapped for the pair's native one — the pair of objects
 * reads as the pair they are.
 */
export function remuxedKeyFor(storageKey: string, container: DeliverableContainer): string {
	const dot = storageKey.lastIndexOf(".");
	const stem = dot > 0 ? storageKey.slice(0, dot + 1) : `${storageKey}.`;
	return `${stem}${container}`;
}

/** A remux's object content type, for the upload the remux lands. */
export function remuxedContentType(container: DeliverableContainer): string {
	return container === "mp4" ? "video/mp4" : "video/webm";
}

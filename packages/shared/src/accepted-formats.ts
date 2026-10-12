// SPDX-License-Identifier: Apache-2.0
/**
 * The accepted formats — the codec pairs Anthers' video pipeline delivers natively, as one
 * dataset every surface that states the set reads from: the upload page's picker and
 * accepted-formats copy, and the video transcode job's refusal when a file lands outside it
 * (`apps/api/src/lib/video-remux.ts` classifies against these pairs and composes its refusal
 * from `acceptedVideoFormatsSentence`).
 *
 * 🚨 **The set is a product decision held narrow on purpose, and widening it is an edit
 * here — never a silent widening anywhere.** Native browser delivery is what keeps a
 * released video playable from the moment it exists, with no encode standing between
 * release and playback; stating the set on the upload page rather than discovering it by
 * failure keeps the platform's compute a choice. So a pair joins these two — each addition
 * deliberate, with its container remux and its copy landing in the same edit — and the
 * upload page states the list as it stands. The wiki's *Originals and the Ladder* carries
 * the ruling.
 *
 * Audio has no pair test: any common audio file is processed into the MP3 the player
 * carries (`apps/api/src/jobs/process-audio.ts`), so audio copy states "any common audio
 * format" rather than a closed list, and there is no constant to keep in step with —
 * the surfaces that carry the audio sentence say it in their own copy.
 */

export type DeliverableContainer = "mp4" | "webm";

export interface AcceptedVideoPair {
	/** ffprobe's `codec_name` the video track must match. */
	videoCodec: string;
	/** How copy names the video codec. */
	videoLabel: string;
	/** ffprobe's `codec_name` the audio track must match, when the file carries one. */
	audioCodec: string;
	/** How copy names the audio codec. */
	audioLabel: string;
	/** The pair's browser-native container — a remux's target when the file is not in it. */
	container: DeliverableContainer;
}

/** A file in no pair's native container but carrying a pair's codecs remuxes; a file carrying no pair's codecs is refused. */
export const ACCEPTED_VIDEO_PAIRS: readonly AcceptedVideoPair[] = [
	// OBS's default MKV capture is exactly this pair, which is why the mp4 family's
	// remux from any container is the set's load-bearing half.
	{
		videoCodec: "h264",
		videoLabel: "H.264",
		audioCodec: "aac",
		audioLabel: "AAC",
		container: "mp4",
	},
	{
		videoCodec: "vp9",
		videoLabel: "VP9",
		audioCodec: "opus",
		audioLabel: "Opus",
		container: "webm",
	},
];

/** The accepted pair set as the copy sentence the refusal and the picker state alike. */
export function acceptedVideoFormatsSentence(): string {
	return ACCEPTED_VIDEO_PAIRS.map(
		(pair) => `${pair.videoLabel} video with ${pair.audioLabel} audio`,
	).join(" or ");
}

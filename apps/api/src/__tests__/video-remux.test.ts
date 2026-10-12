// SPDX-License-Identifier: Apache-2.0
/**
 * The ingest three-way, as the classifier says it: accept (the pair is already in its
 * native container), remux (a deliverable pair in a container no browser plays — MKV
 * above all, because OBS's default is exactly that), refuse (a codec pair outside the
 * accepted set, with the sentence that names it). The accepted set is a product
 * sentence: a pair REMOVED from here is a removal of a promise, and a pair ADDED is a
 * decision — this suite is where both edits are made, and each refusals assertion
 * below names a codec by the pair it belongs to, so a new pair's arrival is deliberate
 * and visible.
 */
import { describe, expect, it } from "bun:test";
import { acceptedVideoFormatsSentence } from "@anthers/shared/accepted-formats";
import { classifyVideoStreams, remuxedContentType, remuxedKeyFor } from "../lib/video-remux";

interface ProbeStream {
	codec_type?: string;
	codec_name?: string;
}

function probe(streams: ProbeStream[]) {
	return { streams };
}

describe("the accepted set's pairs", () => {
	it("H.264 + AAC in the mp4 family plays as it stands", () => {
		const verdict = classifyVideoStreams(
			probe([
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "audio", codec_name: "aac" },
			]),
			"creators/1/videos/originals/abc.mp4",
		);
		expect(verdict.container).toBe("mp4");
		expect(verdict.alreadyPlayable).toBe(true);
		expect(verdict.refusal).toBeUndefined();
	});

	it("H.264 + AAC in MKV — OBS's default capture — remuxes, and the copy is not playable as it stands", () => {
		const verdict = classifyVideoStreams(
			probe([
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "audio", codec_name: "aac" },
			]),
			"creators/2/videos/originals/abc.mkv",
		);
		expect(verdict.container).toBe("mp4");
		expect(verdict.alreadyPlayable).toBe(false);
		expect(remuxedKeyFor("creators/2/videos/originals/abc.mkv", "mp4")).toBe(
			"creators/2/videos/originals/abc.mp4",
		);
		expect(remuxedContentType("mp4")).toBe("video/mp4");
	});

	it("VP9 + Opus in WebM plays as it stands, and remuxes from an MKV container", () => {
		const playable = classifyVideoStreams(
			probe([
				{ codec_type: "video", codec_name: "vp9" },
				{ codec_type: "audio", codec_name: "opus" },
			]),
			"creators/1/videos/originals/abc.webm",
		);
		expect(playable.alreadyPlayable).toBe(true);
		expect(playable.container).toBe("webm");

		const mkv = classifyVideoStreams(
			probe([
				{ codec_type: "video", codec_name: "vp9" },
				{ codec_type: "audio", codec_name: "opus" },
			]),
			"creators/1/videos/originals/abc.mkv",
		);
		expect(mkv.alreadyPlayable).toBe(false);
		expect(mkv.refusal).toBeUndefined();
		expect(remuxedKeyFor("creators/1/videos/originals/abc.mkv", "webm")).toBe(
			"creators/1/videos/originals/abc.webm",
		);
	});

	it("a silent file runs the same decision its video codec pair makes", () => {
		const silent = classifyVideoStreams(
			probe([{ codec_type: "video", codec_name: "h264" }]),
			"creators/1/videos/originals/abc.mkv",
		);
		expect(silent.container).toBe("mp4");
		expect(silent.alreadyPlayable).toBe(false);
	});
});

describe("the refusals", () => {
	it("a codec outside the set is refused with the sentence that names it — each pair named by the codec that puts it outside", () => {
		const pairs = [
			// HEVC video, whatever the audio is.
			[
				{ codec_type: "video", codec_name: "hevc" },
				{ codec_type: "audio", codec_name: "aac" },
			],
			// AV1 — deliverable in a browser, outside the set this ruling accepted.
			[
				{ codec_type: "video", codec_name: "av1" },
				{ codec_type: "audio", codec_name: "opus" },
			],
			// A pair with no native container: H.264 has mp4, and opus is not mp4's audio.
			[
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "audio", codec_name: "opus" },
			],
			// VP9's native container is WebM, and AAC is not WebM-native.
			[
				{ codec_type: "video", codec_name: "vp9" },
				{ codec_type: "audio", codec_name: "aac" },
			],
			// Uncompressed audio from a capture tool.
			[
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "audio", codec_name: "pcm_s16le" },
			],
			// FLAC tracks.
			[
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "audio", codec_name: "flac" },
			],
			// No video stream at all — the transcode's own refusal already covers it; the
			// classifier answers, and the job's guard stays where it was.
			[{ codec_type: "audio", codec_name: "aac" }],
		];
		for (const streams of pairs) {
			const verdict = classifyVideoStreams(probe(streams), "creators/1/videos/originals/x.mkv");
			expect(verdict.refusal).toContain("The accepted set is");
			expect(verdict.refusal).toContain("H.264");
			expect(verdict.container).toBeUndefined();
		}
	});

	// Widening the set is deliberate — this assertion is the one that changes, and
	// saying so here means the change cannot pass silently.
	it("the accepted copy names the expansion as a decision", () => {
		const verdict = classifyVideoStreams(
			probe([{ codec_type: "video", codec_name: "mpeg4" }]),
			"creators/1/videos/originals/x.mp4",
		);
		expect(verdict.refusal).toContain("remuxed at ingest");
	});

	// The refusal and the upload page state the same sentence from the same dataset
	// (`@anthers/shared/accepted-formats`); pinning it here is what makes the two
	// surfaces widening together a fact rather than an intention.
	it("the refusal names the accepted set with the sentence the upload page states", () => {
		const verdict = classifyVideoStreams(
			probe([{ codec_type: "video", codec_name: "mpeg4" }]),
			"creators/1/videos/originals/x.mp4",
		);
		expect(verdict.refusal).toContain(acceptedVideoFormatsSentence());
	});
});

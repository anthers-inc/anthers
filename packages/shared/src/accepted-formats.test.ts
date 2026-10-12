// SPDX-License-Identifier: Apache-2.0
/**
 * The accepted formats, as copy: every surface that states the set reads from this module,
 * so this suite binds the copy to the pairs the classifier accepts. Widening the set is an
 * edit to `ACCEPTED_VIDEO_PAIRS`, and it lands together with these assertions saying what
 * the widened sentence now names — that edit happening without this file is the silent
 * widening the wiki's *Originals and the Ladder* refuses.
 */
import { describe, expect, it } from "bun:test";
import { ACCEPTED_VIDEO_PAIRS, acceptedVideoFormatsSentence } from "./accepted-formats";

describe("accepted formats", () => {
	it("states the set as one sentence naming every pair's codecs", () => {
		const sentence = acceptedVideoFormatsSentence();
		expect(sentence).toBe("H.264 video with AAC audio or VP9 video with Opus audio");
		// Every pair is named by the sentence the refusal and the picker both state.
		for (const pair of ACCEPTED_VIDEO_PAIRS) {
			expect(sentence).toContain(pair.videoLabel);
			expect(sentence).toContain(pair.audioLabel);
		}
	});

	// A pair whose labels drift from the classifier's codec names would say one thing and
	// accept another; each pair carries both spellings so an edit cannot split them apart.
	it("gives every pair a native container and pair-shaped labels", () => {
		for (const pair of ACCEPTED_VIDEO_PAIRS) {
			expect(["mp4", "webm"]).toContain(pair.container);
			expect(pair.videoLabel).toBeTruthy();
			expect(pair.audioLabel).toBeTruthy();
			expect(pair.videoCodec).not.toBe(pair.audioCodec);
		}
	});
});

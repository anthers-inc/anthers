// SPDX-License-Identifier: Apache-2.0
/**
 * One speaker at a time — `playback.ts`'s registry, exercised on stand-in elements.
 *
 * A real `HTMLMediaElement` cannot be made to play in jsdom, and the property under test is
 * only *which* elements end up paused, so the stand-ins implement the three facts the
 * arbiter reads (`paused`, `muted`, `volume`) and dispatch the two events it listens for.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { registerExclusivePlayback } from "./playback";

class FakeMedia extends EventTarget {
	paused = true;
	muted = false;
	volume = 1;
	pauseCalls = 0;

	play(muted = false): void {
		this.paused = false;
		this.muted = muted;
		this.dispatchEvent(new Event("play"));
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.pauseCalls += 1;
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.dispatchEvent(new Event("volumechange"));
	}

	setVolume(volume: number): void {
		this.volume = volume;
		this.dispatchEvent(new Event("volumechange"));
	}
}

const cleanups: (() => void)[] = [];

/** Register the fakes, and hand back each one's release so a test can unregister early. */
function registered(...elements: FakeMedia[]): (() => void)[] {
	const releases = elements.map((element) =>
		registerExclusivePlayback(element as unknown as HTMLMediaElement),
	);
	cleanups.push(...releases);
	return releases;
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("registerExclusivePlayback", () => {
	it("pauses the other player when a second one starts audibly", () => {
		const music = new FakeMedia();
		const video = new FakeMedia();
		registered(music, video);

		music.play();
		expect(music.paused).toBe(false);

		video.play();
		expect(video.paused).toBe(false);
		expect(music.paused, "the music yields to the video").toBe(true);
		expect(music.pauseCalls).toBe(1);
	});

	it("lets a muted preview play without stopping the music", () => {
		const music = new FakeMedia();
		const preview = new FakeMedia();
		registered(music, preview);

		music.play();
		preview.play(true);

		expect(preview.paused).toBe(false);
		expect(music.paused, "a silent preview does not take the speaker").toBe(false);
	});

	it("claims the speaker when a muted preview is unmuted mid-play", () => {
		const music = new FakeMedia();
		const preview = new FakeMedia();
		registered(music, preview);

		music.play();
		preview.play(true);
		preview.setMuted(false);

		expect(preview.paused).toBe(false);
		expect(music.paused, "the now-audible preview takes the speaker").toBe(true);
	});

	it("treats zero volume as silence", () => {
		const music = new FakeMedia();
		const video = new FakeMedia();
		registered(music, video);

		video.play();
		video.setVolume(0);
		music.play();
		expect(video.paused, "the audible music pauses the silent video").toBe(true);

		video.play();
		expect(music.paused, "a zero-volume element claims nothing").toBe(false);
	});

	it("stops arbitrating an element once it unregisters", () => {
		const music = new FakeMedia();
		const video = new FakeMedia();
		const [, releaseVideo] = registered(music, video);

		music.play();
		releaseVideo();
		video.play();

		expect(video.paused).toBe(false);
		expect(music.paused, "the unregistered player no longer pauses the music").toBe(false);
	});
});

// SPDX-License-Identifier: Apache-2.0
//
// The remembered preview preference: a first-visit default that is on, an off mark
// that is honored, and a write that both persists and is heard by subscribers.
//
// The React hook is covered where it renders — the settings page and the feed tiles —
// because a hook without a DOM is not the testable half. This suite pins the store's
// own contract: what a first visit reads, and what a stop writes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	previewAudio,
	previewsEnabled,
	readStoredPreviewAudio,
	readStoredPreviews,
	setPreviewAudio,
	setPreviewsEnabled,
	subscribe,
} from "./tile-preview-settings";

const realStorage = globalThis.localStorage;

beforeEach(() => {
	// Fresh store per test — the reader is exercised against a storage that actually
	// round-trips, which is where a "0 means off" misread would show itself.
	const store = new Map<string, string>();
	Object.assign(globalThis, {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
			clear: () => store.clear(),
		},
	});
});

afterEach(() => {
	Object.assign(globalThis, { localStorage: realStorage });
	// Restore the defaults, so a later reader of the module state sees the first-
	// visit answers rather than a leaked stop or a leaked sound from these tests.
	setPreviewsEnabled(true);
	setPreviewAudio(false);
});

describe("readStoredPreviews", () => {
	test("nothing stored means previews on", () => {
		expect(readStoredPreviews()).toBe(true);
	});

	test("a stored off mark turns previews off", () => {
		localStorage.setItem("anthers_tile_previews", "0");
		expect(readStoredPreviews()).toBe(false);
	});

	test("anything other than the off mark is on", () => {
		localStorage.setItem("anthers_tile_previews", "1");
		expect(readStoredPreviews()).toBe(true);
		// A corrupted value cannot accidentally become a stop: anything unreadable
		// lands on the default, which is on.
		localStorage.setItem("anthers_tile_previews", "no");
		expect(readStoredPreviews()).toBe(true);
	});

	test("storage that refuses to answer still defaults to on", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => {
					throw new Error("private mode");
				},
				setItem: () => {},
			},
		});
		expect(readStoredPreviews()).toBe(true);
	});
});

describe("setPreviewsEnabled", () => {
	test("a stop is written through to storage", () => {
		setPreviewsEnabled(false);
		expect(localStorage.getItem("anthers_tile_previews")).toBe("0");
		expect(readStoredPreviews()).toBe(false);
	});

	test("every subscriber hears the change, with what was set", () => {
		const heard: boolean[] = [];
		// `previewsEnabled` is the module snapshot the store's own hook reads through,
		// so subscribing on it is the same read the feed tiles render from.
		const stop = subscribe(() => heard.push(previewsEnabled()));
		setPreviewsEnabled(false);
		setPreviewsEnabled(true);
		stop();
		expect(heard).toEqual([false, true]);
	});
});

describe("the hover-audio setting", () => {
	test("nothing stored means silent, which is the whole preview rule", () => {
		expect(readStoredPreviewAudio()).toBe(false);
		expect(previewAudio()).toBe(false);
	});

	test("a stored on mark turns audio on", () => {
		localStorage.setItem("anthers_tile_preview_audio", "1");
		expect(readStoredPreviewAudio()).toBe(true);
	});

	test("anything other than the on mark is off — sound is opt-in", () => {
		localStorage.setItem("anthers_tile_preview_audio", "0");
		expect(readStoredPreviewAudio()).toBe(false);
		// A corrupted value cannot accidentally turn sound on.
		localStorage.setItem("anthers_tile_preview_audio", "yes");
		expect(readStoredPreviewAudio()).toBe(false);
	});

	test("storage that refuses to answer still defaults to off", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => {
					throw new Error("private mode");
				},
				setItem: () => {},
			},
		});
		expect(readStoredPreviewAudio()).toBe(false);
	});

	test("a turn-on is written through and heard", () => {
		const heard: boolean[] = [];
		const stop = subscribe(() => heard.push(previewAudio()));
		setPreviewAudio(true);
		stop();
		expect(localStorage.getItem("anthers_tile_preview_audio")).toBe("1");
		expect(heard).toEqual([true]);
	});
});

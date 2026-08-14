// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The remembered volume, and the one line of it that is genuinely hard.
//
// 🚨 `Number(null)` is **0**. So the obvious `Number(localStorage.getItem(key))` gives a
// first-time visitor a stored volume of *silent* — a value that passes every range check
// you would think to write, throws nothing, and logs nothing. The symptom is every player
// on the site opening muted, which reads as a problem with the media rather than with
// storage. It was live in the first cut of this file and was found by looking at a
// screenshot, not by any test.
//
// So the first test here is the one that matters. Sabotage check, measured not guessed:
// reverting `read` to `Number(getItem(...))` fails exactly the "no stored value" test and
// nothing else — the range tests all pass against the broken version, because 0 is in
// range. That is the whole reason this file exists rather than a range assertion.
import { beforeEach, describe, expect, test } from "bun:test";
import { effectiveVolume, readStoredVolume } from "./volume";

function stub(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	(globalThis as any).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
	};
	return store;
}

beforeEach(() => stub());

describe("what a visitor starts at", () => {
	test("no stored value means FULL volume, not silence", () => {
		expect(readStoredVolume()).toEqual({ level: 1, muted: false });
	});

	test("a stored level is honoured", () => {
		stub({ anthers_media_volume: "0.4" });
		expect(readStoredVolume().level).toBe(0.4);
	});

	test("a stored zero is honoured — it is a real choice, not a missing value", () => {
		stub({ anthers_media_volume: "0" });
		expect(readStoredVolume().level).toBe(0);
	});

	test("nonsense falls back to full rather than to zero", () => {
		for (const bad of ["", "  ", "abc", "-1", "2", "NaN"]) {
			stub({ anthers_media_volume: bad });
			expect(readStoredVolume().level).toBe(1);
		}
	});

	test("unreadable storage is the same as a first visit", () => {
		(globalThis as any).localStorage = {
			getItem: () => {
				throw new Error("denied");
			},
		};
		expect(readStoredVolume()).toEqual({ level: 1, muted: false });
	});
});

describe("mute is separate from level, so unmuting comes back to where you were", () => {
	test("muted silences without forgetting the level", () => {
		stub({ anthers_media_volume: "0.6", anthers_media_muted: "1" });
		const v = readStoredVolume();
		expect(v).toEqual({ level: 0.6, muted: true });
		expect(effectiveVolume(v)).toBe(0);
		// The level survived the mute — which is the only reason unmuting can restore it.
		expect(effectiveVolume({ ...v, muted: false })).toBe(0.6);
	});

	test("anything but the literal flag is unmuted", () => {
		stub({ anthers_media_volume: "1", anthers_media_muted: "true" });
		expect(readStoredVolume().muted).toBe(false);
	});
});

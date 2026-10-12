// SPDX-License-Identifier: Apache-2.0
//
// The Channel Guide's model — the rules Parker pinned (2026-10-11) in pure form:
// a column is a recency *rank* ("latest plus one" aligns across channels without
// agreeing on a real time), next is UP toward more recent and ends at the top, and
// autoplay is off until a user turns it on, then remembered on this device. The same
// localStorage stand-in `listen-positions.test.ts` runs against, because a throwing
// store must never take the guide down either.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Work } from "@anthers/web-shared/types";
import {
	compareChannelNames,
	compareRecencyLatestFirst,
	type GuideChannel,
	nextProgramIndex,
	previousProgramIndex,
	readAutoplay,
	writeAutoplay,
} from "./channel-guide";

function work(partial: Partial<Work> & { id: number }): Work {
	return {
		type: "video",
		title: `Work ${partial.id}`,
		thumbnail: null,
		sourceKey: null,
		embedUrl: null,
		durationSeconds: null,
		metadata: null,
		...partial,
	} as Work;
}

describe("compareRecencyLatestFirst — the column's rank", () => {
	test("latest release first; createdAt breaks in as the fallback", () => {
		const newest = work({ id: 1, releasedAt: "2026-10-10", createdAt: "2026-10-01" });
		const older = work({ id: 2, releasedAt: "2026-09-01", createdAt: "2026-09-02" });
		const unreleased = work({ id: 3, releasedAt: null, createdAt: "2026-10-11" });
		expect([older, unreleased, newest].sort(compareRecencyLatestFirst)).toEqual([
			unreleased,
			newest,
			older,
		]);
	});

	test("equal stamps keep a deterministic order, newest upload winning — never a reshuffle", () => {
		const a = work({ id: 5, releasedAt: "2026-10-01", createdAt: "2026-10-01" });
		const b = work({ id: 4, releasedAt: "2026-10-01", createdAt: "2026-10-01" });
		const once = [a, b].sort(compareRecencyLatestFirst);
		for (let i = 0; i < 5; i++) {
			expect([b, a].sort(compareRecencyLatestFirst)).toEqual(once);
		}
	});
});

describe("compareChannelNames — the row's order", () => {
	test("alphabetically by channel name, insensitive to case", () => {
		const channels: GuideChannel[] = [
			{
				id: "creator:1",
				name: "Zephyr Aria",
				handle: "zephyr",
				avatar: null,
				creatorId: 1,
				programs: [],
			},
			{
				id: "creator:2",
				name: "atlas builds",
				handle: "atlas",
				avatar: null,
				creatorId: 2,
				programs: [],
			},
			{
				id: "creator:3",
				name: "Memoria",
				handle: "memoria",
				avatar: null,
				creatorId: 3,
				programs: [],
			},
		];
		expect([...channels].sort(compareChannelNames).map((c) => c.id)).toEqual([
			"creator:2",
			"creator:3",
			"creator:1",
		]);
	});

	test("an unlabeled channel sorts as Unknown, deterministically", () => {
		const channels: GuideChannel[] = [
			{ id: "creator:9", name: null, handle: null, avatar: null, creatorId: 9, programs: [] },
			{
				id: "creator:2",
				name: "Antlers",
				handle: "antlers",
				avatar: null,
				creatorId: 2,
				programs: [],
			},
		];
		expect([...channels].sort(compareChannelNames).map((c) => c.id)).toEqual([
			"creator:2",
			"creator:9",
		]);
	});
});

describe("next is up", () => {
	// A column is latest-first: index 0 is the newest, so NEXT one step more recent
	// is index − 1, and the guide ends at the newest, never wraps.
	test("next steps upward toward more recent", () => {
		expect(nextProgramIndex(3)).toBe(2);
		expect(nextProgramIndex(1)).toBe(0);
	});

	test("the newest video has no next — the guide ends rather than loops", () => {
		expect(nextProgramIndex(0)).toBeNull();
	});

	test("previous steps down toward older, and the oldest has none", () => {
		expect(previousProgramIndex(0, 5)).toBe(1);
		expect(previousProgramIndex(4, 5)).toBeNull();
	});
});

describe("autoplay is a user's choice", () => {
	class MemoryStorage {
		private data = new Map<string, string>();
		getItem(key: string): string | null {
			return this.data.get(key) ?? null;
		}
		setItem(key: string, value: string): void {
			this.data.set(key, value);
		}
		removeItem(key: string): void {
			this.data.delete(key);
		}
	}

	let store: MemoryStorage;
	const realStorage = globalThis.localStorage;

	beforeEach(() => {
		store = new MemoryStorage();
		Object.assign(globalThis, { localStorage: store });
	});
	afterEach(() => {
		Object.assign(globalThis, { localStorage: realStorage });
	});

	test("off with nothing remembered", () => {
		expect(readAutoplay()).toBe(false);
	});

	test("a turned-on preference sticks; turning it off unsticks it", () => {
		writeAutoplay(true);
		expect(readAutoplay()).toBe(true);
		writeAutoplay(false);
		expect(readAutoplay()).toBe(false);
		expect(store.getItem("anthers_guide_autoplay")).toBeNull();
	});
});

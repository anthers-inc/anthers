// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The queue model, tested where it is pure — no audio element, no React, no network.
//
// Two families of assertion, and they exist for different reasons.
//
// **The order-index model.** Shuffle must not lose the album's real order, and must not
// jump away from the track already playing. Both are properties of `queue` never being
// mutated and `order` being a permutation, which is the whole reason the model is shaped
// this way rather than as an array you sort.
//
// **The locked track.** Anthers resolves access per request, so a queue can legitimately
// hold a track the listener turns out not to own — an album with two free singles and
// three gated tracks is an ordinary thing to press play on. Garnet has no equivalent
// (it indexes a filesystem: what it lists, it can play), so nothing about this half is
// ported. The rule is asymmetric on purpose and the tests say so: auto-advance skips a
// locked track, an explicit jump does not.
import { describe, expect, test } from "bun:test";
import {
	cycleRepeat,
	EMPTY_QUEUE,
	hasNext,
	hasPrevious,
	jumpTo,
	nextPosition,
	nowPlaying,
	previousPosition,
	type QueueTrack,
	shuffledOrder,
	startQueue,
	toggleShuffle,
	upcoming,
} from "./music-queue";

/** A track the listener can play. `locked` ones carry no src, which IS the locked signal. */
function track(n: number, locked = false): QueueTrack {
	return {
		workId: n,
		slug: `track-${n}`,
		publicId: 1000 + n,
		title: `Track ${n}`,
		creator: "A Creator",
		creatorUsername: "creator",
		creatorId: 7,
		thumbnail: null,
		durationSeconds: 180,
		waveform: null,
		src: locked ? null : `/api/content/works/${n}/audio`,
		publicAccess: true,
		lyrics: null,
	};
}

const ALBUM = [track(1), track(2), track(3), track(4)];
/** A deterministic "shuffle" — always picks the last remaining, i.e. reverses the tail. */
const fixedRandom = () => 0.999999;

const titles = (s: ReturnType<typeof startQueue>) => s.order.map((i) => s.queue[i].title);

describe("starting a queue", () => {
	test("plays from the track you picked, in album order", () => {
		const s = startQueue(EMPTY_QUEUE, ALBUM, 2);
		expect(nowPlaying(s)?.title).toBe("Track 3");
		expect(titles(s)).toEqual(["Track 1", "Track 2", "Track 3", "Track 4"]);
	});

	test("an out-of-range start clamps rather than emptying the queue", () => {
		expect(nowPlaying(startQueue(EMPTY_QUEUE, ALBUM, 99))?.title).toBe("Track 4");
		expect(nowPlaying(startQueue(EMPTY_QUEUE, ALBUM, -5))?.title).toBe("Track 1");
	});

	test("an empty list clears the queue but keeps the listener's preferences", () => {
		const prev = cycleRepeat({ ...EMPTY_QUEUE, shuffle: true });
		const s = startQueue(prev, []);
		expect(nowPlaying(s)).toBeNull();
		expect(s.shuffle).toBe(true);
		expect(s.repeat).toBe("all");
	});
});

describe("shuffle keeps its place and never loses the album", () => {
	test("turning it on continues from the current track", () => {
		const playing = startQueue(EMPTY_QUEUE, ALBUM, 2);
		const shuffled = toggleShuffle(playing, fixedRandom);
		expect(nowPlaying(shuffled)?.title).toBe("Track 3");
		// The base order is untouched — this is the property the whole model exists for.
		expect(shuffled.queue.map((t) => t.title)).toEqual([
			"Track 1",
			"Track 2",
			"Track 3",
			"Track 4",
		]);
		expect([...shuffled.order].sort()).toEqual([0, 1, 2, 3]);
	});

	test("turning it off restores album order, still on the same track", () => {
		const s = toggleShuffle(toggleShuffle(startQueue(EMPTY_QUEUE, ALBUM, 2), fixedRandom));
		expect(s.shuffle).toBe(false);
		expect(titles(s)).toEqual(["Track 1", "Track 2", "Track 3", "Track 4"]);
		expect(nowPlaying(s)?.title).toBe("Track 3");
	});

	test("shuffledOrder is a permutation with the chosen index first", () => {
		const order = shuffledOrder(5, 3, fixedRandom);
		expect(order[0]).toBe(3);
		expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
	});

	test("toggling on an empty queue only records the preference", () => {
		expect(toggleShuffle(EMPTY_QUEUE).shuffle).toBe(true);
	});
});

describe("advancing", () => {
	test("runs to the end and stops with repeat off", () => {
		let s = startQueue(EMPTY_QUEUE, ALBUM, 3);
		expect(hasNext(s)).toBe(false);
		expect(nextPosition(s, true)).toBeNull();
		s = startQueue(EMPTY_QUEUE, ALBUM, 0);
		expect(nextPosition(s, true)).toBe(1);
	});

	test("wraps with repeat all", () => {
		const s = cycleRepeat(startQueue(EMPTY_QUEUE, ALBUM, 3)); // off -> all
		expect(s.repeat).toBe("all");
		expect(nextPosition(s, true)).toBe(0);
		expect(hasNext(s)).toBe(true);
	});

	test("repeat cycles off → all → one → off", () => {
		const all = cycleRepeat(EMPTY_QUEUE);
		const one = cycleRepeat(all);
		const off = cycleRepeat(one);
		expect([all.repeat, one.repeat, off.repeat]).toEqual(["all", "one", "off"]);
	});

	test("going back never wraps unless repeat-all is on", () => {
		const first = startQueue(EMPTY_QUEUE, ALBUM, 0);
		expect(previousPosition(first)).toBeNull();
		expect(hasPrevious(first)).toBe(false);
		expect(previousPosition(cycleRepeat(first))).toBe(3);
		expect(previousPosition(startQueue(EMPTY_QUEUE, ALBUM, 2))).toBe(1);
	});
});

describe("a queue holding tracks the listener cannot play", () => {
	const MIXED = [track(1), track(2, true), track(3, true), track(4)];

	test("auto-advance steps over the locked ones", () => {
		const s = startQueue(EMPTY_QUEUE, MIXED, 0);
		// 2 and 3 are gated; the next thing to actually play is 4.
		expect(nextPosition(s, true)).toBe(3);
	});

	test("an explicit next does NOT skip — the listener asked for the next track", () => {
		const s = startQueue(EMPTY_QUEUE, MIXED, 0);
		expect(nextPosition(s, false)).toBe(1);
	});

	test("jumping straight to a locked track selects it rather than playing something else", () => {
		const s = jumpTo(startQueue(EMPTY_QUEUE, MIXED, 0), 1);
		expect(nowPlaying(s)?.title).toBe("Track 2");
		expect(nowPlaying(s)?.src).toBeNull();
	});

	test("a queue with nothing playable never advances, and never spins looking", () => {
		// 🚨 The guard against an infinite walk: repeat-all plus an all-locked queue is a
		// loop with no exit unless the search is bounded to one lap. This test is the
		// reason `nextPosition` counts steps instead of `while (true)`.
		const allLocked = [track(1, true), track(2, true)];
		const s = cycleRepeat(startQueue(EMPTY_QUEUE, allLocked, 0));
		expect(s.repeat).toBe("all");
		expect(nextPosition(s, true)).toBeNull();
	});

	test("the last playable track ends the queue rather than landing on a gate", () => {
		const s = startQueue(EMPTY_QUEUE, [track(1), track(2, true)], 0);
		expect(nextPosition(s, true)).toBeNull();
	});
});

describe("what the queue panel shows", () => {
	test("up next is everything after the current position, in play order", () => {
		const s = startQueue(EMPTY_QUEUE, ALBUM, 1);
		expect(upcoming(s).map((e) => e.track.title)).toEqual(["Track 3", "Track 4"]);
		expect(upcoming(s).map((e) => e.pos)).toEqual([2, 3]);
	});

	test("nothing is up next at the end, or with no queue at all", () => {
		expect(upcoming(startQueue(EMPTY_QUEUE, ALBUM, 3))).toEqual([]);
		expect(upcoming(EMPTY_QUEUE)).toEqual([]);
	});

	test("jumping out of range is ignored rather than emptying the player", () => {
		const s = startQueue(EMPTY_QUEUE, ALBUM, 1);
		expect(jumpTo(s, 99)).toBe(s);
		expect(jumpTo(s, -1)).toBe(s);
	});
});

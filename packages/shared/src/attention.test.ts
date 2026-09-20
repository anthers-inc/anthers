// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the attention-credit policy — the rules deciding which seconds
// become Time Pool minutes. The invariants worth defending here:
//   1. Time-based media never credits without playback (the defect this replaced:
//      an unplayed video post recorded `watch` seconds for an open tab).
//   2. Attended content never credits without a present, non-idle user.
//   3. One creator/post pair earns at most one credit per tick, so the page
//      tracker and the mini-player can't both bill the same second.
//   4. Listings (physical/service) and unknown types never credit at all.
import { describe, expect, test } from "bun:test";
import {
	type AttentionClaim,
	type AttentionContext,
	claimKey,
	consumptionModeFor,
	creditableClaims,
	eventTypeFor,
	IDLE_TIMEOUT_MS,
	isTimePoolEligible,
	MAX_RANGE_SECONDS,
	RANGE_LOOKBACK_SECONDS,
	splitOverlappingRanges,
} from "./attention.js";
import { WORK_TYPES } from "./content.js";

/** Present and active — attended content credits. */
const ATTENTIVE: AttentionContext = { visible: true, msSinceInteraction: 0 };
/** Tab visible, but nobody has touched anything in a long while. */
const IDLE: AttentionContext = { visible: true, msSinceInteraction: IDLE_TIMEOUT_MS + 1 };
/** Backgrounded tab, user actively elsewhere. */
const HIDDEN: AttentionContext = { visible: false, msSinceInteraction: 0 };

function claim(over: Partial<AttentionClaim> & { contentType: string }): AttentionClaim {
	return { creatorId: 1, workId: 10, ...over };
}

describe("consumption modes", () => {
	test("timed media is playback-gated", () => {
		expect(consumptionModeFor("video")).toBe("playback");
		expect(consumptionModeFor("music")).toBe("playback");
		expect(consumptionModeFor("audio")).toBe("playback");
	});

	test("text and other attended content require presence", () => {
		for (const type of ["text", "image", "comic", "ebook", "game", "software"]) {
			expect(consumptionModeFor(type)).toBe("presence");
		}
	});

	test("listings are not consumed and never earn", () => {
		expect(consumptionModeFor("physical")).toBe("none");
		expect(consumptionModeFor("service")).toBe("none");
		expect(isTimePoolEligible("physical")).toBe(false);
		expect(isTimePoolEligible("service")).toBe(false);
	});

	test("an unknown type is inert rather than free money", () => {
		expect(consumptionModeFor("something-new")).toBe("none");
		expect(isTimePoolEligible("something-new")).toBe(false);
		expect(eventTypeFor("something-new")).toBe("page_view");
	});

	test("every eligible type maps to a real event type", () => {
		expect(eventTypeFor("video")).toBe("watch");
		expect(eventTypeFor("music")).toBe("listen");
		expect(eventTypeFor("audio")).toBe("listen");
		expect(eventTypeFor("text")).toBe("read");
		expect(eventTypeFor("comic")).toBe("read");
		expect(eventTypeFor("game")).toBe("play");
		for (const type of WORK_TYPES.filter(isTimePoolEligible)) {
			expect(eventTypeFor(type)).not.toBe("page_view");
		}
	});

	test("every medium but a listing earns", () => {
		expect(WORK_TYPES.filter((t) => !isTimePoolEligible(t))).toEqual(["physical", "service"]);
	});
});

describe("playback claims", () => {
	test("credit while playing", () => {
		const c = claim({ contentType: "video", playing: true });
		expect(creditableClaims([c], ATTENTIVE)).toEqual([c]);
	});

	test("do NOT credit while paused — the whole point of this change", () => {
		const c = claim({ contentType: "video", playing: false });
		expect(creditableClaims([c], ATTENTIVE)).toEqual([]);
	});

	test("do not credit when playback state is unknown", () => {
		expect(creditableClaims([claim({ contentType: "video" })], ATTENTIVE)).toEqual([]);
	});

	test("credit in a hidden tab — passive consumption is real consumption", () => {
		const c = claim({ contentType: "audio", playing: true });
		expect(creditableClaims([c], HIDDEN)).toEqual([c]);
	});

	test("credit while idle — playback is its own evidence of attention", () => {
		const c = claim({ contentType: "video", playing: true });
		expect(creditableClaims([c], IDLE)).toEqual([c]);
	});
});

describe("presence claims", () => {
	test("credit when visible and active", () => {
		const c = claim({ contentType: "text" });
		expect(creditableClaims([c], ATTENTIVE)).toEqual([c]);
	});

	test("do not credit a hidden tab — text can't be consumed passively", () => {
		expect(creditableClaims([claim({ contentType: "text" })], HIDDEN)).toEqual([]);
	});

	test("do not credit an idle user", () => {
		expect(creditableClaims([claim({ contentType: "text" })], IDLE)).toEqual([]);
	});

	test("credit right up to the idle boundary, and not past it", () => {
		const c = claim({ contentType: "text" });
		const justInside = { visible: true, msSinceInteraction: IDLE_TIMEOUT_MS - 1 };
		const exactly = { visible: true, msSinceInteraction: IDLE_TIMEOUT_MS };
		expect(creditableClaims([c], justInside)).toEqual([c]);
		expect(creditableClaims([c], exactly)).toEqual([]);
	});

	test("ignore a stray playing flag — presence content is gated on presence", () => {
		const c = claim({ contentType: "text", playing: true });
		expect(creditableClaims([c], HIDDEN)).toEqual([]);
	});
});

describe("dedupe — one credit per creator/post pair", () => {
	test("playback beats presence on the same post, in either order", () => {
		const page = claim({ contentType: "text" });
		const player = claim({ contentType: "video", playing: true });

		for (const order of [
			[page, player],
			[player, page],
		]) {
			const credited = creditableClaims(order, ATTENTIVE);
			expect(credited).toHaveLength(1);
			expect(credited[0]?.contentType).toBe("video");
		}
	});

	test("the mini-player and the post page bill one second, not two", () => {
		// Same track playing in the mini-player while the user sits on its post page.
		const miniPlayer = claim({ contentType: "audio", playing: true });
		const postPage = claim({ contentType: "audio", playing: true });
		expect(creditableClaims([miniPlayer, postPage], ATTENTIVE)).toHaveLength(1);
	});

	test("two videos playing on one post still bill one second", () => {
		const first = claim({ contentType: "video", playing: true });
		const second = claim({ contentType: "video", playing: true });
		expect(creditableClaims([first, second], ATTENTIVE)).toHaveLength(1);
	});

	test("presence falls through when the media on the same post is paused", () => {
		const page = claim({ contentType: "text" });
		const paused = claim({ contentType: "video", playing: false });
		const credited = creditableClaims([page, paused], ATTENTIVE);
		expect(credited).toHaveLength(1);
		expect(credited[0]?.contentType).toBe("text");
	});

	test("different posts by the same creator are separate claims", () => {
		const a = claim({ contentType: "video", playing: true, workId: 10 });
		const b = claim({ contentType: "video", playing: true, workId: 11 });
		expect(creditableClaims([a, b], ATTENTIVE)).toHaveLength(2);
	});

	test("different creators are separate claims", () => {
		const a = claim({ contentType: "audio", playing: true, creatorId: 1 });
		const b = claim({ contentType: "audio", playing: true, creatorId: 2 });
		expect(creditableClaims([a, b], ATTENTIVE)).toHaveLength(2);
	});

	test("a null workId is its own key, not a wildcard", () => {
		const withPost = claim({ contentType: "text", workId: 10 });
		const withoutPost = claim({ contentType: "text", workId: null });
		expect(claimKey(withPost)).not.toBe(claimKey(withoutPost));
		expect(creditableClaims([withPost, withoutPost], ATTENTIVE)).toHaveLength(2);
	});
});

describe("equal-time conservation", () => {
	// Callers split each tick evenly across the credited claims, so the guarantee
	// that a real second never becomes two credited seconds reduces to: the count
	// of credited claims is what the tick gets divided by. These assert the shape
	// that guarantee depends on.
	test("nothing live credits nothing", () => {
		const claims = [
			claim({ contentType: "video", playing: false }),
			claim({ contentType: "text", workId: 11 }),
			claim({ contentType: "physical", workId: 12 }),
		];
		expect(creditableClaims(claims, HIDDEN)).toEqual([]);
	});

	test("a listing never dilutes anyone else's share", () => {
		const real = claim({ contentType: "video", playing: true, workId: 10 });
		const listing = claim({ contentType: "physical", workId: 11 });
		expect(creditableClaims([real, listing], ATTENTIVE)).toEqual([real]);
	});

	test("an empty claim set is handled", () => {
		expect(creditableClaims([], ATTENTIVE)).toEqual([]);
	});
});

describe("multi-claim tick splitting", () => {
	// The caller divides each tick by `creditableClaims(...).length`, so the
	// conservation guarantee depends on the returned set being exactly the live
	// and distinct pairs — no more, no less. These exercise the multi-pair case
	// that the single-claim surfaces never reach on their own.
	test("two distinct pairs both credit — the tick splits between them", () => {
		const a = claim({ creatorId: 1, workId: 10, contentType: "video", playing: true });
		const b = claim({ creatorId: 2, workId: 20, contentType: "audio", playing: true });
		const credited = creditableClaims([a, b], ATTENTIVE);
		expect(credited).toHaveLength(2);
		expect(credited).toContainEqual(a);
		expect(credited).toContainEqual(b);
	});

	test("three distinct pairs all credit — a three-way split", () => {
		const a = claim({ creatorId: 1, workId: 10, contentType: "video", playing: true });
		const b = claim({ creatorId: 2, workId: 20, contentType: "text" });
		const c = claim({ creatorId: 3, workId: 30, contentType: "audio", playing: true });
		const credited = creditableClaims([a, b, c], ATTENTIVE);
		expect(credited).toHaveLength(3);
	});

	test("a mixed batch credits one per live distinct pair, dropping the rest", () => {
		// Same pair twice (deduped), two distinct pairs, one paused video, one listing.
		const same1 = claim({ creatorId: 1, workId: 10, contentType: "audio", playing: true });
		const same2 = claim({ creatorId: 1, workId: 10, contentType: "audio", playing: true });
		const other = claim({ creatorId: 2, workId: 20, contentType: "text" });
		const paused = claim({ creatorId: 3, workId: 30, contentType: "video", playing: false });
		const listing = claim({ creatorId: 4, workId: 40, contentType: "physical" });
		const credited = creditableClaims([same1, same2, other, paused, listing], ATTENTIVE);
		expect(credited).toHaveLength(2);
		expect(credited.map((c) => c.workId).sort()).toEqual([10, 20]);
	});

	test("a hidden tab zeroes presence claims but leaves playback claims live", () => {
		// The feed is scrolled away (hidden tab): text claims drop, audio keeps crediting.
		const text = claim({ creatorId: 1, workId: 10, contentType: "text" });
		const audio = claim({ creatorId: 2, workId: 20, contentType: "audio", playing: true });
		const credited = creditableClaims([text, audio], HIDDEN);
		expect(credited).toEqual([audio]);
	});

	test("an idle user zeroes presence claims but leaves playback claims live", () => {
		const text = claim({ creatorId: 1, workId: 10, contentType: "text" });
		const video = claim({ creatorId: 2, workId: 20, contentType: "video", playing: true });
		const credited = creditableClaims([text, video], IDLE);
		expect(credited).toEqual([video]);
	});

	test("playback and presence on distinct pairs both credit, independently gated", () => {
		// One user watching a video while reading an essay by another creator — both earn.
		const video = claim({ creatorId: 1, workId: 10, contentType: "video", playing: true });
		const text = claim({ creatorId: 2, workId: 20, contentType: "text" });
		expect(creditableClaims([video, text], ATTENTIVE)).toHaveLength(2);
		// Pause the video and the text claim still earns on its own.
		const paused = { ...video, playing: false };
		expect(creditableClaims([paused, text], ATTENTIVE)).toEqual([text]);
		// Background the tab and the text claim drops, but the playing video keeps earning.
		expect(creditableClaims([video, text], HIDDEN)).toEqual([video]);
	});
});

describe("element visibility — presence claims gated on the deliverable being on screen", () => {
	// `elementVisible` is the per-claim IntersectionObserver signal that the Work's
	// deliverable is in the viewport. Only presence-mode consults it; playback is
	// exempt (audio in the mini-player is consumed with nothing visible). Undefined
	// (not measured) reads as visible so unobserving surfaces and tests are
	// unaffected — the `claim()` helper doesn't set it, so the existing 41 cases all
	// still pass without modification.
	test("a presence claim with elementVisible:false does not credit, tab visible and user active", () => {
		const c = claim({ contentType: "text", elementVisible: false });
		expect(creditableClaims([c], ATTENTIVE)).toEqual([]);
	});

	test("a presence claim with elementVisible:true credits as before", () => {
		const c = claim({ contentType: "text", elementVisible: true });
		expect(creditableClaims([c], ATTENTIVE)).toEqual([c]);
	});

	test("a presence claim with elementVisible undefined credits (backward compatible)", () => {
		const c = claim({ contentType: "text" });
		expect(creditableClaims([c], ATTENTIVE)).toEqual([c]);
	});

	test("a playback claim with elementVisible:false still credits — playback is exempt", () => {
		const video = claim({ contentType: "video", playing: true, elementVisible: false });
		expect(creditableClaims([video], ATTENTIVE)).toEqual([video]);
		// Hidden tab + off-screen element: still credits, because it's playing.
		expect(creditableClaims([video], HIDDEN)).toEqual([video]);
	});

	test("a hidden tab still drops a presence claim even when elementVisible:true", () => {
		// elementVisible is necessary but not sufficient — the tab must also be visible.
		const c = claim({ contentType: "text", elementVisible: true });
		expect(creditableClaims([c], HIDDEN)).toEqual([]);
	});

	test("an idle user with elementVisible:true still drops a presence claim", () => {
		// The idle gate is independent: visible element + idle user = no credit.
		const c = claim({ contentType: "text", elementVisible: true });
		expect(creditableClaims([c], IDLE)).toEqual([]);
	});

	test("multi-claim: one presence claim visible, one not — only the visible one credits", () => {
		const visible = claim({ creatorId: 1, workId: 10, contentType: "text", elementVisible: true });
		const offscreen = claim({
			creatorId: 2,
			workId: 20,
			contentType: "text",
			elementVisible: false,
		});
		const credited = creditableClaims([visible, offscreen], ATTENTIVE);
		expect(credited).toEqual([visible]);
	});

	test("elementVisible:false on one claim does not dilute a concurrent playback claim's share", () => {
		// The off-screen text drops out of the winner set entirely — the playing video
		// gets the whole tick, not half of it, because the text claim isn't credited.
		const video = claim({ creatorId: 1, workId: 10, contentType: "video", playing: true });
		const offscreen = claim({
			creatorId: 2,
			workId: 20,
			contentType: "text",
			elementVisible: false,
		});
		expect(creditableClaims([video, offscreen], ATTENTIVE)).toEqual([video]);
	});
});

describe("union-timeline split (equal-time on read)", () => {
	const S = 1_000; // one second in ms
	const range = (id: number, startS: number, endS: number) => ({
		id,
		startedAt: startS * S,
		endedAt: endS * S,
	});

	test("a single range inside the window is credited in full", () => {
		const credited = splitOverlappingRanges([range(1, 10, 40)], 0, 100 * S);
		expect(credited.get(1)).toBe(30);
	});

	test("two identical overlapping ranges split every second evenly", () => {
		// Both live for the same 60s — each gets 30s, and the total is exactly 60.
		const credited = splitOverlappingRanges([range(1, 0, 60), range(2, 0, 60)], 0, 100 * S);
		expect(credited.get(1)).toBe(30);
		expect(credited.get(2)).toBe(30);
		expect((credited.get(1) ?? 0) + (credited.get(2) ?? 0)).toBe(60);
	});

	test("the 21.03 case: video in one tab and an article in another for 30 min credit 30 min total", () => {
		// The worked example from the task and the wiki: each tab honestly reports
		// 30 minutes; the union timeline credits 30 minutes, not 60.
		const credited = splitOverlappingRanges([range(1, 0, 1800), range(2, 0, 1800)], 0, 3600 * S);
		expect(credited.get(1)).toBe(900);
		expect(credited.get(2)).toBe(900);
	});

	test("five tabs claiming the same hour credit one hour, not five", () => {
		// The case the rolling-hour clamp existed to catch — now handled losslessly:
		// each tab still earns a 1/5 share for creators, but the user is never
		// credited more than the hour that actually passed.
		const tabs = Array.from({ length: 5 }, (_, i) => range(i + 1, 0, 3600));
		const credited = splitOverlappingRanges(tabs, 0, 3600 * S);
		let total = 0;
		for (let i = 1; i <= 5; i++) total += credited.get(i) ?? 0;
		expect(total).toBe(3600);
	});

	test("three-way partial overlap divides each span among whoever is live in it", () => {
		// A: 0–60, B: 20–80, C: 40–100.
		//   0–20:  A alone      -> A +20
		//  20–40:  A,B          -> A +10, B +10
		//  40–60:  A,B,C        -> A,B,C +6.67 each
		//  60–80:  B,C          -> B,C +10 each
		// 80–100:  C alone      -> C +20
		const credited = splitOverlappingRanges(
			[range(1, 0, 60), range(2, 20, 80), range(3, 40, 100)],
			0,
			200 * S,
		);
		expect(credited.get(1)).toBeCloseTo(20 + 10 + 20 / 3, 5);
		expect(credited.get(2)).toBeCloseTo(10 + 20 / 3 + 10, 5);
		expect(credited.get(3)).toBeCloseTo(20 / 3 + 10 + 20, 5);
		// And the total is exactly the 100 real seconds.
		const total = (credited.get(1) ?? 0) + (credited.get(2) ?? 0) + (credited.get(3) ?? 0);
		expect(total).toBeCloseTo(100, 5);
	});

	test("credit never exceeds real elapsed time, regardless of overlap density", () => {
		// Adversarial: ten ranges all live for a full hour — the total is still one hour.
		const ranges = Array.from({ length: 10 }, (_, i) => range(i + 1, 0, 3600));
		const credited = splitOverlappingRanges(ranges, 0, 3600 * S);
		let total = 0;
		for (const [, v] of credited) total += v;
		expect(total).toBeCloseTo(3600, 5);
	});

	test("non-overlapping ranges are unaffected by each other", () => {
		const credited = splitOverlappingRanges([range(1, 0, 30), range(2, 100, 160)], 0, 200 * S);
		expect(credited.get(1)).toBe(30);
		expect(credited.get(2)).toBe(60);
	});

	test("a late-arriving range re-splits what it overlaps — the whole point of splitting on read", () => {
		// First the meter would have credited A in full; once B is recorded, both halve.
		const ranges = [range(1, 0, 60)];
		const before = splitOverlappingRanges(ranges, 0, 100 * S);
		expect(before.get(1)).toBe(60);
		const after = splitOverlappingRanges([...ranges, range(2, 0, 60)], 0, 100 * S);
		expect(after.get(1)).toBe(30);
	});

	test("a range straddling the window boundary contributes only its in-window share", () => {
		// Range runs 90–150s; window is 0–120s → only 90–120 counts (30s).
		const credited = splitOverlappingRanges([range(1, 90, 150)], 0, 120 * S);
		expect(credited.get(1)).toBe(30);
	});

	test("a range entirely before the window contributes nothing", () => {
		const credited = splitOverlappingRanges([range(1, 0, 30)], 100 * S, 200 * S);
		expect(credited.get(1)).toBeUndefined();
	});

	test("a range entirely after the window contributes nothing", () => {
		const credited = splitOverlappingRanges([range(1, 300, 360)], 0, 100 * S);
		expect(credited.get(1)).toBeUndefined();
	});

	test("an empty input credits nothing", () => {
		expect(splitOverlappingRanges([], 0, 100 * S).size).toBe(0);
	});

	test("an inverted window credits nothing", () => {
		expect(splitOverlappingRanges([range(1, 0, 60)], 100 * S, 0).size).toBe(0);
	});

	test("a zero-length window credits nothing", () => {
		expect(splitOverlappingRanges([range(1, 0, 60)], 50 * S, 50 * S).size).toBe(0);
	});

	test("string ids work the same as number ids", () => {
		const credited = splitOverlappingRanges(
			[
				{ id: "a", startedAt: 0, endedAt: 60 * S },
				{ id: "b", startedAt: 0, endedAt: 60 * S },
			],
			0,
			100 * S,
		);
		expect(credited.get("a")).toBe(30);
		expect(credited.get("b")).toBe(30);
	});

	test("contiguous ranges that touch but do not overlap each credit in full", () => {
		// A ends exactly when B starts — the shared boundary has zero width, so
		// neither splits and both are fully credited.
		const credited = splitOverlappingRanges([range(1, 0, 30), range(2, 30, 60)], 0, 100 * S);
		expect(credited.get(1)).toBe(30);
		expect(credited.get(2)).toBe(30);
	});

	test("RANGE_LOOKBACK_SECONDS and MAX_RANGE_SECONDS bound what a range may claim", () => {
		// These constants exist so a forged "I watched all day" claim is bounded at
		// intake; pin them so a future change is deliberate.
		expect(RANGE_LOOKBACK_SECONDS).toBe(1_800);
		expect(MAX_RANGE_SECONDS).toBe(600);
	});
});

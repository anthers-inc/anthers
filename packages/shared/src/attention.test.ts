// SPDX-License-Identifier: AGPL-3.0-or-later
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
	CREDIT_WINDOW_SECONDS,
	claimKey,
	clampToWindow,
	consumptionModeFor,
	creditableClaims,
	eventTypeFor,
	IDLE_TIMEOUT_MS,
	isTimePoolEligible,
} from "./attention.js";

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
		expect(consumptionModeFor("audio")).toBe("playback");
	});

	test("text and other attended content require presence", () => {
		for (const type of ["text", "image", "game", "software"]) {
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
		expect(eventTypeFor("audio")).toBe("listen");
		expect(eventTypeFor("text")).toBe("read");
		expect(eventTypeFor("game")).toBe("play");
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

describe("wall-clock clamp", () => {
	const ev = (durationSeconds: number, tag = "x") => ({ durationSeconds, tag });

	test("passes a batch through untouched when the window has room", () => {
		const events = [ev(30), ev(30)];
		const result = clampToWindow(events, 0);
		expect(result.granted).toBe(60);
		expect(result.refused).toBe(0);
		expect(result.events).toEqual(events);
	});

	test("refuses everything once the window is full", () => {
		const result = clampToWindow([ev(30), ev(30)], CREDIT_WINDOW_SECONDS);
		expect(result.granted).toBe(0);
		expect(result.refused).toBe(60);
		expect(result.events.map((e) => e.durationSeconds)).toEqual([0, 0]);
	});

	test("trims the batch at the boundary rather than dropping it", () => {
		// 40 seconds left in the window, 100 claimed.
		const result = clampToWindow([ev(30), ev(30), ev(40)], CREDIT_WINDOW_SECONDS - 40);
		expect(result.granted).toBe(40);
		expect(result.refused).toBe(60);
		expect(result.events.map((e) => e.durationSeconds)).toEqual([30, 10, 0]);
	});

	test("a single oversized claim cannot exceed the window", () => {
		const result = clampToWindow([ev(999_999)], 0);
		expect(result.granted).toBe(CREDIT_WINDOW_SECONDS);
		expect(result.events[0]?.durationSeconds).toBe(CREDIT_WINDOW_SECONDS);
	});

	test("five tabs claiming the same hour are clamped to one hour", () => {
		// Each "tab" honestly reports a full hour; only an hour's worth survives.
		const tabs = Array.from({ length: 5 }, () => ev(CREDIT_WINDOW_SECONDS));
		const result = clampToWindow(tabs, 0);
		expect(result.granted).toBe(CREDIT_WINDOW_SECONDS);
		expect(result.refused).toBe(CREDIT_WINDOW_SECONDS * 4);
	});

	test("zero-duration visit pings survive a full window", () => {
		const result = clampToWindow([ev(0, "visit"), ev(0, "visit")], CREDIT_WINDOW_SECONDS);
		expect(result.events).toHaveLength(2);
		expect(result.granted).toBe(0);
		expect(result.refused).toBe(0);
	});

	test("preserves order and every non-duration field", () => {
		const result = clampToWindow([ev(30, "a"), ev(30, "b")], CREDIT_WINDOW_SECONDS - 30);
		expect(result.events.map((e) => e.tag)).toEqual(["a", "b"]);
	});

	test("treats an over-full window as full, not as negative budget", () => {
		const result = clampToWindow([ev(30)], CREDIT_WINDOW_SECONDS + 500);
		expect(result.granted).toBe(0);
		expect(result.refused).toBe(30);
	});

	test("ignores a negative already-credited total", () => {
		const result = clampToWindow([ev(30)], -100);
		expect(result.granted).toBe(30);
	});

	test("an empty batch is handled", () => {
		expect(clampToWindow([], 0)).toEqual({ events: [], granted: 0, refused: 0 });
	});
});

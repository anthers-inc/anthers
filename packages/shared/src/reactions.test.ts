// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two rules a reader can check with their own eyes, and one they cannot.
 *
 * 🚨 **The rule under test is that the published score is the ranking key.** Parker,
 * 2026-09-04: *"there's nothing ranking stuff that the users can't see."* That is a claim
 * about a relationship between two functions rather than about either one, so it needs a
 * test that compares them — reading `commentScore` alone would never notice a sort that had
 * quietly switched to `netScore`.
 */
import { describe, expect, it } from "bun:test";
import {
	COLLAPSE_NET_THRESHOLD,
	commentScore,
	isCollapsed,
	isReactionValue,
	netScore,
} from "./reactions";

const tally = (likes: number, dislikes: number) => ({ likes, dislikes });

describe("what a reaction adds up to", () => {
	it("publishes the net, and floors it at zero", () => {
		expect(commentScore(tally(0, 0))).toBe(0);
		expect(commentScore(tally(7, 2))).toBe(5);
		// The floor. A pile-on gets no counter to run up, which is the whole point of
		// publishing one number rather than two.
		expect(commentScore(tally(0, 9))).toBe(0);
		expect(commentScore(tally(2, 9))).toBe(0);
	});

	it("🚨 keeps the true net negative, because the floor is a display rule", () => {
		// Storing or thresholding on the floored value would make every unpopular comment
		// identical to a brand-new one, which is the range where the signal matters most.
		expect(netScore(tally(0, 9))).toBe(-9);
		expect(netScore(tally(2, 9))).toBe(-7);
	});

	it("🚨 never orders two comments by a difference a reader cannot see", () => {
		// The ranking key IS the published number. Two comments that show the same score
		// must be tied on score however far apart their true nets are — otherwise the order
		// is decided by something nobody can observe.
		const mildlyDisliked = tally(1, 2);
		const buried = tally(0, 40);
		expect(commentScore(mildlyDisliked)).toBe(commentScore(buried));
		expect(netScore(mildlyDisliked)).not.toBe(netScore(buried));
		// And what separates them is a visible STATE rather than a hidden position.
		expect(isCollapsed(mildlyDisliked)).toBe(false);
		expect(isCollapsed(buried)).toBe(true);
	});

	it("collapses only past the threshold, and the threshold is below zero", () => {
		// A comment at zero is ordinary — most comments never get a reaction at all — so
		// collapsing at zero would fold away the entire quiet middle of every thread.
		expect(COLLAPSE_NET_THRESHOLD).toBeLessThan(0);
		expect(isCollapsed(tally(0, 0))).toBe(false);
		expect(isCollapsed(tally(0, -COLLAPSE_NET_THRESHOLD - 1))).toBe(false);
		expect(isCollapsed(tally(0, -COLLAPSE_NET_THRESHOLD))).toBe(true);
		// Likes pull a comment back out. Collapse is a position on one axis, not a strike.
		expect(isCollapsed(tally(10, -COLLAPSE_NET_THRESHOLD))).toBe(false);
	});

	it("⭐ needs at least as many separate accounts as the threshold to collapse anything", () => {
		// Not an implementation detail — it is the entire brigading budget, and it is the
		// number to argue about when there is real traffic to argue against. Stated as a
		// test so that lowering the threshold has to be a deliberate act.
		expect(-COLLAPSE_NET_THRESHOLD).toBeGreaterThanOrEqual(5);
	});

	it("takes only +1 and -1 as a reaction", () => {
		for (const good of [1, -1]) expect(isReactionValue(good)).toBe(true);
		// 0 is the interesting one: it reads as "no reaction" and would sit in the table as
		// a row that counts for nothing while occupying the unique index.
		for (const bad of [0, 2, -2, 1.5, "1", null, undefined, true]) {
			expect(isReactionValue(bad), String(bad)).toBe(false);
		}
	});
});

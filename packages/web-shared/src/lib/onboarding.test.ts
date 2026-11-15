// SPDX-License-Identifier: Apache-2.0
/**
 * The two checklists' rows, as pure functions of the account.
 *
 * 🚨 **What this suite protects is that a row cannot be done without its fact.** The
 * server answers the counts and the boot payload carries the rest; the card only draws
 * what these return, so a reader who never saved anything cannot meet a checked "Save a
 * Work" row. The reverse matters as much: each row has to open the place it names, so a
 * done row still has a destination and a todo row is never a dead end.
 */
import { describe, expect, it } from "bun:test";
import {
	checklistComplete,
	creatorChecklistItems,
	type OnboardingFacts,
	readerChecklistItems,
} from "./onboarding";

const NO_FACTS: OnboardingFacts = {
	following: 0,
	saved: 0,
	works: 0,
	releasedWorks: 0,
	posts: 0,
	badges: 0,
};

const ALL_FACTS: OnboardingFacts = {
	following: 3,
	saved: 2,
	works: 1,
	releasedWorks: 1,
	posts: 1,
	badges: 2,
};

const BARE = { avatar: null, bio: null, creatorMode: null, handle: "newcomer" };
const FILLED = {
	avatar: "creators/1/avatar.png",
	bio: "I make quiet games.",
	creatorMode: true,
	handle: "newcomer",
};

/** The row states, keyed by the row's own key, so a failure names the row. */
function states(items: ReturnType<typeof readerChecklistItems>) {
	return Object.fromEntries(items.map((item) => [item.key, item.state]));
}

describe("readerChecklistItems", () => {
	it("starts a brand-new account with every row open", () => {
		const items = readerChecklistItems(NO_FACTS, BARE);
		expect(states(items)).toEqual({
			follow: "todo",
			save: "todo",
			profile: "todo",
			studio: "todo",
		});
	});

	it("marks each row from its own fact", () => {
		expect(states(readerChecklistItems({ ...NO_FACTS, following: 1 }, BARE)).follow).toBe("done");
		expect(states(readerChecklistItems({ ...NO_FACTS, saved: 1 }, BARE)).save).toBe("done");
		// A picture with no line about you is half a profile, and the row says both.
		expect(states(readerChecklistItems(NO_FACTS, { ...BARE, avatar: "a.png" })).profile).toBe(
			"todo",
		);
		expect(states(readerChecklistItems(NO_FACTS, { ...BARE, bio: "hello" })).profile).toBe("todo");
		expect(
			states(readerChecklistItems(NO_FACTS, { ...BARE, avatar: "a.png", bio: "hello" })).profile,
		).toBe("done");
		expect(states(readerChecklistItems(NO_FACTS, { ...BARE, creatorMode: true })).studio).toBe(
			"done",
		);
	});

	it("is complete only when all four are", () => {
		const items = readerChecklistItems(ALL_FACTS, FILLED);
		expect(states(items)).toEqual({
			follow: "done",
			save: "done",
			profile: "done",
			studio: "done",
		});
		expect(checklistComplete(items)).toBe(true);
	});

	// The follow row is deliberately the one with no door: the card stands on Discovery,
	// where following happens, and a link back to the same page would be a control that
	// does nothing. The other three each open a part of the app the reader is not on.
	it("opens the parts of the app the card is not standing on", () => {
		const items = readerChecklistItems(NO_FACTS, BARE);
		const hrefs = Object.fromEntries(items.map((item) => [item.key, item.href ?? null]));
		expect(hrefs).toEqual({
			follow: null,
			save: "/library",
			profile: "/settings?tab=account",
			studio: "/studio",
		});
	});

	// The row Parker asked for by name: every creator starts as a reader, so the door has
	// to be on the reader's list, and it must be the Studio's own gate rather than a
	// settings page the person has to interpret.
	it("opens the Studio for somebody who wants to make something", () => {
		const studio = readerChecklistItems(NO_FACTS, BARE).find((item) => item.key === "studio");
		expect(studio?.href).toBe("/studio");
	});
});

describe("creatorChecklistItems", () => {
	it("starts every row open for a creator with nothing made yet", () => {
		const items = creatorChecklistItems(NO_FACTS, BARE);
		expect(states(items)).toEqual({
			profile: "todo",
			work: "todo",
			release: "todo",
			post: "todo",
			badges: "todo",
		});
		expect(checklistComplete(items)).toBe(false);
	});

	it("keeps making and releasing as separate steps", () => {
		const made = creatorChecklistItems({ ...NO_FACTS, works: 1 }, FILLED);
		expect(states(made).work).toBe("done");
		expect(states(made).release).toBe("todo");

		const released = creatorChecklistItems({ ...NO_FACTS, works: 1, releasedWorks: 1 }, FILLED);
		expect(states(released).release).toBe("done");
	});

	it("counts a written post and an owned Badge rung", () => {
		const items = creatorChecklistItems({ ...NO_FACTS, posts: 1, badges: 1 }, FILLED);
		expect(states(items).post).toBe("done");
		expect(states(items).badges).toBe("done");
	});

	it("is complete once the catalog, the post and the ladder exist", () => {
		expect(checklistComplete(creatorChecklistItems(ALL_FACTS, FILLED))).toBe(true);
	});

	it("opens the creator's own profile's Badges tab for the ladder", () => {
		const badges = creatorChecklistItems(NO_FACTS, BARE).find((item) => item.key === "badges");
		expect(badges?.href).toBe("/@newcomer?tab=badges");
	});
});

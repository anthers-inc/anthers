// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's title arithmetic: stored markdown ⇄ the plain text an author edits, the
 * range that survives an edit, the picker's insertion, and the `@` trigger.
 *
 * The case that matters most is the one a screenshot cannot show: retitling a Work must
 * change what the field displays without losing the id, and typing inside a mention must
 * drop the link rather than silently keep pointing at a Work whose name is no longer there.
 */
import { describe, expect, it } from "bun:test";
import {
	activeMention,
	fromCanonical,
	insertMention,
	type MentionRange,
	type MentionState,
	reconcileRanges,
	toCanonical,
} from "./title-mention-ranges";

const CURTAINS = { publicId: 534_000_269, slug: "curtains", title: "Curtains" };
const WORKS = new Map([[CURTAINS.publicId, CURTAINS]]);
const CANONICAL = "[@Curtains](/works/curtains-534000269) Discussion";

describe("fromCanonical / toCanonical", () => {
	it("shows the @ name and round-trips back to the stored link", () => {
		const state = fromCanonical(CANONICAL, WORKS);
		expect(state.plain).toBe("@Curtains Discussion");
		expect(state.ranges).toEqual([{ publicId: CURTAINS.publicId, start: 0, end: 9 }]);
		expect(toCanonical(state.plain, state.ranges, WORKS)).toBe(CANONICAL);
	});

	it("shows the Work's CURRENT name while keeping the id", () => {
		const renamed = new Map([
			[CURTAINS.publicId, { ...CURTAINS, title: "Curtains (Director's Cut)" }],
		]);
		const state = fromCanonical(CANONICAL, renamed);
		expect(state.plain).toBe("@Curtains (Director's Cut) Discussion");
		expect(toCanonical(state.plain, state.ranges, renamed)).toBe(
			"[@Curtains (Director's Cut)](/works/curtains-534000269) Discussion",
		);
	});

	it("keeps the stored text when the Work no longer resolves", () => {
		const state = fromCanonical(CANONICAL, new Map());
		expect(state.plain).toBe("@Curtains Discussion");
		expect(state.ranges).toHaveLength(1);
		// A range with no Work behind it writes back as the plain text it already is.
		expect(toCanonical(state.plain, state.ranges, new Map())).toBe("@Curtains Discussion");
	});
});

describe("reconcileRanges", () => {
	const base: MentionState = {
		plain: "@Curtains Discussion",
		ranges: [{ publicId: 1, start: 0, end: 9 }],
	};

	it("shifts a mention when text is typed before it", () => {
		const before = "Curtains Discussion";
		const after = "My Curtains Discussion";
		const ranges: MentionRange[] = [{ publicId: 1, start: 0, end: 8 }];
		expect(reconcileRanges(before, after, ranges)).toEqual([{ publicId: 1, start: 3, end: 11 }]);
	});

	it("leaves a mention alone when text is typed after it", () => {
		const next = `${base.plain}!`;
		expect(reconcileRanges(base.plain, next, base.ranges)).toEqual(base.ranges);
	});

	it("drops the link when the mention's own characters are edited", () => {
		const next = "@Curtainz Discussion";
		expect(reconcileRanges(base.plain, next, base.ranges)).toEqual([]);
	});

	it("drops the link when the mention is deleted", () => {
		expect(reconcileRanges(base.plain, " Discussion", base.ranges)).toEqual([]);
	});
});

describe("insertMention", () => {
	it("replaces the typed @query and records the Work", () => {
		const typing: MentionState = { plain: "@Cur Discussion", ranges: [] };
		const next = insertMention(typing, 0, 4, CURTAINS);
		expect(next.plain).toBe("@Curtains Discussion");
		expect(next.ranges).toEqual([{ publicId: CURTAINS.publicId, start: 0, end: 9 }]);
		expect(toCanonical(next.plain, next.ranges, WORKS)).toBe(CANONICAL);
	});

	it("keeps a later mention aligned when the insertion is before it", () => {
		const state: MentionState = {
			plain: "@Cur Discussion and @Other",
			ranges: [{ publicId: 2, start: 20, end: 26 }],
		};
		const next = insertMention(state, 0, 4, CURTAINS);
		expect(next.plain).toBe("@Curtains Discussion and @Other");
		expect(next.ranges).toContainEqual({ publicId: 2, start: 25, end: 31 });
	});
});

describe("activeMention", () => {
	it("finds an @ at the start and after a space", () => {
		expect(activeMention("@Cur", 4)).toEqual({ start: 0, query: "Cur" });
		expect(activeMention("Talk @Cur", 9)).toEqual({ start: 5, query: "Cur" });
	});

	it("does not fire inside an address, or before the @ is typed", () => {
		expect(activeMention("mail me at parker@anthers.org", 29)).toBeNull();
		expect(activeMention("Talk to ", 8)).toBeNull();
	});

	it("stops at whitespace and stays closed once the query is long", () => {
		expect(activeMention("@Curtains Discussion", 18)).toBeNull();
		expect(activeMention(`@${"x".repeat(41)}`, 42)).toBeNull();
	});
});

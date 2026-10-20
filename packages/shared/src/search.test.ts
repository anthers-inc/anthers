// SPDX-License-Identifier: Apache-2.0
/**
 * The one matcher both halves of search obey.
 *
 * The cases worth pinning are the ones a second implementation would get wrong: a term
 * must match in any order, every term must match rather than any, a term cannot be
 * assembled across two fields, and the characters SQL treats as wildcards are literal.
 */
import { describe, expect, it } from "bun:test";
import {
	escapeLike,
	isSearchScope,
	isSearchType,
	likeContains,
	matchesTerms,
	SEARCH_BODY_STAGE_BELOW,
	searchTerms,
} from "./search";

describe("searchTerms", () => {
	it("lowercases, splits on whitespace and dedupes", () => {
		expect(searchTerms("  Parker   DAVIS parker  ")).toEqual(["parker", "davis"]);
	});

	it("trims sentence punctuation but keeps handle and title marks", () => {
		expect(searchTerms("Parker, Davis.")).toEqual(["parker", "davis"]);
		expect(searchTerms("(Parker)")).toEqual(["parker"]);
		expect(searchTerms("@alice #music C++ foo-bar")).toEqual([
			"@alice",
			"#music",
			"c++",
			"foo-bar",
		]);
	});

	it("drops a query that is only punctuation", () => {
		expect(searchTerms(" ... ,, ")).toEqual([]);
		expect(searchTerms("")).toEqual([]);
	});
});

describe("matchesTerms", () => {
	it("requires every term, in any order", () => {
		expect(matchesTerms(["parker", "davis"], ["Parker Davis"])).toBe(true);
		expect(matchesTerms(["davis", "parker"], ["Parker Davis"])).toBe(true);
		expect(matchesTerms(["parker", "davis"], ["Parker"])).toBe(false);
	});

	it("matches case-insensitively and partly", () => {
		expect(matchesTerms(["park"], ["PARKER DAVIS"])).toBe(true);
		expect(matchesTerms(["davi"], ["Parker Davis"])).toBe(true);
	});

	it("matches a term in any one field, but never across two fields", () => {
		expect(matchesTerms(["parker", "davis"], ["Davis", "Parker"])).toBe(true);
		expect(matchesTerms(["parker"], ["Park", "er"])).toBe(false);
	});

	it("matches nothing for an empty term list", () => {
		expect(matchesTerms([], ["anything"])).toBe(false);
	});
});

describe("the SQL pattern helpers", () => {
	it("escapes the characters LIKE treats specially", () => {
		expect(escapeLike("100%")).toBe("100\\%");
		expect(escapeLike("a_b")).toBe("a\\_b");
		expect(escapeLike("a\\b")).toBe("a\\\\b");
		expect(likeContains("100%")).toBe("%100\\%%");
	});

	it("leaves ordinary text alone", () => {
		expect(likeContains("Parker Davis")).toBe("%Parker Davis%");
	});
});

describe("the guard and the stage constant", () => {
	it("accepts only the four server kinds", () => {
		expect(isSearchType("work")).toBe(true);
		expect(isSearchType("mode")).toBe(false);
		expect(isSearchType(null)).toBe(false);
	});

	it("accepts only the two passes", () => {
		expect(isSearchScope("names")).toBe(true);
		expect(isSearchScope("body")).toBe(true);
		expect(isSearchScope("all")).toBe(false);
	});

	it("keeps the stage threshold a positive handful", () => {
		expect(SEARCH_BODY_STAGE_BELOW).toBe(5);
	});
});

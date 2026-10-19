// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
	MAX_WORK_TAGS,
	normalizeTag,
	normalizeWorkTags,
	TAG_MAX_LENGTH,
	tagProblem,
	workTagsProblem,
} from "./tags.js";

describe("normalizeTag", () => {
	test("trims, lowercases and hyphenates a typed phrase", () => {
		expect(normalizeTag("  Cozy   Horror ")).toBe("cozy-horror");
	});

	test("pasting a hashtag drops the hash", () => {
		expect(normalizeTag("#pixel-art")).toBe("pixel-art");
	});

	test("collapses repeated and edge hyphens", () => {
		expect(normalizeTag("--lo-fi--")).toBe("lo-fi");
	});

	test("keeps underscores, which hashtags use", () => {
		expect(normalizeTag("work_in_progress")).toBe("work_in_progress");
	});

	test("nothing but whitespace normalizes to empty", () => {
		expect(normalizeTag("   ")).toBe("");
	});
});

describe("tagProblem", () => {
	test("accepts a slug-shaped tag", () => {
		expect(tagProblem("pixel-art")).toBeNull();
	});

	test("accepts unicode letters", () => {
		expect(tagProblem("fantasía")).toBeNull();
	});

	test("refuses an empty tag", () => {
		expect(tagProblem("   ")).toBe("A tag needs at least one letter or number.");
	});

	test("refuses characters outside the slug shape", () => {
		expect(tagProblem("C++")).toBe("Tags can use letters, numbers, hyphens and underscores.");
	});

	test("refuses a tag past the length bound, measured after normalization", () => {
		const atLimit = "a".repeat(TAG_MAX_LENGTH);
		expect(tagProblem(atLimit)).toBeNull();
		expect(tagProblem(`${atLimit}b`)).toBe(`Tags are at most ${TAG_MAX_LENGTH} characters long.`);
	});
});

describe("normalizeWorkTags", () => {
	test("normalizes, drops blanks and de-duplicates in first-seen order", () => {
		expect(normalizeWorkTags(["Indie", "  ", "indie", "Cozy Horror"])).toEqual([
			"indie",
			"cozy-horror",
		]);
	});
});

describe("workTagsProblem", () => {
	test("accepts a full list at the cap", () => {
		const tags = Array.from({ length: MAX_WORK_TAGS }, (_, i) => `tag-${i}`);
		expect(workTagsProblem(tags)).toBeNull();
	});

	test("refuses one past the cap", () => {
		const tags = Array.from({ length: MAX_WORK_TAGS + 1 }, (_, i) => `tag-${i}`);
		expect(workTagsProblem(tags)).toBe(`A Work can carry up to ${MAX_WORK_TAGS} tags.`);
	});

	test("names the first bad tag in the list", () => {
		expect(workTagsProblem(["indie", "C++"])).toBe(
			"Tags can use letters, numbers, hyphens and underscores.",
		);
	});
});

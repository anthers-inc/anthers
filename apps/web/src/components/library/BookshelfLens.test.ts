// SPDX-License-Identifier: Apache-2.0
//
// The Bookshelf's one preset — the alphabetical-by-title sort — pinned in pure form:
// case-insensitive base sensitivity, an Untitled fallback that still sorts, and a
// deterministic tie-break so a wrapped shelf never reshuffles itself between visits.
import { describe, expect, test } from "bun:test";
import { compareByTitle } from "./BookshelfLens";

describe("compareByTitle", () => {
	test("orders case-insensitively", () => {
		const titles = ["zebra", "Alice", "middle", "beat"];

		expect([...titles].sort(compareByTitle)).toEqual(["Alice", "beat", "middle", "zebra"]);
	});

	test("a null title sorts as Untitled, among its alphabetical place", () => {
		expect([...["Alice", null, "beat"]].sort(compareByTitle)).toEqual(["Alice", "beat", null]);
		expect([...["b", null, "a"]].sort(compareByTitle)).toEqual(["a", "b", null]);
	});

	test("equal titles still get a deterministic, case-aware tie-break", () => {
		expect([...["note", "Note"]].sort(compareByTitle)).toEqual(["note", "Note"]);
		expect(compareByTitle("same", "same")).toBe(0);
	});
});

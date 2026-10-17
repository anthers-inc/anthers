// SPDX-License-Identifier: Apache-2.0
/**
 * `project-shelf-sort`'s suite — the comparators the Project shelves render order with,
 * and the one invariant Parker's ruling needs proven: **a non-manual mode never
 * reorders the stored array.**
 */
import { describe, expect, test } from "bun:test";
import { moveShelfItem, type ShelfSortable, shelfSortKey, sortShelf } from "./project-shelf-sort";

type Row = ShelfSortable & { id: number };

const row = (id: number, rest: Partial<ShelfSortable> = {}): Row => ({
	id,
	sortOrder: id,
	title: `Work ${id}`,
	...rest,
});

/** Four rows in stored order, deliberately interleaved against every key. */
const shelf = (): Row[] => [
	row(1, { title: "alpha", releasedAt: "2024-01-01", originallyReleased: null }), // here first
	row(2, { title: "Zebra", releasedAt: null, originallyReleased: "2015-06-01" }), // a draft
	row(3, { title: "beta", releasedAt: "2023-03-03", originallyReleased: "1999-12-31" }),
	row(4, { title: null, releasedAt: "2024-06-06" }), // untitled
];

describe("sortShelf", () => {
	test("manual returns the stored array untouched", () => {
		const items = shelf();
		expect(sortShelf(items, "manual", "asc")).toBe(items);
		expect(sortShelf(items, "manual", "desc")).toBe(items);
	});

	test("a non-manual mode returns a sorted COPY — the stored order never moves", () => {
		const items = shelf();
		const view = sortShelf(items, "released", "asc");
		expect(view).not.toBe(items);
		expect(items.map((r) => r.id)).toEqual([1, 2, 3, 4]);
	});

	test("release date sorts by releasedAt, ascending", () => {
		expect(sortShelf(shelf(), "released", "asc").map((r) => r.id)).toEqual([3, 1, 4, 2]);
	});

	test("original release date falls back to the release date for a here-first member", () => {
		expect(sortShelf(shelf(), "original", "asc").map((r) => r.id)).toEqual([3, 2, 1, 4]);
	});

	test("title sorts case-insensitively, untitled last", () => {
		expect(sortShelf(shelf(), "title", "asc").map((r) => r.id)).toEqual([1, 3, 2, 4]);
	});

	test("reversing the direction reverses the dated keys but still gathers empties last", () => {
		expect(sortShelf(shelf(), "released", "desc").map((r) => r.id)).toEqual([4, 1, 3, 2]);
		expect(sortShelf(shelf(), "title", "desc").map((r) => r.id)).toEqual([2, 3, 1, 4]);
	});

	test("all-null keys keep the stored order rather than scattering", () => {
		const items = [row(9), row(8)];
		expect(sortShelf(items, "released", "asc").map((r) => r.id)).toEqual([9, 8]);
		expect(sortShelf(items, "title", "desc").map((r) => r.id)).toEqual([9, 8]);
	});

	test("sorting is stable across equal keys — stored order survives both directions", () => {
		const items = [row(1, { releasedAt: "2024-01-01" }), row(2, { releasedAt: "2024-01-01" })];
		expect(sortShelf(items, "released", "asc").map((r) => r.id)).toEqual([1, 2]);
		expect(sortShelf(items, "released", "desc").map((r) => r.id)).toEqual([1, 2]);
	});
});

describe("shelfSortKey", () => {
	test("original falls back to releasedAt, and never to something else", () => {
		expect(shelfSortKey({ sortOrder: 0, originallyReleased: "2015-06-01" }, "original")).toBe(
			"2015-06-01",
		);
		expect(shelfSortKey({ sortOrder: 0, releasedAt: "2024-01-01" }, "original")).toBe("2024-01-01");
		expect(shelfSortKey({ sortOrder: 0 }, "original")).toBe(null);
	});
});

describe("moveShelfItem", () => {
	const items = ["a", "b", "c", "d"];

	test("moves a member to the drop position, spliced", () => {
		expect(moveShelfItem(items, 0, 2)).toEqual(["b", "c", "a", "d"]);
		expect(moveShelfItem(items, 3, 0)).toEqual(["d", "a", "b", "c"]);
		expect(moveShelfItem(items, 1, 1)).toEqual(items);
	});

	test("clamps at both ends rather than wrapping", () => {
		expect(moveShelfItem(items, 1, -5)).toEqual(["b", "a", "c", "d"]);
		expect(moveShelfItem(items, 1, 99)).toEqual(["a", "c", "d", "b"]);
	});

	test("does not mutate the stored array", () => {
		moveShelfItem(items, 0, 3);
		expect(items).toEqual(["a", "b", "c", "d"]);
	});
});

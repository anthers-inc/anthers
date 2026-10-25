// SPDX-License-Identifier: Apache-2.0
/**
 * `project-sort`'s suite — the comparators the Project's lists render order with,
 * and the invariant the API and the editor both rely on: **sorting a list never
 * reorders the stored array**, so a saved sort mode governs reading order without
 * rewriting the membership's own positions.
 */
import { describe, expect, test } from "bun:test";
import {
	asProjectSortDirection,
	asProjectSortMode,
	moveProjectItem,
	type ProjectSortable,
	projectSortKey,
	sortProjectItems,
} from "./project-sort";

type Row = ProjectSortable & { id: number };

const row = (id: number, rest: Partial<ProjectSortable> = {}): Row => ({
	id,
	sortOrder: id,
	title: `Work ${id}`,
	...rest,
});

/** Four rows in stored order, deliberately interleaved against every key. */
const rows = (): Row[] => [
	row(1, { title: "alpha", releasedAt: "2024-01-01", originallyReleased: null }), // here first
	row(2, { title: "Zebra", releasedAt: null, originallyReleased: "2015-06-01" }), // a draft
	row(3, { title: "beta", releasedAt: "2023-03-03", originallyReleased: "1999-12-31" }),
	row(4, { title: null, releasedAt: "2024-06-06" }), // untitled
];

describe("sortProjectItems", () => {
	test("manual returns the stored array untouched", () => {
		const items = rows();
		expect(sortProjectItems(items, "manual", "asc")).toBe(items);
		expect(sortProjectItems(items, "manual", "desc")).toBe(items);
	});

	test("a non-manual mode returns a sorted COPY — the stored order never moves", () => {
		const items = rows();
		const view = sortProjectItems(items, "released", "asc");
		expect(view).not.toBe(items);
		expect(items.map((r) => r.id)).toEqual([1, 2, 3, 4]);
	});

	test("release date sorts by releasedAt, ascending", () => {
		expect(sortProjectItems(rows(), "released", "asc").map((r) => r.id)).toEqual([3, 1, 4, 2]);
	});

	test("original release date falls back to the release date for a here-first member", () => {
		expect(sortProjectItems(rows(), "original", "asc").map((r) => r.id)).toEqual([3, 2, 1, 4]);
	});

	test("title sorts case-insensitively, untitled last", () => {
		expect(sortProjectItems(rows(), "title", "asc").map((r) => r.id)).toEqual([1, 3, 2, 4]);
	});

	test("reversing the direction reverses the dated keys but still gathers empties last", () => {
		expect(sortProjectItems(rows(), "released", "desc").map((r) => r.id)).toEqual([4, 1, 3, 2]);
		expect(sortProjectItems(rows(), "title", "desc").map((r) => r.id)).toEqual([2, 3, 1, 4]);
	});

	test("all-null keys keep the stored order rather than scattering", () => {
		const items = [row(9), row(8)];
		expect(sortProjectItems(items, "released", "asc").map((r) => r.id)).toEqual([9, 8]);
		expect(sortProjectItems(items, "title", "desc").map((r) => r.id)).toEqual([9, 8]);
	});

	test("sorting is stable across equal keys — stored order survives both directions", () => {
		const items = [row(1, { releasedAt: "2024-01-01" }), row(2, { releasedAt: "2024-01-01" })];
		expect(sortProjectItems(items, "released", "asc").map((r) => r.id)).toEqual([1, 2]);
		expect(sortProjectItems(items, "released", "desc").map((r) => r.id)).toEqual([1, 2]);
	});
});

describe("projectSortKey", () => {
	test("original falls back to releasedAt, and never to something else", () => {
		expect(projectSortKey({ sortOrder: 0, originallyReleased: "2015-06-01" }, "original")).toBe(
			"2015-06-01",
		);
		expect(projectSortKey({ sortOrder: 0, releasedAt: "2024-01-01" }, "original")).toBe(
			"2024-01-01",
		);
		expect(projectSortKey({ sortOrder: 0 }, "original")).toBe(null);
	});

	test("a post's publish date is its dated key when it has no release date", () => {
		expect(projectSortKey({ sortOrder: 0, publishedAt: "2024-02-02" }, "released")).toBe(
			"2024-02-02",
		);
		// A release date wins over a publish date for a member that has both.
		expect(
			projectSortKey(
				{ sortOrder: 0, releasedAt: "2024-01-01", publishedAt: "2024-02-02" },
				"released",
			),
		).toBe("2024-01-01");
	});

	test("a Date key and its ISO string are the same key — server and browser agree", () => {
		const asDate = { sortOrder: 0, releasedAt: new Date("2024-01-01T00:00:00.000Z") };
		expect(projectSortKey(asDate, "released")).toBe("2024-01-01T00:00:00.000Z");
		expect(projectSortKey(asDate, "released")).toBe(
			projectSortKey({ sortOrder: 0, releasedAt: "2024-01-01T00:00:00.000Z" }, "released"),
		);
		expect(projectSortKey({ sortOrder: 0, releasedAt: new Date(Number.NaN) }, "released")).toBe(
			null,
		);
	});
});

describe("stored settings read back", () => {
	test("a known mode and direction pass through unchanged", () => {
		expect(asProjectSortMode("original")).toBe("original");
		expect(asProjectSortMode("manual")).toBe("manual");
		expect(asProjectSortDirection("desc")).toBe("desc");
	});

	test("an absent or unrecognized value falls back to Manual ascending", () => {
		expect(asProjectSortMode(undefined)).toBe("manual");
		expect(asProjectSortMode("")).toBe("manual");
		expect(asProjectSortMode("popular")).toBe("manual");
		expect(asProjectSortDirection(null)).toBe("asc");
		expect(asProjectSortDirection("sideways")).toBe("asc");
	});
});

describe("moveProjectItem", () => {
	const items = ["a", "b", "c", "d"];

	test("moves a member to the drop position, spliced", () => {
		expect(moveProjectItem(items, 0, 2)).toEqual(["b", "c", "a", "d"]);
		expect(moveProjectItem(items, 3, 0)).toEqual(["d", "a", "b", "c"]);
		expect(moveProjectItem(items, 1, 1)).toEqual(items);
	});

	test("clamps at both ends rather than wrapping", () => {
		expect(moveProjectItem(items, 1, -5)).toEqual(["b", "a", "c", "d"]);
		expect(moveProjectItem(items, 1, 99)).toEqual(["a", "c", "d", "b"]);
	});

	test("does not mutate the stored array", () => {
		moveProjectItem(items, 0, 3);
		expect(items).toEqual(["a", "b", "c", "d"]);
	});
});

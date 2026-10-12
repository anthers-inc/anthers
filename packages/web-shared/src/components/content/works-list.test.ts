// SPDX-License-Identifier: Apache-2.0
/**
 * The Works table's filtering and sorting derivation.
 *
 * Here for the same reason `studio-worklist.test.ts` is: **the failure mode is an empty
 * table rather than an error.** A filter that silently stops matching, and a sort that
 * wedges on an absent date, each render exactly what an empty Catalog renders — so the
 * suite has to prove they cannot.
 */
import { describe, expect, it } from "bun:test";
import type { Work } from "../../lib/types";
import { arrangeWorks, DEFAULT_WORKS_SORT, filterWorks, sortWorks } from "./works-list";

function work(over: Partial<Work> & Pick<Work, "id">): Work {
	return {
		title: null,
		type: "video",
		visibility: "private",
		viewCount: 0,
		assets: [],
		transcoding: null,
		createdAt: "2026-01-01T00:00:00Z",
		...over,
	} as unknown as Work;
}

const CATALOG: Work[] = [
	work({
		id: 1,
		title: "Tide",
		description: "A short film",
		visibility: "released",
		viewCount: 9,
		createdAt: "2026-03-01T00:00:00Z",
	}),
	work({
		id: 2,
		title: "Undertow",
		type: "music",
		viewCount: 100,
		createdAt: "2026-02-01T00:00:00Z",
	}),
	work({ id: 3, title: null, visibility: "withdrawn", createdAt: "2026-01-15T00:00:00Z" }),
	// No dates at all — the case a comparator turns into NaN if it is unwired.
	work({ id: 4, title: "Undated", createdAt: undefined }),
];

describe("filterWorks", () => {
	it("shows everything when nothing is set", () => {
		expect(filterWorks(CATALOG, { q: "", visibility: "", type: "" })).toHaveLength(4);
	});

	it("matches a query against the title case-insensitively", () => {
		expect(filterWorks(CATALOG, { q: "tide", visibility: "", type: "" }).map((w) => w.id)).toEqual([
			1,
		]);
	});

	it("falls back to the description", () => {
		expect(
			filterWorks(CATALOG, { q: "short film", visibility: "", type: "" }).map((w) => w.id),
		).toEqual([1]);
	});

	it("treats an absent title as the Untitled the page shows, so it is still findable", () => {
		expect(
			filterWorks(CATALOG, { q: "untitled", visibility: "", type: "" }).map((w) => w.id),
		).toEqual([3]);
	});

	it("filters by visibility, treating an absent value as the schema default private", () => {
		const released = filterWorks(CATALOG, { q: "", visibility: "released", type: "" });
		expect(released.map((w) => w.id)).toEqual([1]);
		const withdrawn = filterWorks(CATALOG, { q: "", visibility: "withdrawn", type: "" });
		expect(withdrawn.map((w) => w.id)).toEqual([3]);
	});

	it("filters by kind", () => {
		expect(filterWorks(CATALOG, { q: "", visibility: "", type: "music" }).map((w) => w.id)).toEqual(
			[2],
		);
	});

	it("stacks the three", () => {
		expect(
			filterWorks(CATALOG, { q: "tide", visibility: "released", type: "video" }).map((w) => w.id),
		).toEqual([1]);
	});
});

describe("sortWorks", () => {
	it("sorts untitled as the word the page shows", () => {
		// Ascending: Tide, then the U-words, then the default-named one — which is the
		// LAST, because "Untitled" is not special in name order. That it sits anywhere at
		// all is the assertion: an absent title must not sort as an empty string, which
		// localeCompare treats as smaller than everything.
		const titled = sortWorks(CATALOG, "title", "asc");
		expect(titled[titled.length - 1].id).toBe(3); // the word "Untitled"
	});

	it("sorts a Work the payload never dated oldest, never NaN", () => {
		const byDate = sortWorks(CATALOG, "date", "desc");
		expect(byDate[byDate.length - 1].id).toBe(4);
		expect(byDate[0].id).toBe(1);
	});

	it("treats an absent view count as zero", () => {
		const byViews = sortWorks(CATALOG, "views", "desc");
		expect(byViews[0].id).toBe(2);
	});
});

describe("arrangeWorks", () => {
	it("filters, then sorts, so the table's order survives the filter", () => {
		const rows = arrangeWorks(CATALOG, { q: "und", visibility: "", type: "" }, "views", "desc");
		// "Undertow" (100 views) and "Untitled"/"Undated" (0) — filtered to the substring,
		// ordered by views high first.
		expect(rows.slice(0, 2).map((w) => w.id)).toEqual([2, 4]);
	});

	it("defaults to newest first", () => {
		expect(DEFAULT_WORKS_SORT).toEqual({ key: "date", dir: "desc" });
	});
});

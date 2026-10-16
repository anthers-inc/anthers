// SPDX-License-Identifier: Apache-2.0
/**
 * The Posts table's filtering and sorting derivation — the third twin's suite
 * (`works-list.test.ts`, `projects-list.test.ts` are the first two).
 *
 * Here for the same reason they are: **the failure mode is an empty table rather than an
 * error.** A filter that silently stops matching, and a sort that wedges on an absent
 * date, each render exactly what an empty list renders — so the suite has to prove they
 * cannot.
 */
import { describe, expect, it } from "bun:test";
import type { PostListItem } from "../../lib/types";
import { arrangePosts, DEFAULT_POSTS_SORT, filterPosts, sortPosts, stateOf } from "./posts-list";

function post(over: Partial<PostListItem> & Pick<PostListItem, "id">): PostListItem {
	return {
		title: null,
		isPublished: false,
		publishedAt: null,
		scheduledFor: null,
		tags: null,
		viewCount: 0,
		createdAt: "2026-01-01T00:00:00Z",
		...over,
	} as unknown as PostListItem;
}

const LIST: PostListItem[] = [
	post({
		id: 1,
		title: "Tide devlog",
		isPublished: true,
		publishedAt: "2026-03-01T00:00:00Z",
		createdAt: "2026-02-27T00:00:00Z",
		viewCount: 9,
		tags: ["devlog", "water"],
	}),
	post({
		id: 2,
		title: "Undertow release notes",
		isPublished: true,
		publishedAt: "2026-02-01T00:00:00Z",
		createdAt: "2026-02-01T00:00:00Z",
		viewCount: 100,
	}),
	post({
		id: 3,
		title: null,
		scheduledFor: "2026-04-01T00:00:00Z",
		createdAt: "2026-01-15T00:00:00Z",
	}),
	post({
		id: 4,
		title: "Drafty",
		tags: ["sketches", "water"],
		createdAt: "2026-01-10T00:00:00Z",
	}),
	// No dates at all — the case a comparator turns into NaN if it is unwired.
	post({ id: 5, title: "Undated", createdAt: undefined }),
];

describe("stateOf", () => {
	it("reads published, scheduled and draft as the three states", () => {
		expect(stateOf(LIST[0])).toBe("published");
		expect(stateOf(LIST[2])).toBe("scheduled");
		expect(stateOf(LIST[3])).toBe("draft");
	});

	it("reads an absent published flag as not published, the draft it renders as", () => {
		expect(stateOf(post({ id: 6, isPublished: null }))).toBe("draft");
	});
});

describe("filterPosts", () => {
	it("shows everything when nothing is set", () => {
		expect(filterPosts(LIST, { q: "", status: "" })).toHaveLength(5);
	});

	it("matches a query against the title case-insensitively", () => {
		expect(filterPosts(LIST, { q: "tide", status: "" }).map((p) => p.id)).toEqual([1]);
	});

	it("matches against the tags", () => {
		expect(filterPosts(LIST, { q: "devlog", status: "" }).map((p) => p.id)).toEqual([1]);
		expect(filterPosts(LIST, { q: "sketches", status: "" }).map((p) => p.id)).toEqual([4]);
	});

	it("treats an absent title as the Untitled the page shows, so it is still findable", () => {
		expect(filterPosts(LIST, { q: "untitled", status: "" }).map((p) => p.id)).toEqual([3]);
	});

	it("filters by each status", () => {
		expect(filterPosts(LIST, { q: "", status: "published" }).map((p) => p.id)).toEqual([1, 2]);
		expect(filterPosts(LIST, { q: "", status: "scheduled" }).map((p) => p.id)).toEqual([3]);
		expect(filterPosts(LIST, { q: "", status: "draft" }).map((p) => p.id)).toEqual([4, 5]);
	});

	it("stacks the two", () => {
		expect(filterPosts(LIST, { q: "water", status: "published" }).map((p) => p.id)).toEqual([1]);
	});
});

describe("sortPosts", () => {
	it("sorts by the post's own date: published when it went out, written otherwise", () => {
		// Post 1 was written later than post 2 was published — the written date must
		// not leak through where the published date answers.
		const byDate = sortPosts(LIST, "date", "desc");
		expect(byDate[0].id).toBe(1);
	});

	it("sorts an undated post oldest, never NaN", () => {
		const byDate = sortPosts(LIST, "date", "desc");
		expect(byDate[byDate.length - 1].id).toBe(5);
	});

	it("sorts untitled as the word the page shows", () => {
		const byTitle = sortPosts(LIST, "title", "asc");
		// "Tide…", "Drafty", "Undated", "Undertow…" — then the word "Untitled" last,
		// because it is not special in name order.
		expect(byTitle[byTitle.length - 1].id).toBe(3);
	});

	it("treats an absent view count as zero", () => {
		const byViews = sortPosts(LIST, "views", "desc");
		expect(byViews[0].id).toBe(2);
	});
});

describe("arrangePosts", () => {
	it("filters, then sorts, so the table's order survives the filter", () => {
		const rows = arrangePosts(LIST, { q: "water", status: "" }, "views", "desc");
		// Both "water" posts, ordered by views high first.
		expect(rows.map((p) => p.id)).toEqual([1, 4]);
	});

	it("defaults to newest first", () => {
		expect(DEFAULT_POSTS_SORT).toEqual({ key: "date", dir: "desc" });
	});
});

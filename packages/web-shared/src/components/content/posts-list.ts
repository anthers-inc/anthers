// SPDX-License-Identifier: Apache-2.0
/**
 * Filtering and sorting for the Studio's Posts table — the third twin of `works-list.ts`
 * (Projects is the second), for the same reason: **the failure mode is an empty table
 * rather than an error.** A filter whose predicate silently stops matching renders exactly
 * what an empty list renders, so a suite has to prove it cannot.
 */
import type { PostListItem } from "../../lib/types";

/** The columns the table can sort by. `date` is the post's own date — published when it went out, written otherwise. */
export type PostsSortKey = "title" | "date" | "views";

/** `date` starts descending, because a creator's own listing reads newest first. */
export const DEFAULT_POSTS_SORT: { key: PostsSortKey; dir: "asc" | "desc" } = {
	key: "date",
	dir: "desc",
};

export type PostStatus = "published" | "scheduled" | "draft";

/** The state a post is in, as the table's rows and the status filter both read it. A draft with a schedule is the scheduled one. */
export function stateOf(post: PostListItem): PostStatus {
	if (post.isPublished) return "published";
	return post.scheduledFor ? "scheduled" : "draft";
}

/**
 * The table's Date column, as a comparable: when the post went out, falling back to when
 * it was written — the same date the feed itself orders by (`COALESCE(published_at,
 * created_at)` on the API), so the Studio's rows and the feed's order answer the same
 * question. A post neither dated is the oldest thing present, not an NaN.
 */
export function postDate(post: PostListItem): number {
	const t = Date.parse(post.publishedAt ?? post.createdAt);
	return Number.isNaN(t) ? 0 : t;
}

export interface PostsFilters {
	/** Case-insensitive substring over title and tags; empty means no filter. */
	q: string;
	/** "published" | "scheduled" | "draft", or "" for any. */
	status: string;
}

export const NO_POSTS_FILTERS: PostsFilters = { q: "", status: "" };

export function filterPosts(items: PostListItem[], filters: PostsFilters): PostListItem[] {
	const q = filters.q.trim().toLowerCase();
	if (!q && !filters.status) return items;
	return items.filter((post) => {
		if (filters.status && stateOf(post) !== filters.status) return false;
		if (q) {
			// An absent title matches the word the page shows for it — "Untitled" — so the
			// default-named post is findable by what the screen actually says. The tags ride
			// beside it, the vocabulary a creator writes to gather these together.
			const haystack = [post.displayTitle ?? post.title ?? "Untitled", ...(post.tags ?? [])]
				.join(" ")
				.toLowerCase();
			if (!haystack.includes(q)) return false;
		}
		return true;
	});
}

export function sortPosts(
	items: PostListItem[],
	key: PostsSortKey,
	dir: "asc" | "desc",
): PostListItem[] {
	const mul = dir === "desc" ? -1 : 1;
	return [...items].sort((a, b) => mul * comparePosts(a, b, key));
}

function comparePosts(a: PostListItem, b: PostListItem, key: PostsSortKey): number {
	switch (key) {
		case "title":
			// An untitled post sorts as the word the page shows for it, not as nothing.
			return (a.title ?? "Untitled").localeCompare(b.title ?? "Untitled", undefined, {
				sensitivity: "base",
			});
		case "date":
			return postDate(a) - postDate(b);
		case "views":
			return (a.viewCount ?? 0) - (b.viewCount ?? 0);
	}
}

/** Filtering, then sorting — the table's whole derivation, in the order a user reads it. */
export function arrangePosts(
	items: PostListItem[],
	filters: PostsFilters,
	key: PostsSortKey,
	dir: "asc" | "desc",
): PostListItem[] {
	return sortPosts(filterPosts(items, filters), key, dir);
}

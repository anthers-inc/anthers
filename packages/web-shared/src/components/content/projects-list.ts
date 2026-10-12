// SPDX-License-Identifier: Apache-2.0
/**
 * Filtering and sorting for the Studio's Projects table — the Works table's twin module
 * (`works-list.ts`), for the same reason: **the failure mode is an empty table rather than
 * an error.** A filter whose predicate silently stops matching renders exactly what an
 * empty list renders, so a suite has to prove these cannot.
 */
import type { Project, ProjectWorkSummary } from "../../lib/types";

/** The columns the table can sort by. `date` is the created date the owner page shows. */
export type ProjectsSortKey = "title" | "date";

/** `date` starts descending, because a creator's own listing reads newest first. */
export const DEFAULT_PROJECTS_SORT: { key: ProjectsSortKey; dir: "asc" | "desc" } = {
	key: "date",
	dir: "desc",
};

export interface ProjectsFilters {
	/** Case-insensitive substring over title and description; empty means no filter. */
	q: string;
	/** "published" | "draft", or "" for any. An absent flag is a draft, the form's default. */
	status: string;
	/** One of the Work kinds, matching any Work the project holds; "" for any. */
	type: string;
}

export const NO_PROJECTS_FILTERS: ProjectsFilters = { q: "", status: "", type: "" };

export function filterProjects(items: Project[], filters: ProjectsFilters): Project[] {
	const q = filters.q.trim().toLowerCase();
	if (!q && !filters.status && !filters.type) return items;
	return items.filter((item) => {
		// A Project whose published flag never arrived is the form's default: a draft.
		if (filters.status && (item.isPublished ? "published" : "draft") !== filters.status)
			return false;
		if (filters.type) {
			// A project is described by what it contains, the same rule the public
			// listing's `media_type` filter keys on — "games" means contains a game.
			const summaries: ProjectWorkSummary[] = item.worksSummary ?? [];
			if (!summaries.some((w) => w.type === filters.type)) return false;
		}
		if (q) {
			// An empty title matches the word the page shows for it — "Untitled" — so the
			// default-named project is findable by what the screen actually says.
			const haystack = `${item.title || "Untitled"} ${item.description ?? ""}`.toLowerCase();
			if (!haystack.includes(q)) return false;
		}
		return true;
	});
}

export function sortProjects(
	items: Project[],
	key: ProjectsSortKey,
	dir: "asc" | "desc",
): Project[] {
	const mul = dir === "desc" ? -1 : 1;
	return [...items].sort((a, b) => mul * compareProjects(a, b, key));
}

function compareProjects(a: Project, b: Project, key: ProjectsSortKey): number {
	switch (key) {
		case "title":
			return (a.title || "Untitled").localeCompare(b.title || "Untitled", undefined, {
				sensitivity: "base",
			});
		case "date": {
			// A Project the payload never dated is the oldest thing present, not an NaN
			// that would wedge the comparator and strand the sort's contract mid-table.
			const at = (s: string | undefined) => {
				const t = Date.parse(s ?? "");
				return Number.isNaN(t) ? 0 : t;
			};
			return at(a.createdAt) - at(b.createdAt);
		}
	}
}

/** Filtering, then sorting — the table's whole derivation, in the order a user reads it. */
export function arrangeProjects(
	items: Project[],
	filters: ProjectsFilters,
	key: ProjectsSortKey,
	dir: "asc" | "desc",
): Project[] {
	return sortProjects(filterProjects(items, filters), key, dir);
}

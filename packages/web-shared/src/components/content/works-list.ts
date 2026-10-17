// SPDX-License-Identifier: Apache-2.0
/**
 * Filtering and sorting for the Studio's Works table, extracted from the page for the same
 * reason `studio-worklist.ts` is: **the failure mode is an empty table rather than an
 * error.** A filter whose predicate silently stops matching, or a sort that misorders on
 * an absent date, renders exactly what an empty Catalog renders — nothing on the screen
 * can tell the two apart, so a suite has to.
 */
import type { Work } from "../../lib/types";

/** The columns the table can sort by. `date` is the release date the column shows. */
export type WorksSortKey = "title" | "date" | "views";

/** `date` starts descending, because a creator's own listing reads newest first. */
export const DEFAULT_WORKS_SORT: { key: WorksSortKey; dir: "asc" | "desc" } = {
	key: "date",
	dir: "desc",
};

export interface WorksFilters {
	/** Case-insensitive substring over title and description; empty means no filter. */
	q: string;
	/** One of `WorkVisibility`, or "" for any. An absent value is the schema default, `private`. */
	visibility: string;
	/** One of the Work kinds (`work.type`), or "" for any. */
	type: string;
}

export const NO_WORKS_FILTERS: WorksFilters = { q: "", visibility: "", type: "" };

export function filterWorks(items: Work[], filters: WorksFilters): Work[] {
	const q = filters.q.trim().toLowerCase();
	if (!q && !filters.visibility && !filters.type) return items;
	return items.filter((item) => {
		if (filters.visibility && (item.visibility ?? "private") !== filters.visibility) return false;
		if (filters.type && item.type !== filters.type) return false;
		if (q) {
			// An absent title matches the word the page shows for it — "Untitled" — so the
			// default-named entry is findable by what the screen actually says.
			const haystack = `${item.title ?? "Untitled"} ${item.description ?? ""}`.toLowerCase();
			if (!haystack.includes(q)) return false;
		}
		return true;
	});
}

export function sortWorks(items: Work[], key: WorksSortKey, dir: "asc" | "desc"): Work[] {
	const mul = dir === "desc" ? -1 : 1;
	return [...items].sort((a, b) => mul * compareWorks(a, b, key));
}

function compareWorks(a: Work, b: Work, key: WorksSortKey): number {
	switch (key) {
		case "title":
			// An untitled Work sorts as the word the page shows for it, not as nothing.
			return (a.title ?? "Untitled").localeCompare(b.title ?? "Untitled", undefined, {
				sensitivity: "base",
			});
		case "date": {
			// The column shows the release date — when it went out, or the scheduled
			// instant it goes out at — so the sort orders by what the column reads. A
			// Work never released and never scheduled has no release date at all: it
			// sorts as the oldest thing present, not an NaN that would wedge the
			// comparator and strand the sort's contract mid-table.
			const at = (work: Work) => {
				const t = Date.parse(work.releasedAt ?? work.scheduledReleaseAt ?? "");
				return Number.isNaN(t) ? 0 : t;
			};
			return at(a) - at(b);
		}
		case "views":
			return (a.viewCount ?? 0) - (b.viewCount ?? 0);
	}
}

/** Filtering, then sorting — the table's whole derivation, in the order a user reads it. */
export function arrangeWorks(
	items: Work[],
	filters: WorksFilters,
	key: WorksSortKey,
	dir: "asc" | "desc",
): Work[] {
	return sortWorks(filterWorks(items, filters), key, dir);
}

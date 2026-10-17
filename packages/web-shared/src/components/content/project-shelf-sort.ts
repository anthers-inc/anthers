// SPDX-License-Identifier: Apache-2.0
/**
 * Sorting for a Project page's ordered shelves — the Works a project holds and the posts
 * announcing them, both carried as arrays keyed by `sortOrder` and persisted whole.
 *
 * The contract the shelves' UI lives by (Parker, 2026-10-17): **Manual is the only real
 * order.** The stored order is the drag order; the other modes — Release Date, Original
 * Release Date, Alphabetical — are read-only views of the same shelf, so a view never
 * writes anything and drag is offered only in Manual. That is why this module returns a
 * sorted COPY and the shelf persists nothing on a mode change.
 *
 * The member shape both serializations meet: the works of a project (`ProjectWork`) and
 * the posts (`ProjectPost`) each carry `sortOrder`, the two dates, and a title.
 */

/** How a shelf is arranged for reading. `manual` is the persisted drag order. */
export type ShelfSortMode = "manual" | "released" | "original" | "title";

/** Which way a mode reads; the UI greys this out but keeps it visible under Manual. */
export type ShelfSortDirection = "asc" | "desc";

/** The fields the comparators read, which both shelf serializations carry. */
export interface ShelfSortable {
	sortOrder: number;
	releasedAt?: string | null;
	originallyReleased?: string | null;
	title?: string | null;
}

const collator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

/**
 * The key a mode sorts by, and its sort's empties rule.
 *
 * A member with no answer for its key sorts LAST, by both directions — a deliberate rule
 * rather than a tie-break accident: drafts (no release yet) and untitled rows should
 * gather at an end of the list and not scatter between dated entries as direction flips.
 * `original` falls back to the release date, for members that came out here first — the
 * same meaning an empty `originallyReleased` has on the Work page.
 */
export function shelfSortKey(
	item: ShelfSortable,
	mode: Exclude<ShelfSortMode, "manual">,
): string | null {
	if (mode === "title") return item.title ? item.title : null;
	const value =
		mode === "original" && !item.originallyReleased
			? item.releasedAt
			: mode === "original"
				? item.originallyReleased
				: item.releasedAt;
	return value ?? null;
}

/** The comparator a non-manual mode renders the shelf with. Nulls sort last, both ways. */
export function shelfComparator(
	mode: Exclude<ShelfSortMode, "manual">,
	direction: ShelfSortDirection,
): (a: ShelfSortable, b: ShelfSortable) => number {
	return (a, b) => {
		const av = shelfSortKey(a, mode);
		const bv = shelfSortKey(b, mode);
		if (av == null && bv == null) return 0;
		if (av == null) return 1;
		if (bv == null) return -1;
		const compared = collator.compare(av, bv);
		return direction === "asc" ? compared : -compared;
	};
}

/**
 * The view of a shelf in one sort mode. Manual returns the array itself — the stored
 * order IS the shelf — and every other mode returns a sorted copy, never a mutation,
 * because a view write is exactly what this module must not do.
 */
export function sortShelf<T extends ShelfSortable>(
	items: T[],
	mode: ShelfSortMode,
	direction: ShelfSortDirection,
): T[] {
	if (mode === "manual") return items;
	return [...items].sort(shelfComparator(mode, direction));
}

/**
 * Move one shelf member to another position, spliced — the shape a drag between rows
 * means and the reorder endpoints' whole-order payload is built from. Clamped at both
 * ends rather than wrapping, so a stray drop at a row's edge reorders as far as it can.
 */
export function moveShelfItem<T>(items: T[], from: number, to: number): T[] {
	const clamped = Math.max(0, Math.min(items.length - 1, to));
	const next = [...items];
	const [moved] = next.splice(from, 1);
	next.splice(clamped, 0, moved);
	return next;
}

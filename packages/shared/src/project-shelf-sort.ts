// SPDX-License-Identifier: Apache-2.0
/**
 * Sorting for a Project page's ordered shelves — the Works a project holds and the posts
 * announcing them, both carried as arrays keyed by `sortOrder`.
 *
 * ⭐ **A Project's sort is a setting, and it governs what readers see** (Parker,
 * 2026-10-19, replacing the 2026-10-17 ruling that a non-manual mode was a read-only
 * view). The creator chooses a mode in the shelf's dropdown; the choice is stored on the
 * Project row (`worksSortMode` / `worksSortDirection` and their posts counterparts) and
 * the server serializes the members in that order. **Manual is the default and the stored
 * drag order** — the mode a Project keeps until its creator picks another — so a creator
 * who never touches the dropdown sees exactly what they arranged.
 *
 * This module is shared by both ends of that arrangement: the API sorts a detail response
 * with it, and the owner's shelves render with it, so what the editor shows and what a
 * reader receives cannot drift apart. `sortShelf` copies and never writes: a sort choice
 * changes the Project's reading order, never the membership's stored `sortOrder`.
 *
 * The member shape both serializations meet: the works of a project (`ProjectWork`) carry
 * `sortOrder`, the two release dates and a title; the posts (`ProjectPost`) carry
 * `sortOrder`, their `publishedAt` and a title. The comparators read whichever dated key
 * a member has, so one rule orders both shelves.
 */

/**
 * How a shelf is arranged for reading. `manual` is the stored drag order; the others are
 * named reading orders a creator may save as the Project's setting.
 */
export const SHELF_SORT_MODES = ["manual", "released", "original", "title"] as const;
export type ShelfSortMode = (typeof SHELF_SORT_MODES)[number];

/** Which way a mode reads. Disabled in the UI under Manual, where it means nothing. */
export const SHELF_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type ShelfSortDirection = (typeof SHELF_SORT_DIRECTIONS)[number];

/** The fields the comparators read, which both shelf serializations carry. */
export interface ShelfSortable {
	sortOrder: number;
	/**
	 * A dated key is a Date on the server (a Drizzle timestamp) and an ISO string in the
	 * browser (the JSON the API sends). The comparators normalize both rather than making
	 * each side convert before sorting, so one rule governs both ends.
	 */
	releasedAt?: string | Date | null;
	originallyReleased?: string | Date | null;
	/**
	 * A post's dated key. A Project post has no `releasedAt` — it is published, not
	 * released — so the dated modes read this when a member carries no release date. A
	 * shelf that forgot it sorted posts as one interminable tie.
	 */
	publishedAt?: string | Date | null;
	title?: string | null;
}

const collator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

/** A dated key as a comparable string, or null when there is no date to compare. */
function datedKey(value: string | Date | null | undefined): string | null {
	if (value == null || value === "") return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	return value;
}

/**
 * A stored mode read back as a mode. An unknown value is Manual rather than a crash: the
 * column has a default and the API validates writes, so this narrowing exists for the
 * boundary between a database string and the union, not as a second validation layer.
 */
export function asShelfSortMode(value: string | null | undefined): ShelfSortMode {
	return SHELF_SORT_MODES.includes(value as ShelfSortMode) ? (value as ShelfSortMode) : "manual";
}

/** A stored direction read back as a direction; anything unrecognized reads Ascending. */
export function asShelfSortDirection(value: string | null | undefined): ShelfSortDirection {
	return SHELF_SORT_DIRECTIONS.includes(value as ShelfSortDirection)
		? (value as ShelfSortDirection)
		: "asc";
}

/**
 * The key a mode sorts by, and its sort's empties rule.
 *
 * A member with no answer for its key sorts LAST, by both directions — a deliberate rule
 * rather than a tie-break accident: drafts (no release yet) and untitled rows should
 * gather at an end of the list and not scatter between dated entries as direction flips.
 * `original` falls back to the release date, for members that came out here first — the
 * same meaning an empty `originallyReleased` has on the Work page. The dated key is
 * `releasedAt`, or `publishedAt` for a post, which is published rather than released.
 */
export function shelfSortKey(
	item: ShelfSortable,
	mode: Exclude<ShelfSortMode, "manual">,
): string | null {
	if (mode === "title") return item.title ? item.title : null;
	const released = item.releasedAt ?? item.publishedAt;
	const value = mode === "original" ? (item.originallyReleased ?? released) : released;
	return datedKey(value);
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
 * The shelf in one sort mode. Manual returns the array itself — the stored order IS the
 * shelf — and every other mode returns a sorted copy, never a mutation, because a sort
 * choice must not rewrite the membership's own positions.
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

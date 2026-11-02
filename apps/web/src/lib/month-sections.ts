// SPDX-License-Identifier: Apache-2.0
//
// Grouping a creator's content into the months it came out in — the profile's monthly
// sections. The page has always rendered one flat run of tiles, newest first; the
// sections add the one thing a flat run cannot say, which is *when* the work landed.
//
// Two shape rules live here rather than in the renderer, because they are the ones a
// reader notices:
//
// - **A month with nothing in it gets no heading.** Months are not a calendar walk; a
//   section exists only where an entry exists. So a month that had nothing never gains
//   a heading that would read as though it did.
// - **A stretch of empty months collapses into one gap.** Between two populated months
//   the renderer draws a single vertical-ellipsis spacer, however many months the
//   creator skipped — one glyph for "time passed here", not one per month. No spacer is
//   drawn before the newest month or after the oldest, because there is nothing on the
//   other side of it to separate.
//
// Entries whose date will not parse are the one exception to the month walk: they trail
// the timeline under an "Undated" heading. A Work can legitimately carry no date at all
// (`originallyReleased`, `releasedAt` and `createdAt` are each nullable in the listing),
// and dropping it out of the grid would hide content rather than file it.

/** The month a section holds, the spacer between two sections, or the trailing remainder. */
export type MonthSection<T> =
	| { kind: "month"; key: string; label: string; items: T[] }
	| {
			kind: "gap";
			key: string;
			label: string /** The skipped months, newest first. */;
			months: string[];
	  }
	| { kind: "undated"; key: "undated"; label: string; items: T[] };

/** "November 2026" — the heading a month section wears, and the unit a gap names. */
export function monthLabel(year: number, month: number): string {
	return new Date(year, month, 1).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
	});
}

/**
 * The label the spacer carries for the reader who cannot see the glyph. One skipped
 * month names itself; a run of them names the span, because "no content in three
 * months" leaves the reader to work out which three.
 */
function gapLabel(months: string[]): string {
	if (months.length === 1) return `No content in ${months[0]}`;
	return `No content from ${months[months.length - 1]} to ${months[0]}`;
}

/**
 * Group entries by the month of `dateOf(entry)`, newest month first, with one gap
 * section wherever two populated months are not adjacent on the calendar.
 *
 * The input need not be sorted: the output is always newest-first, so a caller handing
 * over a listing in whatever order its API chose gets sections that read correctly.
 */
export function monthSections<T>(
	items: readonly T[],
	dateOf: (item: T) => string,
): MonthSection<T>[] {
	const dated: { item: T; time: number }[] = [];
	const undated: T[] = [];

	for (const item of items) {
		const time = Date.parse(dateOf(item));
		if (Number.isNaN(time)) undated.push(item);
		else dated.push({ item, time });
	}
	dated.sort((a, b) => b.time - a.time);

	const groups: { key: string; label: string; index: number; items: T[] }[] = [];
	for (const { item, time } of dated) {
		const at = new Date(time);
		const year = at.getFullYear();
		const month = at.getMonth();
		const index = year * 12 + month;
		const last = groups[groups.length - 1];
		if (last && last.index === index) {
			last.items.push(item);
			continue;
		}
		groups.push({
			key: `${year}-${String(month + 1).padStart(2, "0")}`,
			label: monthLabel(year, month),
			index,
			items: [item],
		});
	}

	const sections: MonthSection<T>[] = [];
	for (const [position, group] of groups.entries()) {
		const previous = groups[position - 1];
		if (previous && previous.index - group.index > 1) {
			const months: string[] = [];
			for (let index = previous.index - 1; index > group.index; index--) {
				months.push(monthLabel(Math.floor(index / 12), index % 12));
			}
			sections.push({
				kind: "gap",
				key: `gap-${group.key}`,
				label: gapLabel(months),
				months,
			});
		}
		sections.push({ kind: "month", key: group.key, label: group.label, items: group.items });
	}

	if (undated.length > 0) {
		sections.push({ kind: "undated", key: "undated", label: "Undated", items: undated });
	}

	return sections;
}

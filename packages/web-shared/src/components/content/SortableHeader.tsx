// SPDX-License-Identifier: Apache-2.0
/**
 * A sortable table column header, shared by the Studio listing tables (Works, Projects):
 * a button whose repeat click flips the direction, an arrow that shows only while the
 * column is the one sorted by, and an `aria-sort` the caller sets on its `th` — this
 * component renders the control, the column semantics stay in the table.
 */

export type SortDirection = "asc" | "desc";

export default function SortableHeader<K extends string>({
	label,
	sortKey,
	sort,
	onSort,
	className,
}: {
	label: string;
	sortKey: K;
	/** The table's current sort: the column it names and the direction it runs. */
	sort: { key: K; dir: SortDirection };
	onSort: (key: K) => void;
	className?: string;
}) {
	const active = sort.key === sortKey;
	return (
		<button
			type="button"
			className={`flex items-center gap-1 hover:text-base-content transition-colors ${className ?? ""}`}
			onClick={() => onSort(sortKey)}
		>
			{label}
			<span className={active ? "" : "opacity-0"} aria-hidden="true">
				{active ? (sort.dir === "asc" ? "↑" : "↓") : "↓"}
			</span>
		</button>
	);
}

/** The `aria-sort` a column header's `th` carries, given the table's current sort. */
export function ariaSort(sort: { key: string; dir: SortDirection }, key: string) {
	if (sort.key !== key) return undefined;
	return sort.dir === "asc" ? "ascending" : "descending";
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The search dropdown: type chips, the two result stages, and the local navigation
 * results.
 *
 * The panel is the whole surface — there is no results page. It caps its own height and
 * scrolls, so a long list never grows the page or moves the view behind it. The chips are
 * the visible half of `Tab` cycling: pressing Tab changes the same state a click does.
 *
 * Stage one and stage two are labeled sections rather than one merged list, because the
 * distinction is real to the reader: a name match is a stronger answer than a mention in
 * a description, and the second section may still be arriving while the first is usable.
 */

import { useEffect, useRef } from "react";
import SearchRow, { type PanelRow } from "./search-row";
import type { SearchFilter } from "./use-global-search";

const FILTERS: { id: SearchFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "creator", label: "Creators" },
	{ id: "work", label: "Works" },
	{ id: "project", label: "Projects" },
	{ id: "post", label: "Posts" },
	{ id: "mode", label: "Modes" },
	{ id: "setting", label: "Settings" },
];

const SECTION_LABEL =
	"px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-base-content/40";

export default function SearchPanel({
	query,
	filter,
	onFilter,
	names,
	body,
	nav,
	active,
	onHover,
	onOpen,
	loadingNames,
	loadingBody,
	namesFailed,
	bodyFailed,
}: {
	query: string;
	filter: SearchFilter;
	onFilter: (filter: SearchFilter) => void;
	names: PanelRow[];
	body: PanelRow[];
	nav: PanelRow[];
	active: number;
	onHover: (index: number) => void;
	onOpen: () => void;
	loadingNames: boolean;
	loadingBody: boolean;
	namesFailed: boolean;
	bodyFailed: boolean;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const total = names.length + body.length + nav.length;

	// Keep the highlighted row visible as the arrows move, without scrolling the page.
	useEffect(() => {
		if (active < 0) return;
		listRef.current?.querySelector(`#search-row-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	let index = 0;

	return (
		<div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border border-base-300/50 bg-base-200 shadow-xl">
			<div
				role="toolbar"
				aria-label="Search Types"
				className="flex gap-1 overflow-x-auto border-b border-base-300/50 px-2 py-2"
			>
				{FILTERS.map((item) => (
					<button
						key={item.id}
						type="button"
						aria-pressed={filter === item.id}
						className={`btn btn-xs shrink-0 rounded-full ${
							filter === item.id ? "btn-primary" : "btn-ghost text-base-content/60"
						}`}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onFilter(item.id)}
					>
						{item.label}
					</button>
				))}
			</div>

			<div
				ref={listRef}
				id="search-results"
				role="listbox"
				aria-label="Search Results"
				className="max-h-[min(70vh,32rem)] overflow-y-auto overscroll-contain"
			>
				{loadingNames && total === 0 ? (
					<div className="flex items-center justify-center px-4 py-8">
						<span className="loading loading-spinner loading-sm text-base-content/40" />
					</div>
				) : namesFailed && total === 0 ? (
					<p className="px-4 py-6 text-center text-sm text-base-content/50">
						Search is unavailable right now. Try again in a moment.
					</p>
				) : total === 0 ? (
					<p className="px-4 py-6 text-center text-sm text-base-content/50">
						{query.trim() ? `No results for “${query.trim()}”.` : "Type to search."}
					</p>
				) : (
					<>
						{names.length > 0 && (
							<>
								<p className={SECTION_LABEL}>Best Matches</p>
								<ul>
									{names.map((row) => {
										const rowIndex = index++;
										return (
											<SearchRow
												key={row.key}
												row={row}
												index={rowIndex}
												active={active === rowIndex}
												onHover={() => onHover(rowIndex)}
												onOpen={onOpen}
											/>
										);
									})}
								</ul>
							</>
						)}

						{loadingBody && (
							<div className="flex items-center gap-2 px-3 py-2 text-xs text-base-content/45">
								<span className="loading loading-spinner loading-xs" />
								Searching descriptions, bios, and Post bodies…
							</div>
						)}

						{bodyFailed && names.length > 0 && (
							<p className="px-3 py-2 text-xs text-base-content/45">
								More results could not be loaded.
							</p>
						)}

						{body.length > 0 && (
							<>
								<p className={`${SECTION_LABEL} border-t border-base-300/40`}>More Results</p>
								<ul>
									{body.map((row) => {
										const rowIndex = index++;
										return (
											<SearchRow
												key={row.key}
												row={row}
												index={rowIndex}
												active={active === rowIndex}
												onHover={() => onHover(rowIndex)}
												onOpen={onOpen}
											/>
										);
									})}
								</ul>
							</>
						)}

						{nav.length > 0 && (
							<>
								<p className={`${SECTION_LABEL} border-t border-base-300/40`}>Go to</p>
								<ul>
									{nav.map((row) => {
										const rowIndex = index++;
										return (
											<SearchRow
												key={row.key}
												row={row}
												index={rowIndex}
												active={active === rowIndex}
												onHover={() => onHover(rowIndex)}
												onOpen={onOpen}
											/>
										);
									})}
								</ul>
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}

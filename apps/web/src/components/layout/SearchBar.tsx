// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in topbar's search, in two modes.
 *
 * **Search** (`Ctrl+K` by default) is global: every kind of content, plus the app's modes
 * and settings, ranked connected-first. **Filter** (`Ctrl+F` by default) narrows the view
 * on screen and never leaves it. Clicking the bar opens whichever mode the toggle shows;
 * the hotkeys choose a mode directly, and the toggle is the same state by mouse.
 *
 * 🚨 **Filter mode is opt-in per view.** A view declares itself through `useFilterable`;
 * on a Work page, a profile or Settings there is nothing to narrow, so the bar grays
 * Filter and leaves the browser's own find on that chord. The alternative — guessing from
 * the route — is a table that is wrong the first time a page changes.
 *
 * The shortcuts are an account preference, resolved here from the signed-in user. The bar
 * never hardcodes them: `Mod` is Command on a Mac and Control elsewhere, and a person who
 * rebinds Filter gets the browser's find back on the old chord.
 */
import { formatChord, matchesChord, resolveSearchShortcuts } from "@anthers/shared/keybindings";
import { matchesTerms, searchTerms } from "@anthers/shared/search";
import { useAuth } from "@anthers/web-shared/auth";
import { useLocation, useNavigate, useSearchParams } from "@anthers/web-shared/router";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isApplePlatform } from "../../lib/platform";
import { useFilterableView } from "./search/filter-context";
import { NAVIGATION_INDEX } from "./search/navigation-index";
import SearchPanel from "./search/search-panel";
import { hitToRow, navToRow, type PanelRow } from "./search/search-row";
import { type SearchFilter, useGlobalSearch } from "./search/use-global-search";

type SearchMode = "search" | "filter";

const FILTER_ORDER: SearchFilter[] = [
	"all",
	"creator",
	"work",
	"project",
	"post",
	"mode",
	"setting",
];

export default function SearchBar() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();
	const filterableView = useFilterableView();

	const initialQuery = searchParams.get("q") ?? "";
	const [query, setQuery] = useState(initialQuery);
	const [mode, setMode] = useState<SearchMode>(initialQuery ? "filter" : "search");
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState<SearchFilter>("all");
	const [active, setActive] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const apple = isApplePlatform();
	const shortcuts = useMemo(
		() => resolveSearchShortcuts(user?.searchShortcuts),
		[user?.searchShortcuts],
	);

	const search = useGlobalSearch({
		query,
		filter,
		enabled: open && mode === "search",
	});

	/**
	 * The mode/setting half of the results. It is the same static list every time, filtered
	 * with the shared matcher, so it needs no request and cannot arrive late.
	 */
	const navRows = useMemo(() => {
		if (mode !== "search") return [];
		const terms = searchTerms(query);
		if (terms.length === 0) return [];
		return NAVIGATION_INDEX.filter((entry) => {
			if (filter !== "all" && filter !== entry.kind) return false;
			return matchesTerms(terms, [entry.label, ...entry.keywords]);
		}).map(navToRow);
	}, [mode, query, filter]);

	const namesRows = useMemo(
		() => search.names.map(hitToRow).filter((row): row is PanelRow => row !== null),
		[search.names],
	);
	const bodyRows = useMemo(
		() => search.body.map(hitToRow).filter((row): row is PanelRow => row !== null),
		[search.body],
	);
	const rows = useMemo(
		() => [...namesRows, ...bodyRows, ...navRows],
		[namesRows, bodyRows, navRows],
	);

	const panelOpen = open && mode === "search" && query.trim().length > 0;
	const activeId = panelOpen && active >= 0 ? `search-row-${active}` : undefined;

	const writeFilterParam = useCallback(
		(term: string) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					const value = term.trim();
					if (value) next.set("q", value);
					else next.delete("q");
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	const activate = useCallback(
		(next: SearchMode) => {
			if (next === "filter" && !filterableView) return;
			setMode(next);
			setOpen(true);
			inputRef.current?.focus();
			// Leaving Filter mode stops the view filtering; leaving Search leaves no term in
			// the URL behind either, because the two modes do not share storage.
			if (next === "search") writeFilterParam("");
		},
		[filterableView, writeFilterParam],
	);

	// The hotkeys. Ctrl+K is skipped while typing somewhere other than the bar, because
	// it is an editing command in the composer; Ctrl+F is allowed from a text field,
	// because it is find-in-view rather than editing.
	useEffect(() => {
		const handler = (event: globalThis.KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const editable =
				!!target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable);
			const onSearchInput = target === inputRef.current;

			if (matchesChord(event, shortcuts.search, apple)) {
				if (editable && !onSearchInput) return;
				event.preventDefault();
				activate("search");
				return;
			}
			if (matchesChord(event, shortcuts.filter, apple)) {
				if (!filterableView) return;
				event.preventDefault();
				activate("filter");
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [shortcuts, apple, filterableView, activate]);

	// Filter mode writes the URL as the reader types. The view reads it through the same
	// provider, so the narrowing happens on the page rather than in this component.
	useEffect(() => {
		if (mode !== "filter") return;
		const timer = setTimeout(() => writeFilterParam(query), 120);
		return () => clearTimeout(timer);
	}, [mode, query, writeFilterParam]);

	// A click outside closes the panel. In Filter mode the term stays and the view stays
	// narrowed — dismissing the bar is not the same as clearing the filter.
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	// Navigation closes the panel and adopts whatever filter the destination carries.
	// The path is compared rather than depended on alone: this effect also runs when the
	// bar writes its own `q`, and adopting that value back would fight the reader mid-word.
	const lastPath = useRef(location.pathname);
	useEffect(() => {
		if (lastPath.current === location.pathname) return;
		lastPath.current = location.pathname;
		setOpen(false);
		const next = new URLSearchParams(location.search).get("q") ?? "";
		setQuery(next);
		setActive(-1);
		// A destination with a term opens in Filter; one without returns to Search, so
		// leaving a filtered view does not strand the bar in a mode the next page cannot
		// consume.
		setMode(next ? "filter" : "search");
	}, [location.pathname, location.search]);

	const clear = useCallback(() => {
		setQuery("");
		setActive(-1);
		writeFilterParam("");
	}, [writeFilterParam]);

	const close = useCallback(() => {
		setOpen(false);
		setQuery("");
		setActive(-1);
		writeFilterParam("");
		inputRef.current?.blur();
	}, [writeFilterParam]);

	const cycleFilter = useCallback((direction: 1 | -1) => {
		setFilter((current) => {
			const at = FILTER_ORDER.indexOf(current);
			return FILTER_ORDER[(at + direction + FILTER_ORDER.length) % FILTER_ORDER.length];
		});
		setActive(-1);
	}, []);

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return;
		}
		if (mode !== "search") return;
		if (event.key === "Tab" && panelOpen) {
			event.preventDefault();
			cycleFilter(event.shiftKey ? -1 : 1);
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((current) => Math.min(current + 1, rows.length - 1));
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((current) => (current <= 0 ? 0 : current - 1));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const row = rows[active >= 0 ? active : 0];
			if (!row) return;
			setOpen(false);
			setQuery("");
			setActive(-1);
			navigate(row.href);
		}
	};

	const placeholder = mode === "search" ? "Search..." : "Filter...";
	const border =
		mode === "search" ? "border-primary/50 bg-primary/5" : "border-secondary/50 bg-secondary/5";
	const iconColor = mode === "search" ? "text-primary" : "text-secondary";

	return (
		<div ref={containerRef} className="relative w-[min(46vw,680px)]">
			<div
				className={`flex items-center gap-1 rounded-lg border-2 px-2 transition-colors ${border}`}
			>
				<MagnifyingGlassIcon className={`ml-1 h-4 w-4 shrink-0 ${iconColor}`} />
				<input
					ref={inputRef}
					type="text"
					placeholder={placeholder}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(-1);
					}}
					onFocus={() => setOpen(true)}
					onKeyDown={handleKeyDown}
					autoComplete="off"
					spellCheck={false}
					role="combobox"
					aria-expanded={panelOpen}
					aria-controls="search-results"
					aria-autocomplete="list"
					aria-activedescendant={activeId}
					aria-label={
						mode === "search" ? "Search Anthers" : `Filter ${filterableView?.label ?? "this view"}`
					}
					className="input input-sm h-8 min-w-0 flex-1 border-none bg-transparent px-1 focus:outline-none"
				/>

				{query.length > 0 && (
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-circle shrink-0"
						onMouseDown={(event) => event.preventDefault()}
						onClick={clear}
						aria-label="Clear search"
					>
						<XMarkIcon className="h-3.5 w-3.5" />
					</button>
				)}

				{/* The two-way switch. Clicking it keeps focus in the input, so the reader
				    can type straight through a mode change. */}
				<div className="join shrink-0">
					<button
						type="button"
						className={`btn btn-xs join-item gap-1 ${mode === "search" ? "btn-primary" : "btn-ghost text-base-content/55"}`}
						aria-pressed={mode === "search"}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => activate("search")}
					>
						Search
						<kbd className="kbd kbd-xs">{formatChord(shortcuts.search, apple)}</kbd>
					</button>
					<button
						type="button"
						className={`btn btn-xs join-item gap-1 ${mode === "filter" ? "btn-secondary" : "btn-ghost text-base-content/55"}`}
						aria-pressed={mode === "filter"}
						disabled={!filterableView}
						title={
							filterableView ? `Filter ${filterableView.label}` : "This view has nothing to filter"
						}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => activate("filter")}
					>
						Filter
						<kbd className="kbd kbd-xs">{formatChord(shortcuts.filter, apple)}</kbd>
					</button>
				</div>
			</div>

			<span className="sr-only" aria-live="polite">
				{panelOpen ? `${rows.length} results` : ""}
			</span>

			{panelOpen && (
				<SearchPanel
					query={query}
					filter={filter}
					onFilter={(next) => {
						setFilter(next);
						setActive(-1);
					}}
					names={namesRows}
					body={bodyRows}
					nav={navRows}
					active={active}
					onHover={setActive}
					onOpen={() => {
						setOpen(false);
						setQuery("");
						setActive(-1);
					}}
					loadingNames={search.loadingNames}
					loadingBody={search.loadingBody}
					namesFailed={search.namesFailed}
					bodyFailed={search.bodyFailed}
				/>
			)}
		</div>
	);
}

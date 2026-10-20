// SPDX-License-Identifier: Apache-2.0
/**
 * Filter mode's one contract between the topbar and the view it filters.
 *
 * A view **declares itself filterable** and reads the terms the bar wrote. The bar cannot
 * know what a view lists, and a view cannot know whether the bar is in Filter mode, so the
 * two meet on the URL: the bar writes `?q=` with `replace`, and this provider reads it.
 *
 * ⚠️ **The declaration is what makes the hotkey honest.** On a Work page, a profile or
 * Settings there is no list to filter, so nothing declares itself; the bar disables Filter
 * and leaves `Ctrl+F` to the browser's own find. Without the declaration the bar would
 * have to guess from a route table and would be wrong the first time a page changed.
 *
 * The term lives in the URL rather than in React state for the reasons every other view
 * filter does: a reload keeps it, Back undoes it, and a link can carry it. The provider
 * derives the terms with the shared matcher, so a page filters with the same rule the
 * server does.
 */
import { matchesTerms, searchTerms } from "@anthers/shared/search";
import { useSearchParams } from "@anthers/web-shared/router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export interface Filterable {
	/** The view's own name, for the bar's title and the empty state. */
	label: string;
}

interface FilterContextValue {
	filterable: Filterable | null;
	/** Stable registrar, called by `useFilterable`. */
	register: (declaration: Filterable | null) => void;
	/** The raw `q`, empty when nothing is filtering. */
	query: string;
	/** The shared matcher's terms. */
	terms: string[];
	matches: (fields: readonly (string | null | undefined)[]) => boolean;
}

const FilterContext = createContext<FilterContextValue | null>(null);

export function ViewFilterProvider({ children }: { children: ReactNode }) {
	const [params] = useSearchParams();
	const query = params.get("q") ?? "";
	const terms = useMemo(() => searchTerms(query), [query]);
	const [filterable, setFilterable] = useState<Filterable | null>(null);

	// The setter is stable; the declaration object is not held in a dependency, or the
	// registering view's effect would tear itself down every time it changed the state.
	const register = useCallback((declaration: Filterable | null) => {
		setFilterable(declaration);
	}, []);

	const matches = useCallback(
		(fields: readonly (string | null | undefined)[]) => matchesTerms(terms, fields),
		[terms],
	);

	const value = useMemo(
		() => ({ filterable, register, query, terms, matches }),
		[filterable, register, query, terms, matches],
	);

	return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

/** What the view needs: the terms and the matcher. Outside a provider, nothing filters. */
export function useViewFilter(): Pick<FilterContextValue, "query" | "terms" | "matches"> {
	const context = useContext(FilterContext);
	if (!context) {
		return { query: "", terms: [], matches: () => true };
	}
	return { query: context.query, terms: context.terms, matches: context.matches };
}

/** Declare this view filterable for as long as it is mounted. */
export function useFilterable(label: string): void {
	const context = useContext(FilterContext);
	const register = context?.register;
	useEffect(() => {
		if (!register) return;
		register({ label });
		return () => register(null);
	}, [register, label]);
}

/** What the bar needs: whether this route has a view that would consume a filter term. */
export function useFilterableView(): Filterable | null {
	const context = useContext(FilterContext);
	return context?.filterable ?? null;
}

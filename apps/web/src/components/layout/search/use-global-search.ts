// SPDX-License-Identifier: Apache-2.0
/**
 * The two-stage global search request.
 *
 * Stage one asks for names and titles and renders as soon as it lands. Stage two asks for
 * bios, descriptions and Post bodies, and only when stage one came up short — a query with
 * a handful of name matches never pays for the slower fields. The stages stay separate in
 * state so the panel can put a divider between them rather than presenting one list that
 * changed underneath the reader.
 *
 * 🚨 **Every request is abortable, and stage two carries stage one's rows as exclusions.**
 * The old bar had no abort, so a slow early keystroke could overwrite a fast later one.
 * Excluding by `kind:id` keeps the second pass's cap honest instead of letting duplicates
 * spend it.
 */
import {
	SEARCH_BODY_STAGE_BELOW,
	type SearchHit,
	type SearchType,
	searchTerms,
} from "@anthers/shared/search";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

export type SearchFilter = "all" | SearchType | "mode" | "setting";

export interface GlobalSearchState {
	names: SearchHit[];
	body: SearchHit[];
	loadingNames: boolean;
	loadingBody: boolean;
	namesFailed: boolean;
	bodyFailed: boolean;
}

const EMPTY: GlobalSearchState = {
	names: [],
	body: [],
	loadingNames: false,
	loadingBody: false,
	namesFailed: false,
	bodyFailed: false,
};

/** A content filter asks the server; the two local kinds never do. */
export function isServerFilter(filter: SearchFilter): filter is "all" | SearchType {
	return filter !== "mode" && filter !== "setting";
}

export function useGlobalSearch({
	query,
	filter,
	enabled,
}: {
	query: string;
	filter: SearchFilter;
	enabled: boolean;
}): GlobalSearchState {
	const [state, setState] = useState<GlobalSearchState>(EMPTY);

	useEffect(() => {
		if (!enabled || !isServerFilter(filter) || searchTerms(query).length === 0) {
			setState(EMPTY);
			return;
		}

		const controller = new AbortController();
		const terms = searchTerms(query);
		const limit = filter === "all" ? "5" : "20";
		setState({ ...EMPTY, loadingNames: true });

		const timer = setTimeout(async () => {
			const base = new URLSearchParams({ q: query, scope: "names", limit });
			if (filter !== "all") base.set("type", filter);

			try {
				const res = await apiFetch(`/api/search?${base.toString()}`, {
					signal: controller.signal,
				});
				if (!res.ok) throw new Error(String(res.status));
				const json = (await res.json()) as { results: SearchHit[] };
				if (controller.signal.aborted) return;
				const names = json.results;
				setState({
					...EMPTY,
					names,
					loadingNames: false,
				});

				// Stage two is a second request, not a wider first one: the panel already
				// has something to show, and a reader who acts on it never waits for this.
				if (names.length >= SEARCH_BODY_STAGE_BELOW || terms.length === 0) return;
				const bodyParams = new URLSearchParams({ q: query, scope: "body", limit });
				if (filter !== "all") bodyParams.set("type", filter);
				if (names.length > 0) {
					bodyParams.set("exclude", names.map((hit) => `${hit.kind}:${hit.id}`).join(","));
				}
				setState((prev) => ({ ...prev, loadingBody: true }));
				const bodyRes = await apiFetch(`/api/search?${bodyParams.toString()}`, {
					signal: controller.signal,
				});
				if (!bodyRes.ok) throw new Error(String(bodyRes.status));
				const bodyJson = (await bodyRes.json()) as { results: SearchHit[] };
				if (controller.signal.aborted) return;
				const shown = new Set(names.map((hit) => `${hit.kind}:${hit.id}`));
				setState((prev) => ({
					...prev,
					loadingBody: false,
					body: bodyJson.results.filter((hit) => !shown.has(`${hit.kind}:${hit.id}`)),
				}));
			} catch {
				if (controller.signal.aborted) return;
				// A failed first pass is the only one that leaves the panel empty; a failed
				// second pass keeps the results the reader already has.
				setState((prev) => ({
					...prev,
					loadingNames: false,
					loadingBody: false,
					namesFailed: prev.names.length === 0,
					bodyFailed: prev.names.length > 0,
				}));
			}
		}, 200);

		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [query, filter, enabled]);

	return state;
}

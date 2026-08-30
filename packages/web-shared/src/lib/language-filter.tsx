// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The language filter, browser side — whether it is on, and how to apply it to markup.
 *
 * The word list and the substitution itself are `@anthers/shared/parental-controls`, which is
 * pure. This file adds the two things only a browser can do: read the account's setting once
 * for the whole app, and walk **text nodes** so that HTML survives the transformation.
 *
 * 🚨 **Never run `censorText` over a string of HTML.** A tag name, an attribute or a URL can
 * contain a listed word, and rewriting one would change where a link points or break the
 * markup outright — `<a href="/works/assassin-1">` is the obvious way to find that out in
 * production. `censorHtml` parses first and only touches text.
 *
 * ⚠️ **It is a display transformation and nothing else.** Nothing censored here is censored
 * anywhere else: the stored Work is untouched, other readers see the original, and turning the
 * setting off restores everything immediately. That is the same rule the maturity veil follows,
 * and for the same reason — a reader's preference must never become a fact about somebody
 * else's work.
 */
import { censorText } from "@anthers/shared/parental-controls";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { apiFetch } from "./rpc";

const LanguageFilterContext = createContext(false);

/** Whether this reader has asked for softened language. */
export function useLanguageFilter(): boolean {
	return useContext(LanguageFilterContext);
}

/**
 * Reads the account's parental controls once and shares the one flag every surface needs.
 *
 * Defaults to **off** while it loads and on any failure, which is the right direction for a
 * *display* preference: a reader briefly seeing the original words is a smaller wrong than a
 * page that flickers, and nothing here is a safety control. The controls that actually protect
 * somebody are enforced server-side and cannot be affected by this request failing.
 */
export function LanguageFilterProvider({ children }: { children: ReactNode }) {
	const [on, setOn] = useState(false);

	useEffect(() => {
		let canceled = false;
		(async () => {
			try {
				const res = await apiFetch("/api/accounts/me/parental-controls");
				if (!res.ok) return;
				const policy = (await res.json()) as { enabled?: boolean; languageFilter?: boolean };
				if (!canceled) setOn(Boolean(policy.enabled && policy.languageFilter));
			} catch {
				/* off, which is the default */
			}
		})();
		return () => {
			canceled = true;
		};
	}, []);

	return <LanguageFilterContext.Provider value={on}>{children}</LanguageFilterContext.Provider>;
}

/**
 * Substitute the listed words inside HTML, leaving the markup alone.
 *
 * Parses into an inert document — `DOMParser` runs no scripts and loads no resources — walks
 * every text node, and serializes back. The input is already sanitized server-side, so this is
 * not a security boundary and is not pretending to be one; it is a text transformation that
 * happens to need a parser to be safe about *tags* rather than about scripts.
 */
export function censorHtml(html: string): string {
	if (!html) return html;
	try {
		const doc = new DOMParser().parseFromString(html, "text/html");
		const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			if (node.nodeValue) node.nodeValue = censorText(node.nodeValue);
			node = walker.nextNode();
		}
		return doc.body.innerHTML;
	} catch {
		// A parser failure must not blank the page. Returning the original is the honest
		// fallback: the reader sees what was written, which is what they would have seen with
		// the setting off.
		return html;
	}
}

/** `censorText` when the reader asked for it, and the original otherwise. */
export function useCensored(text: string | null | undefined): string {
	const on = useLanguageFilter();
	if (!text) return text ?? "";
	return on ? censorText(text) : text;
}

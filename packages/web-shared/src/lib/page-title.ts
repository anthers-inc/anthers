// SPDX-License-Identifier: Apache-2.0
/**
 * The browser tab title, and the one place its suffix lives.
 *
 * Pages call `usePageTitle` with what they are; the helper appends the site name once, so
 * page code carries only its own label. Dynamic pages call it again when their data lands
 * (the title argument changes, the effect rewrites the tab) and may call it bare while
 * loading, which is why the same helper turns an empty label into the bare site name.
 *
 * This is the browser half of per-route metadata: the meta tags in the app shell are
 * shared by every route, so what they may say is decided at the shell; the tab title is
 * the one thing no route has to share, and a page that has already loaded its record has
 * no excuse not to name the tab after it.
 */

import { useEffect } from "react";

export function pageTitle(title?: string | null): string {
	return title ? `${title} — Anthers` : "Anthers";
}

/** Sets the tab title for as long as the caller is mounted; rewrites it when the label changes. */
export function usePageTitle(title?: string | null): void {
	useEffect(() => {
		document.title = pageTitle(title);
	}, [title]);
}

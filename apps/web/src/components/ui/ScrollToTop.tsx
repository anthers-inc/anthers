// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Resets the window scroll to the top on every route change. Without it, React
 * Router keeps the previous page's scroll offset, so navigating between pages
 * lands you part-way down the next one — which makes the page-bottom botanical
 * decor (grassy floor + side vines) appear to "pop" as it settles to the new
 * page's height. `useLayoutEffect` runs the reset before paint, so there's no
 * flash of the new page at the old scroll position. Renders nothing.
 */
export default function ScrollToTop() {
	const { pathname } = useLocation();
	useLayoutEffect(() => {
		window.scrollTo(0, 0);
	}, [pathname]);
	return null;
}

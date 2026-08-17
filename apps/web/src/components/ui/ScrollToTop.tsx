// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Resets the scroll to the top on every route change. Without it, React Router keeps the
 * previous page's scroll offset, so navigating between pages lands you part-way down the
 * next one — which makes the page-bottom botanical decor (grassy floor + side vines) appear
 * to "pop" as it settles to the new page's height. `useLayoutEffect` runs the reset before
 * paint, so there's no flash of the new page at the old scroll position. Renders nothing.
 *
 * 🚨 **There are TWO scrollers and this used to reset only one of them.** `LoggedOutLayout`
 * lets the window scroll; `LoggedInLayout` puts the page inside
 * `<main class="flex-1 overflow-y-auto">` so the sidebar can stay put — and in that layout
 * `window.scrollY` is *permanently* 0, so `window.scrollTo(0, 0)` is a no-op that costs
 * nothing and does nothing. The reset therefore worked on the marketing site and had never
 * once worked for a signed-in user, which is why nobody spotted it: the failure is invisible
 * unless the outgoing page is long AND the incoming one is a different page. Found
 * 2026-08-17 landing on the project editor after creating a Project — the new page came up
 * scrolled 222px down with its `<h1>` at y=-40, tucked behind the sticky Studio header, so
 * the creator's confirmation that anything had happened was off-screen.
 *
 * The generalizable half: **a scroll reset is a claim about whichever element actually
 * scrolls**, and a layout that moves the scroller silently voids it. Reset both rather than
 * detecting which layout is mounted — this component sits above the router and cannot know,
 * and scrolling an element that is already at 0 is free.
 */
export default function ScrollToTop() {
	const { pathname } = useLocation();
	useLayoutEffect(() => {
		window.scrollTo(0, 0);
		for (const el of document.querySelectorAll("main")) el.scrollTop = 0;
	}, [pathname]);
	return null;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Router re-export with View-Transition-by-default links.
//
// Everything from react-router-dom passes straight through, but <Link>/<NavLink>
// are wrapped so client-side navigations run through the browser's View
// Transitions API — the outgoing and incoming pages crossfade instead of cutting
// instantly, while the persistent shell (nav + botanical decor) stays put beneath.
// The crossfade timing lives in theme.css (`::view-transition-*`).
//
// Why not react-router's built-in `viewTransition` prop? It only takes effect on a
// DATA router (createBrowserRouter/RouterProvider). This app mounts a plain
// <BrowserRouter> + <Routes>, whose navigator is a bare history object that ignores
// the option, so the prop is a silent no-op here. Instead we drive the API
// ourselves: intercept a plain left-click, wrap the navigation in
// startViewTransition, and flushSync the navigate so React commits the new route
// synchronously inside the transition callback (so the browser snapshots the new
// DOM, not the old one). Modified clicks, new-tab targets, download/reload links,
// reduced-motion, and browsers without the API all fall back to normal navigation.
//
// App code should import Link/NavLink (and any other router symbol) from here —
// `@anthers/web-shared/router` — rather than "react-router-dom", so every link
// transitions consistently without repeating anything at each call site.

import { forwardRef, useCallback } from "react";
import { flushSync } from "react-dom";
import {
	type LinkProps,
	type NavigateOptions,
	type NavLinkProps,
	Link as RRLink,
	NavLink as RRNavLink,
	type To,
	useNavigate,
} from "react-router-dom";

/** A modified click the browser should own (new tab, new window, etc.). */
function isModifiedEvent(e: React.MouseEvent): boolean {
	return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** True when this click is a plain in-app navigation we can take over for a transition. */
function isPlainLeftClick(e: React.MouseEvent, target?: string): boolean {
	return (
		!e.defaultPrevented && e.button === 0 && (!target || target === "_self") && !isModifiedEvent(e)
	);
}

/** A `navigate` that wraps the route change in a View Transition when it can. */
function useViewTransitionNavigate() {
	const navigate = useNavigate();
	return useCallback(
		(to: To, opts?: NavigateOptions) => {
			const start = document.startViewTransition?.bind(document);
			const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
			if (!start || reduce) {
				navigate(to, opts);
				return;
			}
			// flushSync so React commits the navigation inside the transition callback —
			// otherwise startViewTransition snapshots the *old* DOM and nothing crossfades.
			start(() => {
				flushSync(() => navigate(to, opts));
			});
		},
		[navigate],
	);
}

/** Shared onClick: hand plain left-clicks to a view-transitioned navigation; leave
 *  everything else (modified clicks, targets, opt-outs) to the browser / RR Link. */
function useTransitionClick(
	to: To,
	{
		onClick,
		target,
		replace,
		state,
		relative,
		preventScrollReset,
		reloadDocument,
		download,
	}: {
		onClick?: React.MouseEventHandler<HTMLAnchorElement>;
		target?: string;
		replace?: boolean;
		state?: unknown;
		relative?: LinkProps["relative"];
		preventScrollReset?: boolean;
		reloadDocument?: boolean;
		download?: unknown;
	},
) {
	const vtNavigate = useViewTransitionNavigate();
	return useCallback(
		(e: React.MouseEvent<HTMLAnchorElement>) => {
			onClick?.(e);
			// Full-page loads and downloads keep their native behavior.
			if (reloadDocument || download != null) return;
			if (!isPlainLeftClick(e, target)) return;
			// We own this one: stop RR's built-in handler and transition ourselves.
			e.preventDefault();
			vtNavigate(to, { replace, state, relative, preventScrollReset });
		},
		[
			onClick,
			reloadDocument,
			download,
			target,
			to,
			replace,
			state,
			relative,
			preventScrollReset,
			vtNavigate,
		],
	);
}

export * from "react-router-dom";

/** <Link> whose plain-left-click navigations crossfade via the View Transitions API. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(props, ref) {
	const handleClick = useTransitionClick(props.to, props);
	return <RRLink ref={ref} {...props} onClick={handleClick} />;
});

/** <NavLink> whose plain-left-click navigations crossfade via the View Transitions API. */
export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(props, ref) {
	const handleClick = useTransitionClick(props.to, props);
	return <RRNavLink ref={ref} {...props} onClick={handleClick} />;
});

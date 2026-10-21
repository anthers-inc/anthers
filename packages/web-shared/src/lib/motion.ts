// SPDX-License-Identifier: Apache-2.0
/**
 * The motion scale, mirrored for the Web Animations API, and the one reduced-motion read.
 *
 * `theme.css` owns the values — `--transition-duration-fast|base|slow` and `--ease-settle`
 * — because CSS is where most of the site's motion is written, and a Tailwind class is
 * the shortest thing a component can carry. The constants here are the same three
 * durations for the places a CSS transition cannot reach: the enter and exit animations
 * in `<Appear>` and the FLIP play in `useFlip`. They must stay in step with the theme
 * block, which is the price of driving an animation from JavaScript at all.
 *
 * `useReducedMotion` is the JavaScript half of the blanket contract in `theme.css`. CSS
 * neutralizes transitions on its own; this exists for animations a script starts, which
 * no media query can pre-empt.
 */

import { useEffect, useState } from "react";

/** Durations in milliseconds, matching `--transition-duration-*` in `theme.css`. */
export const MOTION = {
	fast: 120,
	base: 200,
	slow: 280,
} as const;

/** The house easing, matching `--ease-settle` in `theme.css`. */
export const EASE_SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The read itself, with the matcher injected so it can be tested without a DOM. A host
 * that cannot answer is not a host that asked for less motion, so a missing matcher is
 * `false` rather than an error.
 */
export function readReducedMotion(
	matchMedia: ((query: string) => MediaQueryList | undefined) | undefined,
): boolean {
	const query = matchMedia?.(REDUCED_MOTION_QUERY);
	return query ? query.matches : false;
}

/**
 * Whether the person has asked their system for less motion, for the one-time read a
 * callback needs. Components should use {@link useReducedMotion} instead so a change to
 * the system setting is followed while the page is open.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	return readReducedMotion((query) => window.matchMedia?.(query));
}

/** The same read, kept live across a change to the system setting. */
export function useReducedMotion(): boolean {
	const [reduce, setReduce] = useState(prefersReducedMotion);

	useEffect(() => {
		const query =
			typeof window === "undefined" ? undefined : window.matchMedia?.(REDUCED_MOTION_QUERY);
		if (!query) return;
		const onChange = () => setReduce(query.matches);
		// Re-read on mount as well: the lazy initializer runs before hydration in some
		// hosts, and the value can have changed between render and effect.
		onChange();
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	return reduce;
}

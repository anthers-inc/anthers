// SPDX-License-Identifier: Apache-2.0
//
// A one-shot scroll/load reveal: fades its children up into place the first time
// they enter the viewport (or immediately, on mount, for anything already above
// the fold). The motion itself lives in CSS (`[data-reveal]` in theme.css) so this
// component only toggles `data-revealed`; that keeps it framework-cheap and lets
// `prefers-reduced-motion` short-circuit the whole effect. Pass `delay` (ms) to
// stagger siblings. Wraps children in a plain block element by default; `as` swaps
// the tag when you need a different box (e.g. a grid/flex child).

import { type ElementType, useEffect, useRef, useState } from "react";

export function Reveal({
	children,
	className,
	delay = 0,
	as: Tag = "div",
	style,
	id,
	eager = false,
}: {
	children: React.ReactNode;
	className?: string;
	/** Stagger, in milliseconds, before this element's reveal transition runs. */
	delay?: number;
	as?: ElementType;
	style?: React.CSSProperties;
	/**
	 * Reveal on mount instead of waiting for the observer.
	 *
	 * For the first section after a full-screen hero: that section is the continuation of
	 * the first screen rather than a scroll discovery, and on a tall display its heading
	 * sits just under the fold while its top padding is already visible, so the observer
	 * leaves a strip of unexplained blank space. Everything below keeps the observer.
	 */
	eager?: boolean;
	/**
	 * An anchor on the wrapper, for in-page links.
	 *
	 * A section that is a scroll target usually *is* a Reveal, and wrapping one in a bare
	 * `<div id>` just to carry the anchor puts a box between the grid and its child. Pair
	 * it with `scroll-mt-*` so the heading clears any sticky header.
	 */
	id?: string;
}) {
	const ref = useRef<HTMLElement>(null);
	const [revealed, setRevealed] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el || revealed) return;

		// Eager, no IntersectionObserver, or the visitor prefers reduced motion → skip the
		// observer and show the content right away.
		const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		if (eager || typeof IntersectionObserver === "undefined" || reduce) {
			setRevealed(true);
			return;
		}

		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setRevealed(true);
						io.disconnect();
						break;
					}
				}
			},
			// Fire a touch before the element is fully in view so it's already
			// settling as it scrolls up into the reading area.
			{ rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [revealed, eager]);

	return (
		<Tag
			ref={ref}
			id={id}
			data-reveal=""
			data-revealed={revealed ? "" : undefined}
			className={className}
			style={delay ? ({ "--reveal-delay": `${delay}ms`, ...style } as React.CSSProperties) : style}
		>
			{children}
		</Tag>
	);
}

export default Reveal;

// SPDX-License-Identifier: AGPL-3.0-or-later
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
}: {
	children: React.ReactNode;
	className?: string;
	/** Stagger, in milliseconds, before this element's reveal transition runs. */
	delay?: number;
	as?: ElementType;
	style?: React.CSSProperties;
}) {
	const ref = useRef<HTMLElement>(null);
	const [revealed, setRevealed] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el || revealed) return;

		// No IntersectionObserver (or the visitor prefers reduced motion) → skip the
		// animation entirely and show the content right away.
		const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		if (typeof IntersectionObserver === "undefined" || reduce) {
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
	}, [revealed]);

	return (
		<Tag
			ref={ref}
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

// SPDX-License-Identifier: Apache-2.0
/**
 * Enter and exit for content that is conditionally rendered — the player bar, a queue or
 * lyrics panel, a dialog, a row that disappears.
 *
 * 🚨 **This exists because React unmounts on the same frame the state changes.** A
 * conditional element cannot animate out through CSS alone: by the time the browser would
 * run a close transition, the node is gone. `Appear` keeps it mounted through the exit,
 * plays the exit, and unmounts when it finishes. That is the whole reason it is a
 * primitive rather than a class.
 *
 * The default is a short fade and a small rise, which is the house entrance for a panel.
 * A caller that needs a different direction passes `distance`; a caller that needs no
 * travel passes `0`. Reduced motion renders the final state immediately and unmounts
 * immediately, so the content is never waiting on an animation to exist.
 */

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { EASE_SETTLE, MOTION, useReducedMotion } from "../../lib/motion";

export default function Appear({
	show,
	children,
	className = "",
	/** Vertical travel in pixels. Negative rises from above; `0` is a pure fade. */
	distance = 8,
	duration = MOTION.base,
	exitDuration = MOTION.fast,
}: {
	show: boolean;
	children: ReactNode;
	className?: string;
	distance?: number;
	/** Enter duration in milliseconds; defaults to the motion scale's base step. */
	duration?: number;
	/** Exit duration in milliseconds; exits are faster than entrances by default. */
	exitDuration?: number;
}) {
	const reduce = useReducedMotion();
	const [mounted, setMounted] = useState(show);
	const ref = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		// The first flip from hidden to shown has to mount before there is an element to
		// animate; the re-run below is what plays the entrance.
		if (show && !mounted) {
			setMounted(true);
			return;
		}
		if (!mounted) return;

		const element = ref.current;
		if (!element) return;

		if (reduce) {
			if (!show) setMounted(false);
			return;
		}

		if (show) {
			const animation = element.animate(
				[
					{ opacity: 0, transform: `translateY(${distance}px)` },
					{ opacity: 1, transform: "none" },
				],
				{ duration, easing: EASE_SETTLE, fill: "backwards" },
			);
			return () => animation.cancel();
		}

		const animation = element.animate(
			[
				{ opacity: 1, transform: "none" },
				{ opacity: 0, transform: `translateY(${distance}px)` },
			],
			{ duration: exitDuration, easing: EASE_SETTLE, fill: "forwards" },
		);
		let canceled = false;
		animation.finished
			.then(() => {
				if (!canceled) setMounted(false);
			})
			.catch(() => {
				// A canceled exit is a re-show, not a failure.
			});
		return () => {
			canceled = true;
			animation.cancel();
		};
	}, [show, mounted, reduce, distance, duration, exitDuration]);

	if (!mounted) return null;
	return (
		<div ref={ref} className={className}>
			{children}
		</div>
	);
}

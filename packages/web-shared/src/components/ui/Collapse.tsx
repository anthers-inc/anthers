// SPDX-License-Identifier: Apache-2.0
/**
 * Height-auto open and close for a section that stays in the DOM — a comment thread, a
 * filter group, a Studio panel, a reply composer.
 *
 * 🚨 **Height is measured, never guessed.** The usual `max-height: 9999px` trick makes
 * every close run at the wrong speed (the browser animates the whole guessed distance,
 * not the content's), and it clips a shadow or a focus ring that sits outside the box.
 * This measures the content's own height through `scrollHeight`, animates to it, then
 * releases the height to `auto` so the section keeps growing while it is open.
 *
 * The wrapper stays mounted, so the section's own state — a half-written reply, an open
 * field — survives a close and reopen. `inert` and `aria-hidden` take the closed content
 * out of the tab order and the accessibility tree without removing it from the layout.
 */

import { type ReactNode, useLayoutEffect, useRef } from "react";
import { EASE_SETTLE, MOTION, useReducedMotion } from "../../lib/motion";

export default function Collapse({
	open,
	children,
	className = "",
	id,
}: {
	open: boolean;
	children: ReactNode;
	className?: string;
	id?: string;
}) {
	const reduce = useReducedMotion();
	const ref = useRef<HTMLDivElement>(null);
	const initialized = useRef(false);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;

		// The first run happens before paint, so a section that mounts closed never shows
		// its content for a frame and then snaps shut.
		if (!initialized.current) {
			initialized.current = true;
			element.style.height = open ? "auto" : "0px";
			return;
		}

		if (reduce) {
			element.style.height = open ? "auto" : "0px";
			return;
		}

		const current = element.getBoundingClientRect().height;
		const target = open ? element.scrollHeight : 0;
		if (Math.abs(current - target) < 1) {
			element.style.height = open ? "auto" : "0px";
			return;
		}

		element.style.height = `${current}px`;
		const animation = element.animate([{ height: `${current}px` }, { height: `${target}px` }], {
			duration: open ? MOTION.base : MOTION.fast,
			easing: EASE_SETTLE,
			fill: "forwards",
		});
		let canceled = false;
		animation.finished
			.then(() => {
				if (canceled) return;
				element.style.height = open ? "auto" : "0px";
				animation.cancel();
			})
			.catch(() => {
				// A canceled animation is a second toggle, not a failure.
			});
		return () => {
			canceled = true;
			animation.cancel();
		};
	}, [open, reduce]);

	return (
		<div
			ref={ref}
			id={id}
			className={`overflow-clip ${className}`}
			inert={!open}
			aria-hidden={open ? undefined : true}
		>
			{children}
		</div>
	);
}

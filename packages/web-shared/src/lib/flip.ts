// SPDX-License-Identifier: Apache-2.0
/**
 * FLIP for lists whose order or membership changes in place — the Library after a card is
 * removed, the sidebar after a row is dragged, the Dashboard after a panel is moved.
 *
 * The consumer owns the timing, because only it knows when the DOM is about to change:
 * call `capture()` immediately before the state update, and `play()` in a layout effect
 * after it lands. The hook measures the children it can identify by `data-flip-id`, works
 * out how far each one moved, and animates it back from its old position — so the row
 * that ends up elsewhere travels there instead of teleporting.
 *
 * Reduced motion is a no-op: the list simply appears in its new order, which is still the
 * correct end state.
 */

import { useCallback, useRef } from "react";
import { EASE_SETTLE, MOTION, useReducedMotion } from "./motion";

/** The subset of a bounding rectangle FLIP needs. */
export interface FlipRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface FlipDelta {
	id: string;
	dx: number;
	dy: number;
}

/**
 * The travel of every element present in both measurements, in one testable function.
 * An element that only arrived or only left has nothing to travel from, so it is skipped;
 * an element that moved less than half a pixel is skipped so a subpixel layout nudge does
 * not start an animation.
 */
export function flipDeltas(
	before: ReadonlyMap<string, FlipRect>,
	after: ReadonlyMap<string, FlipRect>,
): FlipDelta[] {
	const deltas: FlipDelta[] = [];
	for (const [id, from] of before) {
		const to = after.get(id);
		if (!to) continue;
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		deltas.push({ id, dx, dy });
	}
	return deltas;
}

/**
 * One container's FLIP state. `ref` goes on the container, `capture` before the change,
 * `play` after it. Every direct child that should move needs `data-flip-id="<stable id>"`;
 * children without one are ignored rather than guessed at by index, because an index
 * means something different after a removal.
 */
export function useFlip<T extends HTMLElement = HTMLElement>() {
	const containerRef = useRef<T>(null);
	const previous = useRef<Map<string, FlipRect>>(new Map());
	const reduce = useReducedMotion();

	const measure = useCallback((): Map<string, FlipRect> => {
		const container = containerRef.current;
		const rects = new Map<string, FlipRect>();
		if (!container) return rects;
		for (const child of Array.from(container.children)) {
			const element = child as HTMLElement;
			const id = element.dataset.flipId;
			if (!id) continue;
			const rect = element.getBoundingClientRect();
			rects.set(id, { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
		}
		return rects;
	}, []);

	const capture = useCallback(() => {
		previous.current = measure();
	}, [measure]);

	const play = useCallback(() => {
		if (reduce) {
			previous.current = new Map();
			return;
		}
		const container = containerRef.current;
		if (!container || previous.current.size === 0) return;

		const next = measure();
		const byId = new Map<string, HTMLElement>();
		for (const child of Array.from(container.children)) {
			const element = child as HTMLElement;
			const id = element.dataset.flipId;
			if (id) byId.set(id, element);
		}

		for (const { id, dx, dy } of flipDeltas(previous.current, next)) {
			const element = byId.get(id);
			if (!element) continue;
			element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
				duration: MOTION.base,
				easing: EASE_SETTLE,
			});
		}

		previous.current = next;
	}, [measure, reduce]);

	return { containerRef, capture, play };
}

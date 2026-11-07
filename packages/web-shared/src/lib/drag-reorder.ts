// SPDX-License-Identifier: Apache-2.0
/**
 * One drag-to-reorder affordance for every hand-rolled list in the app.
 *
 * ⭐ **A drag shows itself while it happens** (Parker, 2026-11-06). The four lists that
 * reorder by hand each grew their own `onDragStart`/`onDrop` pair, and each one moved
 * nothing until the pointer came up: no ghost of the row being carried, and no indication
 * of where it would land. This hook supplies both — the browser's drag image is a clone of
 * the row itself, and the list reorders live underneath the pointer, so the gap the item
 * will occupy is always the gap it is in.
 *
 * The other three pieces are shared too. `useFlip` animates the rows the live preview
 * moves, so the list visibly makes way rather than jumping; a pure `moveKey` is the whole
 * ordering rule, tested without a browser; and `moveBy` keeps the keyboard arrows the
 * Badge perks table already offered.
 *
 * 🚨 **Nothing is persisted until the drop.** The preview is local state; `onReorder` runs
 * once, on drop, with the original index and the preview's landing index. A promise from
 * `onReorder` holds the preview until it settles, so a save that writes through the server
 * does not flash the old order before the new one arrives. A canceled drag (or one that
 * drops outside the list) restores the original order.
 */

import { type DragEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFlip } from "./flip";

/** Move one item from `from` to `to`, preserving every other item's order. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
		return [...items];
	}
	const next = [...items];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** Move one key from `from` to `to`, preserving every other key's order. */
export function moveKey(keys: readonly string[], from: number, to: number): string[] {
	return moveItem(keys, from, to);
}

export interface DragReorderOptions<T> {
	/** The list in its committed order. */
	items: readonly T[];
	/** A stable identity for one item — a database id, a storage key, a draft's UUID. */
	keyOf: (item: T) => string;
	/** Called once, on drop, with the original and landing indices of the moved item. */
	onReorder: (from: number, to: number) => void | Promise<void>;
	/** Manual mode's off switch; the handle still renders, and refuses to start a drag. */
	disabled?: boolean;
}

/** Handlers for the row that receives the drop. */
export interface DragReorderItemProps {
	"data-drag-item": "";
	"data-flip-id": string;
	"data-dragging"?: "true";
	onDragOver: (event: DragEvent<HTMLElement>) => void;
	onDrop: (event: DragEvent<HTMLElement>) => void;
}

/** Handlers for the grip inside the row. */
export interface DragReorderHandleProps {
	draggable: boolean;
	onDragStart: (event: DragEvent<HTMLElement>) => void;
	onDragEnd: (event: DragEvent<HTMLElement>) => void;
}

export interface DragReorder<T, C extends HTMLElement = HTMLElement> {
	/** The list to render: the committed order, or the live preview while a drag is up. */
	items: readonly T[];
	/** Put this on the container whose direct children are the rows. */
	containerRef: React.RefObject<C | null>;
	/** Spread onto the row. */
	itemProps: (index: number) => DragReorderItemProps;
	/** Spread onto the grip inside the row. */
	handleProps: (index: number) => DragReorderHandleProps;
	/** Whether this row is the one being carried. */
	isDragging: (index: number) => boolean;
	/** Move a row one or more places without a pointer — the keyboard path. */
	moveBy: (index: number, delta: number) => void;
}

export function useDragReorder<T, C extends HTMLElement = HTMLElement>(
	options: DragReorderOptions<T>,
): DragReorder<T, C> {
	const { items, keyOf, onReorder, disabled = false } = options;
	const { containerRef, capture, play } = useFlip<C>();

	// The live preview's key order. A ref mirrors it so two `dragover` events in one frame
	// cannot read a stale state value and step the row backwards.
	const [order, setOrderState] = useState<string[] | null>(null);
	const orderRef = useRef<string[] | null>(null);
	const [dragKey, setDragKeyState] = useState<string | null>(null);
	const dragKeyRef = useRef<string | null>(null);
	/** The row's index in the committed list when the drag began. */
	const fromRef = useRef<number | null>(null);
	/** A drop already reported this drag; `dragend` must not undo the preview. */
	const droppedRef = useRef(false);

	const setOrder = useCallback((next: string[] | null) => {
		orderRef.current = next;
		setOrderState(next);
	}, []);

	const setDragKey = useCallback((next: string | null) => {
		dragKeyRef.current = next;
		setDragKeyState(next);
	}, []);

	const committedKeys = useCallback(() => items.map((item) => keyOf(item)), [items, keyOf]);

	/** The committed list, or the preview order while a drag is live. */
	const ordered = useMemo(() => {
		if (!order) return items;
		const byKey = new Map(items.map((item) => [keyOf(item), item] as const));
		const seen = new Set(order);
		const next: T[] = [];
		for (const key of order) {
			const item = byKey.get(key);
			if (item !== undefined) next.push(item);
		}
		// An item that arrived mid-drag has no preview slot; keep it visible at the end
		// rather than dropping it from the list.
		for (const item of items) {
			if (!seen.has(keyOf(item))) next.push(item);
		}
		return next;
	}, [items, order, keyOf]);

	// Every preview step is a real reorder of the DOM, so FLIP is what makes the rows the
	// drag is not carrying move out of its way instead of teleporting. The effect keys on
	// the rendered order changing; `play` itself reads the DOM rather than `ordered`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ordered` is the trigger, not a value the effect reads.
	useLayoutEffect(() => {
		play();
	}, [ordered, play]);

	/**
	 * The browser's drag image is a clone of the whole row, sized and placed where the row
	 * is, hung off-screen for the one frame `setDragImage` needs to snapshot it. A bare
	 * `TR` needs a table around it to keep its own layout.
	 */
	const showDragImage = (row: HTMLElement, event: DragEvent<HTMLElement>) => {
		const rect = row.getBoundingClientRect();
		const clone = row.cloneNode(true) as HTMLElement;
		let ghost: HTMLElement = clone;
		if (row.tagName === "TR") {
			const table = document.createElement("table");
			const real = row.closest("table");
			if (real) table.className = real.className;
			table.style.width = `${rect.width}px`;
			const body = document.createElement("tbody");
			body.appendChild(clone);
			table.appendChild(body);
			ghost = table;
		}
		ghost.style.position = "fixed";
		ghost.style.top = `${-rect.height - 200}px`;
		ghost.style.left = `${-rect.width - 200}px`;
		ghost.style.width = `${rect.width}px`;
		ghost.style.margin = "0";
		ghost.style.pointerEvents = "none";
		ghost.style.opacity = "0.9";
		ghost.style.transform = "scale(1.02)";
		ghost.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.25)";
		document.body.appendChild(ghost);
		event.dataTransfer.setDragImage(ghost, event.clientX - rect.left, event.clientY - rect.top);
		requestAnimationFrame(() => ghost.remove());
	};

	const start = (event: DragEvent<HTMLElement>, index: number) => {
		if (disabled) {
			event.preventDefault();
			return;
		}
		const row = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-drag-item]");
		const key = committedKeys()[index];
		if (!row || key === undefined) {
			event.preventDefault();
			return;
		}
		droppedRef.current = false;
		fromRef.current = index;
		setDragKey(key);
		setOrder(committedKeys());
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", key);
		showDragImage(row, event);
	};

	const over = (event: DragEvent<HTMLElement>, index: number) => {
		const key = dragKeyRef.current;
		if (key === null) return;
		// Only an active drag may accept the drop; `preventDefault` is what says so.
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const current = orderRef.current ?? committedKeys();
		const from = current.indexOf(key);
		if (from === -1 || from === index) return;
		capture();
		setOrder(moveKey(current, from, index));
	};

	const drop = (event: DragEvent<HTMLElement>) => {
		const key = dragKeyRef.current;
		if (key === null) return;
		event.preventDefault();
		droppedRef.current = true;
		const from = fromRef.current;
		const current = orderRef.current ?? committedKeys();
		const to = current.indexOf(key);
		setDragKey(null);
		fromRef.current = null;
		if (from === null || to === -1 || from === to) {
			setOrder(null);
			return;
		}
		let result: void | Promise<void>;
		try {
			result = onReorder(from, to);
		} catch {
			setOrder(null);
			return;
		}
		if (result && typeof result.then === "function") {
			void result.finally(() => setOrder(null));
		} else {
			setOrder(null);
		}
	};

	const end = () => {
		setDragKey(null);
		fromRef.current = null;
		// A drop keeps the preview until its save settles; a canceled drag puts the list
		// back the way it was.
		if (!droppedRef.current) setOrder(null);
	};

	const isDragging = (index: number) => {
		const key = dragKey;
		return key !== null && ordered[index] !== undefined && keyOf(ordered[index]) === key;
	};

	const moveBy = (index: number, delta: number) => {
		const to = index + delta;
		if (to < 0 || to >= ordered.length || delta === 0) return;
		void onReorder(index, to);
	};

	return {
		items: ordered,
		containerRef,
		itemProps: (index: number) => ({
			"data-drag-item": "",
			"data-flip-id": keyOf(ordered[index]),
			"data-dragging": isDragging(index) ? "true" : undefined,
			onDragOver: (event: DragEvent<HTMLElement>) => over(event, index),
			onDrop: (event: DragEvent<HTMLElement>) => drop(event),
		}),
		handleProps: (index: number) => ({
			draggable: !disabled,
			onDragStart: (event: DragEvent<HTMLElement>) => start(event, index),
			onDragEnd: () => end(),
		}),
		isDragging,
		moveBy,
	};
}

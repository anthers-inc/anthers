// SPDX-License-Identifier: Apache-2.0
/**
 * The three-dot menu on a content tile — its placement and its behavior, never
 * the items.
 *
 * **What a menu offers belongs to the surface, not to the widget** (Parker,
 * 2026-11-06). A Work means different things in the Library and in Discovery —
 * kept or recommended — so the Library's items tidy what the reader saved and
 * Discovery's items shape what the feed offers next. The tile supplies the
 * trigger beside the title and the panel's placement; each listing surface
 * passes its own `<li>` rows.
 *
 * ⚠️ **A popover has to dismiss itself**, and a menu this ordinary owes its
 * reader both an outside click and Escape: the panel covers the card's own
 * body, and a keyboard user needs a way out that is not tabbing past every
 * row. The same effect the Sticker picker carries (`StickerBar.tsx`), without
 * its `<details>` toggle — a tile's trigger is a button, so it says so to a
 * screen reader.
 */
import { EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useEffect, useRef, useState } from "react";

export default function TileMenu({ label, children }: { label: string; children: ReactNode }) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		// Above the tile's stretched overlay and above the meta row's raised
		// CreatorLink (both z-10), so the panel is never painted under the row it
		// drops over.
		<div ref={rootRef} className="relative z-20">
			<button
				type="button"
				className="btn btn-ghost btn-xs btn-square"
				aria-label={label}
				aria-haspopup="true"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<EllipsisVerticalIcon className="size-4" aria-hidden />
			</button>
			{open && (
				// Any click inside the panel runs its row's action and closes the menu;
				// leaving it open over a card whose entry just changed would ask the
				// reader to dismiss a panel about a thing that may no longer be there.
				// Every row is a real button, so a keyboard Enter or Space arrives here
				// as a click too — the container is not itself interactive.
				// biome-ignore lint/a11y/useKeyWithClickEvents: the rows inside are buttons, and their keyboard activation bubbles here as a click.
				<ul
					className="menu absolute right-0 top-full z-30 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1.5 shadow-lg"
					onClick={() => setOpen(false)}
				>
					{children}
				</ul>
			)}
		</div>
	);
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The tab groups' shared **panel stack** — the one piece that makes switching tabs
 * change nothing about the page's height (Parker, 2026-10-17).
 *
 * ⭐ **The group is as tall as its tallest panel, always.** Every panel is laid out
 * in the same one grid cell, so the cell sizes to the tallest of them and the group
 * rides that height whichever tab is chosen — the derived-height rule the Work page
 * wanted from the start, with the layout engine doing the deriving: the grid
 * recomputes "the tallest tab" on every reflow, where a height captured in JS at
 * load time would go stale the moment a panel's content arrived or the window
 * rewrapped. `WorkReviews` is the concrete case: its list lands after the page does,
 * so any height captured at load is the panel's empty shape.
 *
 * ⭐ **The inactive panels stay mounted**, `invisible` rather than `hidden` —
 * `display: none` would take a panel out of the layout and the derived height with
 * it. `visibility: hidden` keeps the panel measurable while removing it from the
 * accessibility tree, the tab order and the pointer's way; `inert` answers any
 * focus the browser might hand it programmatically. Staying mounted means a switch
 * changes which panel shows, never what the panels hold: a half-written review or
 * an open field edit survives a flip of tabs instead of being discarded by an
 * unmount. The cost is that a hidden panel fetches what its content fetches
 * (`WorkReviews`'s one request lands with the page on the creator's own page, where
 * the visitor's default tab is not there to ask for it) — the same data, asked
 * earlier.
 *
 * ⚠️ **What this does not freeze is content.** The group's height still changes when
 * a panel's own content changes — a review arriving, a field opening for edit — and
 * that is the scroll keeper's ground (`Editing.tsx`), not this stack's. A tab
 * switch, which is the one act this exists for, changes nothing.
 */

import type { ReactNode } from "react";

/**
 * One group's panels, stacked in one grid cell. The shells (`WorkInfoTabs`,
 * `WorkSideColumn`) own the tab bar, the choice and the labels; this owns the
 * height, so both surfaces draw the one rule and cannot drift.
 */
export default function TabPanels({
	tabs,
	activeKey,
	idPrefix,
}: {
	/** The group's tabs; only `key` and `content` matter this deep. */
	tabs: { key: string; content: ReactNode }[];
	/** The chosen tab's key — every other panel lays out beneath the visible one. */
	activeKey: string;
	/** The panels' id namespace — `work-tab`/`work-side`, matching the buttons'
	 * `aria-controls` targets in the shells above. */
	idPrefix: string;
}) {
	return (
		<div className="grid">
			{tabs.map((tab) => {
				const active = tab.key === activeKey;
				return (
					<div
						key={tab.key}
						role="tabpanel"
						id={`${idPrefix}-${tab.key}`}
						aria-labelledby={`${idPrefix}-button-${tab.key}`}
						// One cell for every panel — the cell is the tallest panel, and the
						// group holds that height whichever tab is showing.
						className={`col-start-1 row-start-1 ${active ? "" : "invisible"}`}
						inert={!active}
					>
						{tab.content}
					</div>
				);
			})}
		</div>
	);
}

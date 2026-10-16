// SPDX-License-Identifier: Apache-2.0
/**
 * The Work's **Info tabs** — the tab group below the deliverable that carries the page's
 * information in groups instead of one long column (Parker, 2026-10-13): Details, Credits,
 * Access, Rating, Accessibility.
 *
 * 🚨 **The tabs are the same thing in the creator's and a user's views.** The shell owns
 * the groups and the switch; the contents arrive as finished nodes — read views in a
 * user's rendering, each an editable field in the creator's (`Editing.tsx` wraps them).
 * That is the whole mechanism that keeps the two surfaces one layout: there is no
 * creator's tab list and no user's tab list.
 *
 * The default tab for a user is Details, because that is the information about the Work a
 * visitor is likeliest to want first; the creator's editor passes the same order.
 */

import { type ReactNode, useRef, useState } from "react";
import { keepScroll } from "./scrollKeeper";

export interface InfoTab {
	key: string;
	label: string;
	content: ReactNode;
}

export default function WorkInfoTabs({
	tabs,
	activeKey: controlledActive,
	onActiveChange,
}: {
	tabs: InfoTab[];
	/** Controlled mode, when a sibling needs to open a tab — the header's *Change* rating link. */
	activeKey?: string;
	onActiveChange?: (key: string) => void;
}) {
	const [localActive, setActive] = useState(tabs[0]?.key ?? "");
	const active = controlledActive ?? localActive;
	const current = tabs.find((t) => t.key === active) ?? tabs[0];
	/** The group's root, the anchor `keepScroll` measures the page's scroller from: a tab
	 *  switch swaps panels of different heights, and the reader's place stays through it. */
	const rootRef = useRef<HTMLElement | null>(null);
	if (!current) return null;

	return (
		<section ref={rootRef} aria-label="About this Work" className="flex flex-col gap-4">
			{/* The shadow marks the bar as its own object — heavier at the bottom edge where
			    the panels hang from it (Parker's fourth pass, 2026-10-13). */}
			<div
				role="tablist"
				aria-label="Work information"
				className="join rounded-box shadow-[0_2px_6px_0_rgba(0,0,0,0.25)]"
			>
				{tabs.map((tab) => (
					<button
						key={tab.key}
						type="button"
						role="tab"
						aria-selected={tab.key === current.key}
						aria-controls={`work-tab-${tab.key}`}
						id={`work-tab-button-${tab.key}`}
						className={`btn btn-xs sm:btn-sm join-item flex-1 ${tab.key === current.key ? "btn-active" : ""}`}
						onClick={() =>
							keepScroll(rootRef.current, () => {
								setActive(tab.key);
								onActiveChange?.(tab.key);
							})
						}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id={`work-tab-${current.key}`}
				aria-labelledby={`work-tab-button-${current.key}`}
			>
				{current.content}
			</div>
		</section>
	);
}

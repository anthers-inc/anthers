// SPDX-License-Identifier: Apache-2.0
/**
 * The Work's **Info tabs** — the tab group below the deliverable that carries the page's
 * information in groups instead of one long column (Parker, 2026-10-13): Details, Credits,
 * Ratings, Accessibility.
 *
 * 🚨 **The tabs are the same thing in the creator's and a user's views.** The shell owns
 * the groups and the switch; the contents arrive as finished nodes — read views in a
 * user's rendering, each section's read-or-edit body in the creator's (`Editing.tsx`'s
 * `useSectionEdit`). That is the whole mechanism that keeps the two surfaces one layout:
 * there is no creator's tab list and no user's tab list.
 *
 * The default tab for a user is Details, because that is the information about the Work a
 * visitor is likeliest to want first; the creator's editor passes the same order.
 *
 * ⭐ **A switch changes nothing about the page's height** (Parker, 2026-10-17): the
 * panels ride `TabPanels`, which holds the group at its tallest panel's height — the
 * scroll keeper has no part here, because a switch is not a change the page can move
 * on. What still moves the page is a panel's own content (a field opening for edit),
 * and `Editing.tsx`'s keeper covers that.
 */

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import TabPanels from "./TabPanels";

export interface InfoTab {
	key: string;
	label: string;
	content: ReactNode;
	/**
	 * The section's edit action, pinned to the panel's top-right corner — the pencil in
	 * the read state and the save/cancel pair in the edit state (Parker, 2026-11-07).
	 * The caller owns the node, so the same object keeps one place across the switch.
	 */
	action?: ReactNode;
	/**
	 * What release still needs from this tab, when it needs something — rendered as the
	 * warning triangle beside the label and carried as the button's tooltip. The caller
	 * derives it from the same predicate as the release refusal, never a second rule.
	 */
	warning?: string;
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
	if (!current) return null;

	return (
		// The `gap-6` under the tab bar (Parker, 2026-10-16): the panel's first heading
		// kept sitting too close to the bar, and the extra air reads the bar as its object.
		<section aria-label="About this Work" className="flex flex-col gap-6">
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
						title={tab.warning}
						onClick={() => {
							setActive(tab.key);
							onActiveChange?.(tab.key);
						}}
					>
						<span className="inline-flex items-center gap-1">
							{tab.label}
							{tab.warning && (
								<>
									<ExclamationTriangleIcon aria-hidden="true" className="size-3.5 text-warning" />
									<span className="sr-only">Warning: {tab.warning}</span>
								</>
							)}
						</span>
					</button>
				))}
			</div>
			<TabPanels
				tabs={tabs.map((tab) => ({
					key: tab.key,
					content: (
						// The section action is pinned to the panel's top-right rather than
						// laid in the flow, so the read pencil and the edit pair keep one
						// anchor while the content below changes shape (Parker, 2026-11-07).
						<div className="relative">
							{tab.action && <div className="absolute right-0 top-0 z-20">{tab.action}</div>}
							<div className={tab.action ? "pr-12" : ""}>{tab.content}</div>
						</div>
					),
				}))}
				activeKey={current.key}
				idPrefix="work-tab"
			/>
		</section>
	);
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The Work's media manager — the same media card, swapped from the medium to its
 * management surface (Parker, 2026-10-23).
 *
 * ⭐ **The card keeps its dimensions.** The manager is a mode of the media area, not a
 * panel that grows the page: the byline and the tabs below stay exactly where they were,
 * and Done returns the medium. Inside the card, a sticky header and a row of section tabs
 * keep the full width usable at the 16:9 profile; the section body scrolls in the stage.
 *
 * The caller owns the tabs and every control inside them — media status, sets, builds,
 * the thumbnail, delivery and versions all already exist on the page. This component owns
 * only the frame and the mode switch, so it cannot drift from the sections it presents.
 */

import type { ReactNode } from "react";
import WorkMediaFrame from "./WorkMediaFrame";

export interface MediaManagerTab {
	key: string;
	label: string;
	content: ReactNode;
}

export default function WorkMediaManager({
	tabs,
	active,
	onActive,
	onDone,
}: {
	tabs: MediaManagerTab[];
	active: string;
	onActive: (key: string) => void;
	onDone: () => void;
}) {
	const current = tabs.find((tab) => tab.key === active) ?? tabs[0];
	if (!current) return null;
	return (
		<WorkMediaFrame>
			<div className="flex min-h-full flex-col gap-3">
				<div className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-3 bg-base-200/95 px-1 pb-2 backdrop-blur">
					<h2 className="text-sm font-semibold">Media Management</h2>
					<button type="button" className="btn btn-ghost btn-xs" onClick={onDone}>
						Done
					</button>
				</div>
				<div
					role="tablist"
					aria-label="Media management sections"
					className="flex flex-wrap gap-1 border-b border-base-300 pb-2"
				>
					{tabs.map((tab) => (
						<button
							key={tab.key}
							type="button"
							role="tab"
							aria-selected={tab.key === current.key}
							className={`btn btn-xs ${tab.key === current.key ? "btn-primary" : "btn-ghost"}`}
							onClick={() => onActive(tab.key)}
						>
							{tab.label}
						</button>
					))}
				</div>
				<div role="tabpanel" className="min-h-0">
					{current.content}
				</div>
			</div>
		</WorkMediaFrame>
	);
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The one page header the three user tabs share (Parker, 2026-10-19): the tab's icon,
 * its title, and a one-paragraph subtitle beneath it.
 *
 * The Feed's heading was the model; the Library carried its own `h1` and paragraph and
 * Discovery had no heading at all, so the three drifted in size, weight and wording.
 * One component is what keeps them from drifting again — a tab changes its copy, never
 * its header shape.
 *
 * The subtitle is the tab's promise, so it is real prose rather than a label: Network
 * says what the stream is made of, Library says what is kept, and Discovery says how
 * its formula works. `actions` is where a tab's own control rides at the right edge,
 * which is how Network keeps its "How does the feed work?" affordance.
 */

import type { ComponentType } from "react";

export default function TabHeader({
	icon: Icon,
	title,
	subtitle,
	actions,
}: {
	/** The tab's nav icon, so the header and the sidebar use one symbol. */
	icon: ComponentType<{ className?: string }>;
	title: string;
	subtitle: string;
	/** A tab-specific control at the right edge, aligned with the title. */
	actions?: React.ReactNode;
}) {
	return (
		<div className="mb-6 flex items-start justify-between gap-4">
			<div className="min-w-0">
				<h1 className="flex items-center gap-2 text-lg font-semibold">
					<Icon className="h-5 w-5 shrink-0 text-primary" />
					{title}
				</h1>
				<p className="mt-1 max-w-3xl text-sm leading-relaxed text-base-content/60">{subtitle}</p>
			</div>
			{actions}
		</div>
	);
}

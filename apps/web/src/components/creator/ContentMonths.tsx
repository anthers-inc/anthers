// SPDX-License-Identifier: Apache-2.0
//
// A content listing split into the months it came out in — the creator profile's
// All Content, Posts and per-medium tabs. The grouping itself, including the rule that
// an empty month gains no heading and a stretch of empty months becomes one spacer,
// lives in `../../lib/month-sections`; this file draws what that returns.
//
// The heading is the month, the rule beside it separates one month from the next, and
// a vertical ellipsis stands where a run of months had nothing. The spacer is a
// `separator` with the skipped span in its accessible name, so a reader who never sees
// the glyph is still told that the creator went quiet rather than that the timeline
// jumped.

import { EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { monthSections } from "../../lib/month-sections";

export default function ContentMonths<T>({
	items,
	dateOf,
	renderItem,
}: {
	items: readonly T[];
	dateOf: (item: T) => string;
	renderItem: (item: T) => ReactNode;
}) {
	const sections = monthSections(items, dateOf);

	return (
		<>
			{sections.map((section) => {
				if (section.kind === "gap") {
					return (
						<div
							key={section.key}
							data-testid="content-month-gap"
							className="flex items-center justify-center py-5 text-base-content/30"
						>
							<EllipsisVerticalIcon className="h-6 w-6" aria-hidden="true" />
							<span className="sr-only">{section.label}</span>
						</div>
					);
				}

				const headingId = `content-month-${section.key}`;
				return (
					<section
						key={section.key}
						aria-labelledby={headingId}
						data-testid="content-month"
						className="mb-8 last:mb-0"
					>
						<div className="mb-4 flex items-center gap-4">
							<h2
								id={headingId}
								data-testid="content-month-heading"
								className="text-sm font-semibold tracking-wide text-base-content/70"
							>
								{section.label}
							</h2>
							<span
								aria-hidden="true"
								data-testid="content-month-rule"
								className="h-px flex-1 bg-base-content/15"
							/>
						</div>
						<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
							{section.items.map(renderItem)}
						</div>
					</section>
				);
			})}
		</>
	);
}

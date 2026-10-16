// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's Posts page's sidebar filters — SEARCH over the title and tags, and STATUS
 * (published, scheduled, draft) — registered below the Studio nav by the page that binds
 * them. The Studio listing tables' sections' twin (`works-filters.tsx`,
 * `projects-filters.tsx`), with this page's own vocabulary: a post has no access ladder
 * and no media to type — it announces, and its states are the three the lifecycle has.
 */

import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { filterBtnClass, sectionTitleClass } from "./studio-filter-classes";

const STATUSES = [
	{ id: "", label: "All" },
	{ id: "published", label: "Published" },
	{ id: "scheduled", label: "Scheduled" },
	{ id: "draft", label: "Drafts" },
] as const;

export default function PostsFilterSections({
	q,
	status,
	onUpdateParams,
}: {
	/** The title/tags substring the search filters to; empty means everything. */
	q: string;
	/** "published" | "scheduled" | "draft", or "" for any. */
	status: string;
	onUpdateParams: (updates: Record<string, string>) => void;
}) {
	return (
		<div className="flex flex-col gap-5">
			<section>
				<h3 className={sectionTitleClass}>Search</h3>
				<label className="input input-bordered input-xs flex items-center gap-1.5 w-full">
					<MagnifyingGlassIcon className="w-3 h-3 text-base-content/40" />
					<input
						type="text"
						className="grow min-w-0 bg-transparent text-xs outline-none"
						placeholder="Filter by title or tag…"
						// The accessible name, spelled out: the surrounding label carries no text
						// (only an icon), and a placeholder is a hint, not a name.
						aria-label="Filter posts by title or tag"
						value={q}
						onChange={(e) => onUpdateParams({ q: e.target.value })}
					/>
				</label>
			</section>

			{/* STATUS — the three states a post moves through. A segmented control fits
			    here the way the Projects page's does not for four words: at a 16rem sidebar
			    "Scheduled" clips a four-way joined row, and a clipped control is not a
			    control — so vertical, like the Works table's Visibility. */}
			<section>
				<h3 className={sectionTitleClass}>Status</h3>
				<div className="flex flex-col gap-0.5">
					{STATUSES.map((mode) => (
						<button
							key={mode.id}
							type="button"
							className={filterBtnClass(status === mode.id)}
							onClick={() => onUpdateParams({ status: mode.id })}
						>
							{mode.label}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

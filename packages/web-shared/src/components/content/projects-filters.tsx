// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's Projects page's sidebar filters — SEARCH over the title and description,
 * STATUS (published or draft), and WORK TYPE matching any Work the project holds. The
 * Works table's sections' twin (`works-filters.tsx`), with this page's vocabulary: a
 * Project has no visibility ladder of its own (a project publishes or is a draft — the
 * Works inside it carry the gates), and its type filter describes what it contains, the
 * same rule the public listing's `media_type` filter keys on.
 */

import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import type { Project } from "../../lib/types";
import { filterBtnClass, sectionTitleClass } from "./studio-filter-classes";
import { LIBRARY_TYPE_OPTIONS, TypeIcon, typeLabel } from "./works";

const STATUSES = [
	{ id: "", label: "All" },
	{ id: "published", label: "Published" },
	{ id: "draft", label: "Draft" },
] as const;

export default function ProjectsFilterSections({
	items,
	q,
	status,
	contentType,
	onUpdateParams,
}: {
	/** The creator's whole loaded list — read only to know which kinds are present. */
	items: Project[];
	/** The title/description substring the search filters to; empty means everything. */
	q: string;
	/** "published" | "draft", or "" for any. */
	status: string;
	/** One of the Work kinds matching any Work the project holds, or "" for all. */
	contentType: string;
	onUpdateParams: (updates: Record<string, string>) => void;
}) {
	// The kinds present across every project's works, in the Studio's type order — the
	// same vocabulary the Works table's sections offer, computed over the members.
	const kinds = useMemo(() => {
		const present = new Set(items.flatMap((p) => (p.worksSummary ?? []).map((w) => w.type)));
		return LIBRARY_TYPE_OPTIONS.filter((o) => present.has(o.value)).map((o) => o.value);
	}, [items]);

	return (
		<div className="flex flex-col gap-5">
			<section>
				<h3 className={sectionTitleClass}>Search</h3>
				<label className="input input-bordered input-xs flex items-center gap-1.5 w-full">
					<MagnifyingGlassIcon className="w-3 h-3 text-base-content/40" />
					<input
						type="text"
						className="grow min-w-0 bg-transparent text-xs outline-none"
						placeholder="Filter by title or description…"
						// The accessible name, spelled out: the surrounding label carries no text
						// (only an icon), and a placeholder is a hint, not a name.
						aria-label="Filter projects by title or description"
						value={q}
						onChange={(e) => onUpdateParams({ q: e.target.value })}
					/>
				</label>
			</section>

			<section>
				<h3 className={sectionTitleClass}>Status</h3>
				<div className="flex rounded-lg bg-base-300/50 p-0.5">
					{STATUSES.map((mode) => (
						<button
							key={mode.id}
							type="button"
							className={`flex-1 text-xs py-1.5 rounded-md transition-colors font-medium ${
								status === mode.id
									? "bg-base-100 text-base-content shadow-sm"
									: "text-base-content/50 hover:text-base-content/70"
							}`}
							onClick={() => onUpdateParams({ status: mode.id })}
						>
							{mode.label}
						</button>
					))}
				</div>
			</section>

			{/* WORK TYPE — the kinds these projects hold. A project matches on ANY work in
			    it, the rule its own public listing filters by. */}
			<section>
				<h3 className={sectionTitleClass}>Work Type</h3>
				<div className="flex flex-col gap-0.5">
					<button
						type="button"
						className={filterBtnClass(contentType === "")}
						onClick={() => onUpdateParams({ type: "" })}
					>
						All
					</button>
					{kinds.map((type) => (
						<button
							key={type}
							type="button"
							className={filterBtnClass(contentType === type)}
							onClick={() => onUpdateParams({ type })}
						>
							<TypeIcon type={type} className="w-5 h-5 shrink-0" />
							{typeLabel(type)}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

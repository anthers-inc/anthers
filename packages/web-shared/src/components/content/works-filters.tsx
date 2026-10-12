// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's Works page's sidebar filters — SEARCH over the title and description,
 * VISIBILITY (what the creator set: released, private, withdrawn), and WORK TYPE —
 * registered below the Studio nav by the page that binds them.
 *
 * The layout's shape follows the signed-in feed's sidebar (`FeedFilterSections`, an
 * apps/web component this package cannot import — the dependency runs the other way), with
 * this page's own filter vocabulary in place of the feed's access ladder. Everything here
 * is a client-side filter over the creator's own list: the Studio loads the whole Catalog,
 * so nothing here can fail to land in a server query.
 */

import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import type { Work } from "../../lib/types";
import { LIBRARY_TYPE_OPTIONS, TypeIcon, typeLabel } from "./works";

/** The distinct kinds actually present in a list, in the Studio's own type order. */
export function presentWorkTypes(items: Work[]): string[] {
	const present = new Set(items.map((item) => item.type));
	return LIBRARY_TYPE_OPTIONS.filter((o) => present.has(o.value)).map((o) => o.value);
}

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

const filterBtnClass = (isActive: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full ${
		isActive
			? "bg-secondary/10 text-secondary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;

export default function WorksFilterSections({
	items,
	q,
	visibility,
	contentType,
	onUpdateParams,
}: {
	/** The creator's whole loaded list — read only to know which kinds are present. */
	items: Work[];
	/** The title/description substring the search filters to; empty means everything. */
	q: string;
	/** One of `WorkVisibility`, or "" for any. */
	visibility: string;
	/** One of the Work kinds (`work.type`), or "" for all. */
	contentType: string;
	onUpdateParams: (updates: Record<string, string>) => void;
}) {
	const types = useMemo(() => presentWorkTypes(items), [items]);

	const VISIBILITIES = [
		{ id: "", label: "Any" },
		{ id: "released", label: "Released" },
		{ id: "private", label: "Private" },
		{ id: "withdrawn", label: "Withdrawn" },
	] as const;

	return (
		<>
			{/* SEARCH — the video-platform filter box, living here with the rest. */}
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
						aria-label="Filter by title or description"
						value={q}
						onChange={(e) => onUpdateParams({ q: e.target.value })}
					/>
				</label>
			</section>

			{/* VISIBILITY — what the creator did, not the access ladder beneath it. Vertical,
			    like the type list below: the four words did not fit one joined row in a
			    16rem sidebar, and a clipped control is not a control. */}
			<section>
				<h3 className={sectionTitleClass}>Visibility</h3>
				<div className="flex flex-col gap-0.5">
					{VISIBILITIES.map((mode) => (
						<button
							key={mode.id}
							type="button"
							className={filterBtnClass(visibility === mode.id)}
							onClick={() => onUpdateParams({ visibility: mode.id })}
						>
							{mode.label}
						</button>
					))}
				</div>
				<p className="text-[11px] text-base-content/40 mt-2 leading-snug">
					Released means it is in your public Catalog, however its access gates it. Private means
					only you can see it. Withdrawn means it left circulation, and everything it sold keeps
					working.
				</p>
			</section>

			{/* WORK TYPE — the kinds this Catalog holds, in the Studio's own type order. */}
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
					{types.map((type) => (
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
		</>
	);
}

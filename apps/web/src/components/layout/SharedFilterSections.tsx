// SPDX-License-Identifier: Apache-2.0
/**
 * The TAB-SHARED sidebar filter sections — TYPE and TAGS — the lower section of the
 * house sidebar structure on every user-mode tab (Parker, 2026-10-11): Network, Library
 * and Discovery all render these behind the sidebar's second divider, each page
 * supplying its own params, so this component binds to nothing.
 *
 * A page decides what a type SELECTION does through its adapter: on the Network the
 * Work types land in `media_type` and "posts" maps to the feed route's `kind=posts` (a
 * post is a kind of feed entry, not a Work type — the URL carries the selection inside
 * `media_type` and the page translates). The Library and Discovery adapters are their
 * own pages.
 *
 * 🚨 The list is the UNIFIED vocabulary — All, then Posts, then every Work type —
 * rendered on every tab, GRAYED where that tab or its active view cannot select it
 * (`unavailableTypes`), never dropped. A grayed-where-empty list keeps the vocabulary
 * stable between tabs, which is what a shared section is: "Images" appearing only
 * where something is an image and vanishing elsewhere would read as the sidebar
 * reshuffling its words under you.
 *
 * An `access` prop — the tab's Access filter, supplied where the content carries
 * access state — renders the Access section FIRST among the shared filters (Parker,
 * 2026-10-11: the Library now holds locked saves, which is what earned the row there).
 * Discovery supplies it too: its stream is the whole site's newest Works and Posts, so
 * every card carries an access verdict.
 *
 * The Tags section is the Network's shape, carried over unchanged: the tags the user
 * filtered on are the only ones that render, and a search names candidates over the
 * curated corpus. The vocabularies themselves live in `content-vocabulary.ts`, which
 * outlived Browse's retired filter machinery.
 */

import {
	CubeTransparentIcon,
	MagnifyingGlassIcon,
	NewspaperIcon,
	TagIcon,
} from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import AccessFilterSection from "./AccessFilterSection";
import { CONTENT_TYPES, TAGS_BY_TYPE } from "./content-vocabulary";
import { sidebarRowClass } from "./sidebar-row-class";

/**
 * The unified type vocabulary every tab's sidebar shows. `CONTENT_TYPES`' All stays
 * first — "All" means everything the tab holds, posts included where posts exist —
 * and Posts follows it. ids outside the Work types (`posts`) are page words: each
 * page's adapter is the only thing that may read them.
 */
export const SHARED_FILTER_TYPES = [
	{ id: "", label: "All", icon: CubeTransparentIcon },
	{ id: "posts", label: "Posts", icon: NewspaperIcon },
	...CONTENT_TYPES.slice(1),
] as const;

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

export default function SharedFilterSections({
	type,
	onType,
	unavailableTypes,
	tags,
	onTags,
	access,
}: {
	/** The selected type id — "" is All, "posts" the Posts kind, the rest are Work types. */
	type: string;
	onType: (id: string) => void;
	/**
	 * Types the current page or its active view cannot reach: rendered GRAYED rather
	 * than dropped (Parker, 2026-10-11) — a Work type absent from a Library, or already
	 * excluded by the selected lens, keeps its row, unselectable. Absent, every row selects.
	 */
	unavailableTypes?: ReadonlySet<string>;
	/** The selected tags as the comma list the shared shape carries (AND semantics on the feed). */
	tags: string;
	onTags: (tags: string) => void;
	/** This tab's Access filter, supplied where the content carries access state — renders FIRST (see the docblock). */
	access?: { value: string; onAccess: (access: string) => void };
}) {
	const selected = useMemo(
		() =>
			tags
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
		[tags],
	);
	// One curated vocabulary, sorted so a search's suggestions scan alphabetically
	// rather than in the per-type chip order the old bar showed.
	const corpus = useMemo(() => [...new Set(Object.values(TAGS_BY_TYPE).flat())].sort(), []);
	const [query, setQuery] = useState("");
	const trimmed = query.trim().toLowerCase();
	const matches = trimmed
		? corpus.filter((t) => t.includes(trimmed) && !selected.includes(t)).slice(0, 8)
		: [];

	const addTag = (t: string) => onTags([...selected, t].join(","));
	const removeTag = (t: string) => onTags(selected.filter((s) => s !== t).join(","));

	return (
		<div className="flex flex-col gap-5">
			{/* ACCESS — first among the shared filters, where the tab consumes access. */}
			{access?.value != null && (
				<AccessFilterSection access={access.value} onAccess={access.onAccess} />
			)}

			{/*
			 * TYPE — the unified list. Grayed rows keep their place: they are the
			 * vocabulary, not the supply. (Was the "Work Type" heading; Parker
			 * shortened it when this became the shared section, 2026-10-11.)
			 */}
			<section>
				<h3 className={sectionTitleClass}>Type</h3>
				<div className="flex flex-col gap-0.5">
					{SHARED_FILTER_TYPES.map((typeItem) => {
						const grayed = unavailableTypes?.has(typeItem.id) ?? false;
						return (
							<button
								key={typeItem.id}
								type="button"
								disabled={grayed}
								aria-disabled={grayed || undefined}
								className={`${sidebarRowClass(type === typeItem.id)} ${grayed ? "opacity-40 pointer-events-none" : ""}`}
								onClick={() => onType(typeItem.id)}
							>
								<typeItem.icon className="w-5 h-5 shrink-0" />
								{typeItem.label}
							</button>
						);
					})}
				</div>
			</section>

			{/* TAGS — the filtered ones render; a search names candidates. */}
			<section>
				<h3 className={sectionTitleClass}>
					<TagIcon className="w-3.5 h-3.5" />
					Tags
				</h3>
				{selected.length > 0 && (
					<div className="flex flex-wrap gap-1.5 mb-2">
						{selected.map((t) => (
							<button
								key={t}
								type="button"
								aria-label={`Remove tag ${t}`}
								className="badge badge-sm badge-secondary gap-1 cursor-pointer"
								onClick={() => removeTag(t)}
							>
								{t} &times;
							</button>
						))}
					</div>
				)}
				<label className="input input-bordered input-xs flex items-center gap-1.5 w-full">
					<MagnifyingGlassIcon className="w-3 h-3 text-base-content/40" />
					<input
						type="text"
						className="grow min-w-0 bg-transparent text-xs outline-none"
						placeholder="Search tags…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						// Enter on a typed token that names no suggestion adds it anyway — a
						// tag nobody curated yet is still a tag a creator may have used.
						onKeyDown={(e) => {
							if (e.key === "Enter" && trimmed && !selected.includes(query.trim())) {
								addTag(query.trim());
								setQuery("");
							}
						}}
					/>
				</label>
				{matches.length > 0 && (
					<div className="flex flex-wrap gap-1.5 mt-2">
						{matches.map((t) => (
							<button
								key={t}
								type="button"
								className="badge badge-sm badge-ghost hover:badge-outline cursor-pointer"
								onClick={() => {
									addTag(t);
									setQuery("");
								}}
							>
								{t}
							</button>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

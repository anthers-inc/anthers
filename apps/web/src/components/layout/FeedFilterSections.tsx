// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in feed page's sidebar filters — ACCESS over WORK TYPE, and a tag
 * search-and-multiselect in place of a wall of chips.
 *
 * Deliberately its own component rather than a mode of `ContentFilterSections`:
 * Discover's sidebar binds its filters to the projects listing and keeps the
 * price-range and per-type machinery that works there. The feed's filters bind to
 * `/api/accounts/me/feed`, whose params are exactly these three, so the sections
 * present exactly these three and nothing that cannot land in the query.
 *
 * The tag section's shape is the brief's: the tags the user has actually filtered on
 * are the only ones that render; suggestions appear while the search names a
 * candidate, drawn over the same curated vocabulary the chips used to show. A real
 * tag index (the tags people actually used) can replace the corpus without touching
 * this layout — the corpus is data, not structure.
 */

import { MagnifyingGlassIcon, TagIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { CONTENT_TYPES, TAGS_BY_TYPE } from "./ContentFilterSections";

const ACCESS_MODES = [
	{ id: "", label: "Any" },
	{ id: "unlocked", label: "Unlocked" },
	{ id: "locked", label: "Locked" },
] as const;

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

const filterBtnClass = (isActive: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full ${
		isActive
			? "bg-secondary/10 text-secondary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;

export default function FeedFilterSections({
	access,
	contentType,
	tags,
	onUpdateParams,
}: {
	access: string;
	contentType: string;
	/** The selected tags as the comma list the URL and the API both carry. */
	tags: string;
	onUpdateParams: (updates: Record<string, string>) => void;
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

	const addTag = (t: string) => onUpdateParams({ tags: [...selected, t].join(",") });
	const removeTag = (t: string) =>
		onUpdateParams({ tags: selected.filter((s) => s !== t).join(",") });

	return (
		<>
			{/* ACCESS — the viewer's own reach over the deliverable, above the kind. */}
			<section>
				<h3 className={sectionTitleClass}>Access</h3>
				<div className="flex rounded-lg bg-base-300/50 p-0.5">
					{ACCESS_MODES.map((mode) => (
						<button
							key={mode.id}
							type="button"
							className={`flex-1 text-xs py-1.5 rounded-md transition-colors font-medium ${
								access === mode.id
									? "bg-base-100 text-base-content shadow-sm"
									: "text-base-content/50 hover:text-base-content/70"
							}`}
							onClick={() => onUpdateParams({ access: mode.id })}
						>
							{mode.label}
						</button>
					))}
				</div>
				<p className="text-[11px] text-base-content/40 mt-2 leading-snug">
					Unlocked means you can open it: public access, or the purchase or Badge that ungates it is
					already yours. Locked means you cannot open it yet.
				</p>
			</section>

			{/* WORK TYPE (was Content Type) */}
			<section>
				<h3 className={sectionTitleClass}>Work Type</h3>
				<div className="flex flex-col gap-0.5">
					{CONTENT_TYPES.map((type) => (
						<button
							key={type.id}
							type="button"
							className={filterBtnClass(contentType === type.id)}
							onClick={() => onUpdateParams({ media_type: type.id })}
						>
							<type.icon className="w-5 h-5 shrink-0" />
							{type.label}
						</button>
					))}
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
		</>
	);
}

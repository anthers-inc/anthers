// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's tags, in the Details tab below its description.
 *
 * The read view is the same chips a visitor sees. The edit view is the creator's: up to
 * five tags, picked from the **directory of tags released Works actually carry**, each
 * shown with how many Works use it, or typed as a new one when the specific word a
 * creator wants does not exist yet.
 *
 * ⭐ **The count is the decision aid.** A creator choosing between `rpg` and
 * `cozy-farming-rpg` needs to see that one has a hundred Works behind it and the other
 * none — that is the difference between joining a vocabulary and starting one, and it is
 * invisible if the list offers only words. The server's directory route is the source;
 * this component never invents a count.
 *
 * ⚠️ **The client refuses past the cap too, but the API is the authority** — the server
 * normalizes and enforces the same five, so a second client or a stale page cannot save a
 * sixth.
 */

import { MAX_WORK_TAGS, normalizeTag, tagProblem } from "@anthers/shared/tags";
import { client } from "@anthers/web-shared/rpc";
import type { TagCount } from "@anthers/web-shared/types";
import { MagnifyingGlassIcon, PlusIcon, TagIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";

/** How many suggestions a non-searching picker asks for. */
const DIRECTORY_LIMIT = "20";

/** The chips a reader sees, with an empty state the creator's read view can name. */
export function WorkTagChips({ tags, empty = "No tags yet." }: { tags: string[]; empty?: string }) {
	if (tags.length === 0) {
		return <p className="text-sm text-base-content/40">{empty}</p>;
	}
	return (
		<div className="flex flex-wrap gap-1.5">
			{tags.map((tag) => (
				<span key={tag} className="badge badge-sm badge-ghost gap-1">
					<TagIcon className="size-3 text-base-content/40" />
					{tag}
				</span>
			))}
		</div>
	);
}

/** `1 work` / `3 works`, the label beside each suggestion. */
function worksLabel(n: number): string {
	return `${n} ${n === 1 ? "work" : "works"}`;
}

/**
 * The suggestion list, refreshed as the creator types. The empty query asks for the most
 * used tags; a query asks for matches and is debounced so a fast typist does not fire a
 * request per keystroke.
 */
function useTagDirectory(query: string): { tags: TagCount[] | null; failed: boolean } {
	const [tags, setTags] = useState<TagCount[] | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let live = true;
		const timer = setTimeout(
			() => {
				void (async () => {
					try {
						const res = await client.api.content.tags.$get({
							query: { q: query, limit: DIRECTORY_LIMIT },
						});
						if (!res.ok) throw new Error("The tag list did not load.");
						const body = (await res.json()) as { tags: TagCount[] };
						if (!live) return;
						setTags(body.tags);
						setFailed(false);
					} catch {
						if (live) setFailed(true);
					}
				})();
			},
			query ? 150 : 0,
		);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [query]);
	return { tags, failed };
}

/**
 * The working control inside the Tags `InlineField`. `selected` is the field's draft; the
 * server's response is what the read view adopts, so this component only edits the draft
 * it was handed.
 */
export function WorkTagPicker({
	selected,
	onChange,
}: {
	selected: string[];
	onChange: (tags: string[]) => void;
}) {
	const [query, setQuery] = useState("");
	const [note, setNote] = useState<string | null>(null);
	const { tags: directory, failed } = useTagDirectory(query);

	const add = (raw: string) => {
		const tag = normalizeTag(raw);
		if (!tag) return;
		if (selected.includes(tag)) {
			setQuery("");
			return;
		}
		if (selected.length >= MAX_WORK_TAGS) {
			setNote(`A Work can carry up to ${MAX_WORK_TAGS} tags.`);
			return;
		}
		const problem = tagProblem(tag);
		if (problem) return;
		onChange([...selected, tag]);
		setQuery("");
		setNote(null);
	};

	const remove = (tag: string) => {
		onChange(selected.filter((t) => t !== tag));
		setNote(null);
	};

	const trimmed = query.trim();
	const normalizedQuery = normalizeTag(trimmed);
	const shapeProblem = trimmed ? tagProblem(trimmed) : null;
	const matches = (directory ?? []).filter((entry) => !selected.includes(entry.tag));
	const exact = matches.some((entry) => entry.tag === normalizedQuery);
	const canStartNew =
		normalizedQuery !== "" && !exact && !selected.includes(normalizedQuery) && !shapeProblem;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-1.5">
				{selected.length === 0 ? (
					<p className="text-sm text-base-content/40">No tags yet.</p>
				) : (
					selected.map((tag) => (
						<button
							key={tag}
							type="button"
							aria-label={`Remove tag ${tag}`}
							className="badge badge-sm badge-secondary gap-1 cursor-pointer"
							onClick={() => remove(tag)}
						>
							{tag}
							<XMarkIcon className="size-3" />
						</button>
					))
				)}
				<span className="ml-1 text-xs text-base-content/50">
					{selected.length} of {MAX_WORK_TAGS}
				</span>
			</div>

			<label className="input input-bordered input-sm flex items-center gap-1.5 w-full">
				<MagnifyingGlassIcon className="size-3.5 text-base-content/40" />
				<input
					type="text"
					className="grow min-w-0 bg-transparent text-sm outline-none"
					placeholder="Search tags, or type a new one…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							if (trimmed) add(trimmed);
						}
					}}
				/>
			</label>
			<p className="text-xs text-base-content/50">
				Tags help people find this Work. Five at most; you can change them whenever you like.
			</p>
			{note && <p className="text-xs text-error">{note}</p>}
			{shapeProblem && <p className="text-xs text-error">{shapeProblem}</p>}

			<div className="flex flex-wrap gap-1.5">
				{failed ? (
					<p className="text-xs text-base-content/50">
						Could not load the tag list — you can still type a tag and add it.
					</p>
				) : directory === null ? (
					<p className="text-xs text-base-content/50">Loading tags…</p>
				) : (
					matches.map((entry) => (
						<button
							key={entry.tag}
							type="button"
							className="badge badge-sm badge-ghost hover:badge-outline cursor-pointer gap-1"
							onClick={() => add(entry.tag)}
						>
							{entry.tag}
							<span className="opacity-60">{worksLabel(entry.works)}</span>
						</button>
					))
				)}
				{canStartNew && (
					<button
						type="button"
						className="badge badge-sm badge-outline badge-primary cursor-pointer gap-1"
						onClick={() => add(trimmed)}
					>
						<PlusIcon className="size-3" />
						Use “{normalizedQuery}” — no Work uses it yet
					</button>
				)}
			</div>
		</div>
	);
}

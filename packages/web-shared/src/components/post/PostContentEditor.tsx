// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Content section of the post form: an ordered list of post entries, where each
 * entry is either an inline TEXT block (post-native prose) or a REFERENCE to a library
 * content item (with an optional caption). "Add text block" inserts prose; "Add content"
 * opens the library picker to attach an existing item (or upload a new one). Posts no
 * longer own media — they reference creator-owned library items.
 */
import {
	ArrowDownIcon,
	ArrowUpIcon,
	DocumentTextIcon,
	PlusIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import type { ContentItem, PostEntry, PostEntryInput } from "../../lib/types";
import ContentPicker from "../content/ContentPicker";
import { itemPreviewUrl, ProcessingBadge, TypeBadge, TypeIcon } from "../content/contentItems";
import RichTextEditor from "../editor/RichTextEditor";

/** In-form working copy of one post entry (text block or content reference). */
export interface PostEntryDraft {
	/** Stable local key for React lists (not the DB id). */
	localKey: string;
	/** DB id of the post_contents row when this entry already exists (reconcile-by-id). */
	id?: number;
	kind: "text" | "content";
	/** Text entries: the prose. */
	bodyHtml: string;
	/** Content entries: the referenced library item id + resolved item (for display). */
	contentItemId?: number;
	item: ContentItem | null;
	caption: string;
}

let counter = 0;
function nextKey(): string {
	counter += 1;
	return `entry-${Date.now()}-${counter}`;
}

/** A blank text-block draft. */
export function newTextEntry(): PostEntryDraft {
	return { localKey: nextKey(), kind: "text", bodyHtml: "", item: null, caption: "" };
}

/** A content-reference draft attached from a library item. */
export function contentEntryFromItem(item: ContentItem): PostEntryDraft {
	return {
		localKey: nextKey(),
		kind: "content",
		bodyHtml: "",
		contentItemId: item.id,
		item,
		caption: "",
	};
}

/** Hydrate a draft from a loaded post entry (edit mode). */
export function draftFromPostEntry(entry: PostEntry): PostEntryDraft {
	if (entry.kind === "text") {
		return {
			localKey: nextKey(),
			id: entry.id,
			kind: "text",
			bodyHtml: entry.bodyHtml ?? "",
			item: null,
			caption: "",
		};
	}
	return {
		localKey: nextKey(),
		id: entry.id,
		kind: "content",
		bodyHtml: "",
		contentItemId: entry.contentItem?.id,
		item: entry.contentItem,
		caption: entry.caption ?? "",
	};
}

/**
 * Serialize a draft to the API post-entry input, or null when it can't be persisted
 * (a content reference whose item was deleted upstream).
 */
export function serializePostEntry(d: PostEntryDraft): PostEntryInput | null {
	if (d.kind === "text") {
		return { kind: "text", ...(d.id != null ? { id: d.id } : {}), bodyHtml: d.bodyHtml };
	}
	if (d.contentItemId == null) return null;
	return {
		kind: "content",
		...(d.id != null ? { id: d.id } : {}),
		contentItemId: d.contentItemId,
		caption: d.caption,
	};
}

interface PostContentEditorProps {
	value: PostEntryDraft[];
	onChange: (next: PostEntryDraft[] | ((prev: PostEntryDraft[]) => PostEntryDraft[])) => void;
}

export default function PostContentEditor({ value, onChange }: PostContentEditorProps) {
	const [pickerOpen, setPickerOpen] = useState(false);

	const patch = (localKey: string, changes: Partial<PostEntryDraft>) =>
		onChange((prev) => prev.map((e) => (e.localKey === localKey ? { ...e, ...changes } : e)));

	const remove = (localKey: string) =>
		onChange((prev) => prev.filter((e) => e.localKey !== localKey));

	const move = (index: number, dir: -1 | 1) =>
		onChange((prev) => {
			const target = index + dir;
			if (target < 0 || target >= prev.length) return prev;
			const next = [...prev];
			[next[index], next[target]] = [next[target], next[index]];
			return next;
		});

	const addText = () => onChange((prev) => [...prev, newTextEntry()]);
	const attach = (item: ContentItem) => {
		onChange((prev) => [...prev, contentEntryFromItem(item)]);
		setPickerOpen(false);
	};

	return (
		<div className="flex flex-col gap-4">
			{value.length === 0 && (
				<p className="text-sm text-base-content/50">
					No content yet. Add a text block or attach content from your library.
				</p>
			)}

			{value.map((entry, index) => (
				<EntryCard
					key={entry.localKey}
					entry={entry}
					index={index}
					total={value.length}
					onPatch={patch}
					onRemove={remove}
					onMove={move}
				/>
			))}

			<div className="flex flex-wrap gap-2">
				<button type="button" className="btn btn-outline btn-sm" onClick={addText}>
					<DocumentTextIcon className="w-4 h-4" /> Add text block
				</button>
				<button
					type="button"
					className="btn btn-outline btn-sm"
					onClick={() => setPickerOpen(true)}
				>
					<PlusIcon className="w-4 h-4" /> Add content
				</button>
			</div>

			{pickerOpen && <ContentPicker onSelect={attach} onClose={() => setPickerOpen(false)} />}
		</div>
	);
}

interface EntryCardProps {
	entry: PostEntryDraft;
	index: number;
	total: number;
	onPatch: (localKey: string, changes: Partial<PostEntryDraft>) => void;
	onRemove: (localKey: string) => void;
	onMove: (index: number, dir: -1 | 1) => void;
}

function EntryCard({ entry, index, total, onPatch, onRemove, onMove }: EntryCardProps) {
	return (
		<div className="border border-base-300 rounded-lg p-4 flex flex-col gap-3 bg-base-100">
			<div className="flex items-center gap-2">
				<span className="badge badge-neutral badge-sm">{index + 1}</span>
				<span className="text-sm font-medium">
					{entry.kind === "text" ? "Text block" : "Content"}
				</span>
				<div className="flex items-center gap-1 ml-auto">
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square"
						disabled={index === 0}
						onClick={() => onMove(index, -1)}
						title="Move up"
					>
						<ArrowUpIcon className="w-4 h-4" />
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square"
						disabled={index === total - 1}
						onClick={() => onMove(index, 1)}
						title="Move down"
					>
						<ArrowDownIcon className="w-4 h-4" />
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square text-error"
						onClick={() => onRemove(entry.localKey)}
						title="Remove"
					>
						<TrashIcon className="w-4 h-4" />
					</button>
				</div>
			</div>

			{entry.kind === "text" ? (
				<RichTextEditor
					content={entry.bodyHtml}
					onChange={(html) => onPatch(entry.localKey, { bodyHtml: html })}
					placeholder="Write this section..."
				/>
			) : (
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<div className="w-24 h-16 shrink-0 rounded bg-base-200 flex items-center justify-center overflow-hidden">
							{entry.item && itemPreviewUrl(entry.item) ? (
								<img
									src={itemPreviewUrl(entry.item) ?? ""}
									alt=""
									className="w-full h-full object-cover"
								/>
							) : (
								<TypeIcon
									type={entry.item?.type ?? "image"}
									className="w-8 h-8 text-base-content/30"
								/>
							)}
						</div>
						<div className="flex-1 min-w-0">
							{entry.item ? (
								<>
									<p className="font-medium text-sm truncate">{entry.item.title || "Untitled"}</p>
									<div className="flex flex-wrap items-center gap-1 mt-1">
										<TypeBadge type={entry.item.type} />
										<ProcessingBadge item={entry.item} />
									</div>
								</>
							) : (
								<p className="text-sm text-error">This content item is no longer available.</p>
							)}
						</div>
					</div>
					<input
						type="text"
						className="input input-bordered input-sm w-full"
						value={entry.caption}
						onChange={(e) => onPatch(entry.localKey, { caption: e.target.value })}
						placeholder="Caption (optional)"
					/>
				</div>
			)}
		</div>
	);
}

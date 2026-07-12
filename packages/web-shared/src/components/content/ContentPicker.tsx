// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Attach-content picker for the post authoring editor: a modal grid of the creator's
 * library items (filterable by type), plus an "Upload new" affordance that runs the
 * full content-item create flow and attaches the result. Selecting an item returns it
 * to the caller to attach as a post content entry.
 */
import { PlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { ContentItem, LibraryContentType } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import ContentItemEditor from "./ContentItemEditor";
import {
	itemPreviewUrl,
	LIBRARY_TYPE_OPTIONS,
	ProcessingBadge,
	TypeBadge,
	TypeIcon,
} from "./contentItems";

interface ContentPickerProps {
	onSelect: (item: ContentItem) => void;
	onClose: () => void;
}

export default function ContentPicker({ onSelect, onClose }: ContentPickerProps) {
	const [items, setItems] = useState<ContentItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [typeFilter, setTypeFilter] = useState<"all" | LibraryContentType>("all");
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		client.api.content["content-items"]
			.$get({ query: { mine: "true" } })
			.then(async (res) => {
				if (!res.ok) return { items: [] as ContentItem[] };
				return (await res.json()) as unknown as { items: ContentItem[] };
			})
			.then((data) => setItems(data.items))
			.catch(() => setItems([]))
			.finally(() => setLoading(false));
	}, []);

	const filtered = typeFilter === "all" ? items : items.filter((i) => i.type === typeFilter);

	if (creating) {
		// A freshly created item is attached immediately.
		return <ContentItemEditor onSaved={onSelect} onClose={() => setCreating(false)} />;
	}

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box max-w-3xl max-h-[90vh] flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">Attach content</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<select
						className="select select-bordered select-sm"
						value={typeFilter}
						onChange={(e) => setTypeFilter(e.target.value as "all" | LibraryContentType)}
					>
						<option value="all">All types</option>
						{LIBRARY_TYPE_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className="btn btn-primary btn-sm ml-auto"
						onClick={() => setCreating(true)}
					>
						<PlusIcon className="w-4 h-4" /> Upload new
					</button>
				</div>

				<div className="overflow-y-auto pr-1">
					{loading ? (
						<div className="flex justify-center py-12">
							<LoadingSpinner size="lg" />
						</div>
					) : filtered.length === 0 ? (
						<p className="text-sm text-base-content/50 text-center py-12">
							{items.length === 0
								? "Your library is empty. Upload new content to attach it."
								: "No items of this type. Try another filter or upload new content."}
						</p>
					) : (
						<div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
							{filtered.map((item) => (
								<button
									type="button"
									key={item.id}
									onClick={() => onSelect(item)}
									className="text-left card bg-base-100 border border-base-300 hover:border-primary overflow-hidden"
								>
									<div className="aspect-video bg-base-200 flex items-center justify-center overflow-hidden">
										{itemPreviewUrl(item) ? (
											<img
												src={itemPreviewUrl(item) ?? ""}
												alt={item.title ?? ""}
												className="w-full h-full object-cover"
											/>
										) : (
											<TypeIcon type={item.type} className="w-10 h-10 text-base-content/30" />
										)}
									</div>
									<div className="p-2 gap-1 flex flex-col">
										<span className="text-sm font-medium truncate" title={item.title ?? undefined}>
											{item.title || "Untitled"}
										</span>
										<div className="flex flex-wrap items-center gap-1">
											<TypeBadge type={item.type} />
											<ProcessingBadge item={item} />
										</div>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}

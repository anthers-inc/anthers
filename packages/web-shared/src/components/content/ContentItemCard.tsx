// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One library content item as a card: thumbnail (or type icon), title, a type badge,
 * a derived processing-state badge, and Edit / Delete controls.
 */
import { PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { ContentItem } from "../../lib/types";
import { itemPreviewUrl, ProcessingBadge, TypeBadge, TypeIcon } from "./contentItems";

interface ContentItemCardProps {
	item: ContentItem;
	onEdit: (item: ContentItem) => void;
	onDelete: (item: ContentItem) => void;
}

export default function ContentItemCard({ item, onEdit, onDelete }: ContentItemCardProps) {
	const preview = itemPreviewUrl(item);
	return (
		<div className="card bg-base-100 border border-base-300 overflow-hidden">
			<div className="aspect-video bg-base-200 flex items-center justify-center overflow-hidden">
				{preview ? (
					<img src={preview} alt={item.title ?? ""} className="w-full h-full object-cover" />
				) : (
					<TypeIcon type={item.type} className="w-12 h-12 text-base-content/30" />
				)}
			</div>
			<div className="card-body p-4 gap-2">
				<h3 className="font-semibold text-sm truncate" title={item.title ?? undefined}>
					{item.title || "Untitled"}
				</h3>
				<div className="flex flex-wrap items-center gap-1">
					<TypeBadge type={item.type} />
					<ProcessingBadge item={item} />
				</div>
				<div className="flex justify-end gap-1 mt-1">
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						onClick={() => onEdit(item)}
						title="Edit"
					>
						<PencilSquareIcon className="w-4 h-4" />
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-xs text-error"
						onClick={() => onDelete(item)}
						title="Delete"
					>
						<TrashIcon className="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	);
}

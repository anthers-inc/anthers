// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One Work in the creator's Catalog as a card: thumbnail (or type icon), title, a type
 * badge, the derived processing and access badges, and Release / Edit / Delete controls.
 *
 * Release is on the card rather than only inside the editor because the common case is
 * uploading a back catalog — a creator releasing thirty Works should not open thirty
 * modals. The editor still owns the *shape* of a release (access, dates, delivery); this
 * is the switch once that shape is right.
 */
import { EyeIcon, EyeSlashIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { Work } from "../../lib/types";
import {
	AccessBadge,
	accessState,
	itemPreviewUrl,
	ProcessingBadge,
	TypeBadge,
	TypeIcon,
} from "./works";

interface ContentItemCardProps {
	item: Work;
	onEdit: (item: Work) => void;
	onDelete: (item: Work) => void;
	/** Flip visibility. Absent → the control is not rendered. */
	onSetVisibility?: (item: Work, visibility: "private" | "released") => void;
	/** True while this card's own visibility change is in flight. */
	busy?: boolean;
}

export default function WorkCard({
	item,
	onEdit,
	onDelete,
	onSetVisibility,
	busy,
}: ContentItemCardProps) {
	const preview = itemPreviewUrl(item);
	const released = item.visibility === "released";
	const state = accessState(item);

	// The server refuses to release a Work whose media is still encoding, and refuses one
	// with no delivery switch on. Disable rather than let the click earn an error.
	const processing =
		item.transcoding?.status === "pending" || item.transcoding?.status === "processing";
	const noDelivery = !item.streamEnabled && !item.downloadEnabled;
	const blocked = !released && (processing || noDelivery);
	const blockedWhy = processing
		? "Still processing — it can be released once the media is ready"
		: "Turn on streaming or downloads before releasing";

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
					<AccessBadge item={item} />
					<ProcessingBadge item={item} />
				</div>
				{state === "locked" && (
					<p className="text-xs text-error">
						Released, but no one can open it — set access on this Work.
					</p>
				)}
				<div className="flex justify-end gap-1 mt-1">
					{onSetVisibility && (
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => onSetVisibility(item, released ? "private" : "released")}
							disabled={busy || blocked}
							title={blocked ? blockedWhy : released ? "Make private" : "Release"}
						>
							{released ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
							{released ? "Unrelease" : "Release"}
						</button>
					)}
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

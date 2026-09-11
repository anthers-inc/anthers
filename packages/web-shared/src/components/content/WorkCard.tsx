// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One Work in the creator's Catalog as a card: thumbnail (or type icon), title, a type
 * badge, the derived processing and access badges, and Release / Edit / Delete controls.
 *
 * Release is on the card rather than only on the Work's page because the common case is
 * uploading a back catalog — a creator releasing thirty Works should not open thirty
 * pages. The page still owns the *shape* of a release (access, dates, delivery, rating);
 * this is the switch once that shape is right.
 *
 * ⭐ **The two blocked-release reasons a creator can act on are links, not tooltips.** A
 * Work is born unrated and the server refuses to release it while it is, so "open Edit and
 * say whether this is General or Mature" was an instruction that could not be followed by
 * clicking it while the editor was a modal with no URL. It has one now.
 */
import { EyeIcon, EyeSlashIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import { Link } from "../../lib/router";
import { studioEditWorkUrl } from "../../lib/studio";
import type { Work } from "../../lib/types";
import {
	AccessBadge,
	accessState,
	itemPreviewUrl,
	MaturityBadge,
	ProcessingBadge,
	TypeBadge,
	TypeIcon,
} from "./works";

interface ContentItemCardProps {
	item: Work;
	onDelete: (item: Work) => void;
	/** Flip visibility. Absent → the control is not rendered. */
	onSetVisibility?: (item: Work, visibility: "private" | "released") => void;
	/** True while this card's own visibility change is in flight. */
	busy?: boolean;
}

export default function WorkCard({ item, onDelete, onSetVisibility, busy }: ContentItemCardProps) {
	const preview = itemPreviewUrl(item);
	const released = item.visibility === "released";
	const state = accessState(item);
	const editUrl = studioEditWorkUrl(item.publicId ?? item.id);

	// The server refuses to release a Work whose media is still encoding, and refuses one
	// with no delivery switch on. Disable rather than let the click earn an error.
	const processing =
		item.transcoding?.status === "pending" || item.transcoding?.status === "processing";
	const noDelivery = !item.streamEnabled && !item.downloadEnabled;
	// A Work is born `unrated` and the server refuses to release it while it is — so the
	// card, which is how a back catalog gets released thirty at a time, has to say which
	// ones still need answering rather than earning thirty identical errors.
	const unrated = !item.maturity || item.maturity === "unrated";
	const blocked = !released && (processing || noDelivery || unrated);
	const blockedWhy = processing
		? "Still processing — it can be released once the media is ready"
		: unrated
			? "Say whether this is General or Mature before releasing"
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
					<Link to={editUrl} className="link link-hover">
						{item.title || "Untitled"}
					</Link>
				</h3>
				<div className="flex flex-wrap items-center gap-1">
					<TypeBadge type={item.type} />
					<AccessBadge item={item} />
					<ProcessingBadge item={item} />
					<MaturityBadge work={item} />
				</div>
				{state === "locked" && (
					<p className="text-xs text-error">
						Released, but no one can open it —{" "}
						<Link to={editUrl} className="link">
							set access on this Work
						</Link>
						.
					</p>
				)}
				{unrated && !released && (
					<p className="text-xs text-warning">
						<Link to={editUrl} className="link">
							Rate this
						</Link>{" "}
						before it can be released.
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
					<Link to={editUrl} className="btn btn-ghost btn-xs" title="Edit">
						<PencilSquareIcon className="w-4 h-4" />
					</Link>
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

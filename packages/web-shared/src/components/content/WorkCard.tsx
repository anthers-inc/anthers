// SPDX-License-Identifier: Apache-2.0
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

import { isEmptyWriting, workNeedsFile } from "@anthers/shared/content";
import { isRatingComplete } from "@anthers/shared/content-rating";
import { EyeIcon, EyeSlashIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import { Link } from "../../lib/router";
import { studioEditWorkUrl } from "../../lib/studio";
import type { Work } from "../../lib/types";
import { isUploading, useSourceUpload } from "../../lib/work-uploads";
import { etaLeft } from "./processing";
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
	const eta =
		item.transcoding?.status === "processing" ? etaLeft(item.transcoding.etaSeconds) : null;
	// And one whose file has not arrived (`media_missing`) — still uploading from this tab, or
	// never uploaded because the tab that was uploading it closed.
	const upload = useSourceUpload(item.id);
	const uploading = isUploading(upload);
	const noFile = workNeedsFile(item.type) && !item.sourceKey;
	// And a piece of writing with nothing in it yet (`text_missing`), which is its body the way a
	// video is its file.
	const emptyWriting = item.type === "text" && isEmptyWriting(item.bodyHtml);
	const noDelivery = !item.streamEnabled && !item.downloadEnabled;
	// A Work is born `unrated` and the server refuses to release it until every row of its rating
	// is answered — so the card, which is how a back catalog gets released thirty at a time, has
	// to say which ones still need answering rather than earning thirty identical errors. Asked of
	// the rows rather than the rating, since a Work rated before the matrix holds a rating with no
	// rows behind it and is refused all the same.
	const unrated = !isRatingComplete(item.maturityRows);
	const blocked = !released && (noFile || emptyWriting || processing || noDelivery || unrated);
	const blockedWhy = uploading
		? "Still uploading — it can be released once its file arrives and is processed"
		: noFile
			? "Upload its file before releasing"
			: emptyWriting
				? "Write it before releasing"
				: processing
					? "Still processing — it can be released once the media is ready"
					: unrated
						? "Rate it before releasing"
						: "Turn on streaming or downloads before releasing";

	return (
		<div className="card bg-base-100 border border-base-300 overflow-hidden">
			{/* The thumbnail is the biggest thing on the card and the first thing a creator
			    clicks, so it opens the Work like the title does. The card itself cannot be one
			    link, as the public cards are, because it holds buttons. This second link to the
			    same place stays out of the tab order and the accessibility tree, where the title
			    already names it. */}
			<Link
				to={editUrl}
				tabIndex={-1}
				aria-hidden="true"
				className="aspect-video bg-base-200 flex items-center justify-center overflow-hidden"
			>
				{preview ? (
					<img src={preview} alt="" className="w-full h-full object-cover" />
				) : (
					<TypeIcon type={item.type} className="w-12 h-12 text-base-content/30" />
				)}
			</Link>
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
				{/* The estimate, on its own line because the badge above has no room for it. The card
				    is where a creator uploading a back catalog watches thirty of these at once. */}
				{processing && eta && <p className="text-xs text-base-content/60">{eta}</p>}
				{item.scheduledReleaseAt && !released && (
					<p className="text-xs text-info">
						{Date.parse(item.scheduledReleaseAt) <= Date.now()
							? "Releases as soon as it's ready."
							: `Releases ${new Date(item.scheduledReleaseAt).toLocaleString(undefined, {
									dateStyle: "medium",
									timeStyle: "short",
								})}.`}
					</p>
				)}
				{noFile && !uploading && !released && (
					<p className="text-xs text-warning">
						<Link to={editUrl} className="link">
							Upload its file
						</Link>{" "}
						before it can be released.
					</p>
				)}
				{emptyWriting && !released && (
					<p className="text-xs text-warning">
						<Link to={editUrl} className="link">
							Write it
						</Link>{" "}
						before it can be released.
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

// SPDX-License-Identifier: Apache-2.0
/**
 * One Work in the creator's Works table as a row: thumbnail, title and description, the
 * release and access state, the processing state, the upload date and the counts.
 *
 * This carries forward the card's reasoning, which it replaced (the Works listing stopped
 * being a grid): Release is in the table because the common case is uploading a back
 * catalog — a creator releasing thirty Works should not open thirty pages; the page still
 * owns the *shape* of a release. ⭐ And the two blocked-release reasons a creator can act
 * on are links, not tooltips: a Work is born unrated and the server refuses to release it
 * while it is, so "open Edit and say whether this is General or Mature" has to be
 * followable by clicking it.
 */

import { isEmptyWriting, needsChosenThumbnail, workNeedsFile } from "@anthers/shared/content";
import { gridFor, isRatingComplete } from "@anthers/shared/content-rating";
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

export default function WorkRow({
	item,
	onDelete,
	onSetVisibility,
	busy,
}: {
	item: Work;
	onDelete: (item: Work) => void;
	/** Flip visibility. Absent → the control is not rendered. */
	onSetVisibility?: (item: Work, visibility: "private" | "released") => void;
	/** True while this row's own visibility change is in flight. */
	busy?: boolean;
}) {
	const preview = itemPreviewUrl(item);
	const released = item.visibility === "released";
	const state = accessState(item);
	const editUrl = studioEditWorkUrl(item.publicId ?? item.id);

	// The server refuses to release a Work whose media is still encoding, and refuses one
	// with no delivery switch on. Disable rather than let the click earn an error.
	const processing =
		item.transcoding?.status === "pending" || item.transcoding?.status === "processing";
	const canceled = item.transcoding?.status === "canceled";
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
	// is answered — so the row, which is how a back catalog gets released thirty at a time, has
	// to say which ones still need answering rather than earning thirty identical errors. Asked of
	// the rows rather than the rating, since a Work rated before the matrix holds a rating with no
	// rows behind it and is refused all the same.
	const unrated = !isRatingComplete(item.maturityRows, gridFor(item.type));
	// And a video with no thumbnail its creator chose (`thumbnail_missing`).
	const noThumbnail = needsChosenThumbnail(item.type) && !item.thumbnail;
	const blocked =
		!released &&
		(noFile || emptyWriting || processing || canceled || noDelivery || unrated || noThumbnail);
	const blockedWhy = uploading
		? "Still uploading — it can be released once its file arrives and is processed"
		: noFile
			? "Upload its file before releasing"
			: emptyWriting
				? "Write it before releasing"
				: processing
					? "Still processing — it can be released once the media is ready"
					: canceled
						? "Replace the media or remove it — its processing was canceled"
						: unrated
							? "Rate it before releasing"
							: noThumbnail
								? "Choose a thumbnail before releasing"
								: "Turn on streaming or downloads before releasing";

	return (
		<tr className="border-b border-base-300/50 hover:bg-base-200/40 align-middle">
			{/* WORK — the thumbnail, the title and the description, as one link target like the
			    video column the table is modeled on. The thumbnail is out of the accessibility
			    tree because the title already names the same place. */}
			<td className="py-2.5 pr-4">
				<div className="flex items-center gap-3 max-w-md">
					<Link
						to={editUrl}
						tabIndex={-1}
						aria-hidden="true"
						className="block w-24 aspect-video rounded bg-base-200 overflow-hidden shrink-0"
					>
						{preview ? (
							<img src={preview} alt="" className="w-full h-full object-cover" />
						) : (
							<span className="w-full h-full flex items-center justify-center">
								<TypeIcon type={item.type} className="w-6 h-6 text-base-content/30" />
							</span>
						)}
					</Link>
					<div className="min-w-0">
						<p className="font-medium text-sm truncate" title={item.title ?? undefined}>
							<Link to={editUrl} className="link link-hover">
								{item.title || "Untitled"}
							</Link>
						</p>
						<p className="text-xs text-base-content/60 line-clamp-2 break-words">
							{item.description || "No description"}
						</p>
						<div className="mt-0.5">
							<TypeBadge type={item.type} />
						</div>
					</div>
				</div>
			</td>

			{/* VISIBILITY — the release state first, the access ladder beneath it, and the
			    switch below both so a back catalog still releases thirty rows at a time. */}
			<td className="py-2.5 pr-4">
				<div className="flex flex-col items-start gap-1">
					<AccessBadge item={item} />
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
				</div>
			</td>

			{/* STATUS — what is moving, what is missing, and what is owed before a release. */}
			<td className="py-2.5 pr-4">
				<div className="flex flex-wrap items-center gap-1">
					<ProcessingBadge item={item} />
					<MaturityBadge work={item} />
				</div>
				{state === "locked" && (
					<p className="text-xs text-error mt-1">
						Released, but no one can open it —{" "}
						<Link to={editUrl} className="link">
							set access on this Work
						</Link>
						.
					</p>
				)}
				{processing && eta && <p className="text-xs text-base-content/60 mt-1">{eta}</p>}
				{item.scheduledReleaseAt && !released && (
					<p className="text-xs text-info mt-1">
						{Date.parse(item.scheduledReleaseAt) <= Date.now()
							? "Releases as soon as it's ready."
							: `Releases ${new Date(item.scheduledReleaseAt).toLocaleString(undefined, {
									dateStyle: "medium",
									timeStyle: "short",
								})}.`}
					</p>
				)}
				{noFile && !uploading && !released && (
					<p className="text-xs text-warning mt-1">
						<Link to={editUrl} className="link">
							Upload its file
						</Link>{" "}
						before it can be released.
					</p>
				)}
				{emptyWriting && !released && (
					<p className="text-xs text-warning mt-1">
						<Link to={editUrl} className="link">
							Write it
						</Link>{" "}
						before it can be released.
					</p>
				)}
				{unrated && !released && (
					<p className="text-xs text-warning mt-1">
						<Link to={editUrl} className="link">
							Rate this
						</Link>{" "}
						before it can be released.
					</p>
				)}
			</td>

			{/* DATE — the upload date, the creator-facing one (the wiki's *Publishing* carries
			    the two dates' split). Absent sorts, and reads, as nothing at all. */}
			<td className="py-2.5 pr-4 whitespace-nowrap text-sm text-base-content/70">
				{item.createdAt
					? new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium" })
					: "—"}
			</td>

			{/* Counts — what the Work has done. A zero reads as an em dash, which is quieter. */}
			<td className="py-2.5 pr-4 text-sm text-base-content/70 tabular-nums">
				{item.viewCount ? item.viewCount.toLocaleString() : "—"}
				{item.downloadCount ? (
					<p className="text-xs text-base-content/40">
						{item.downloadCount.toLocaleString()} downloads
					</p>
				) : null}
			</td>

			{/* Row actions: the editor, and the delete dialog the page owns. */}
			<td className="py-2.5 pr-4 text-right whitespace-nowrap">
				<div className="flex justify-end gap-1">
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
			</td>
		</tr>
	);
}

// SPDX-License-Identifier: Apache-2.0
/**
 * One Work in the creator's Works table as a row: thumbnail and title, the description
 * as its own column beside it, the media status, the release date (editable — the same
 * acts the Work's own page offers), the counts, the review figures and the row's action.
 *
 * **The access chip rides under the type chip** (Parker, 2026-10-19): the two describe the
 * Work together, the way they sit beside the title on its own page, so the table keeps them
 * together rather than giving access a column of its own.
 *
 * This carries forward the card's reasoning, which it replaced (the Works listing stopped
 * being a grid): the release acts live in the table because the common case is uploading
 * a back catalog — a creator releasing thirty Works should not open thirty pages; the
 * page still owns the *shape* of a release. ⭐ And the reasons a blocked release gives
 * are links, not tooltips: a Work is born unrated and the server refuses to release it
 * while it is, so "open the Work and say whether this is General or Mature" has to be
 * followable by clicking it.
 *
 * 🚨 **The row has no Edit button** (Parker, 2026-10-17): the title and the thumbnail are
 * the Work's page, which is the editing surface for its creator — a second link to the
 * same place read as a different destination. Delete stays, as a labeled button rather
 * than a bare icon: it is the one destructive act on the row, and the icon alone asked
 * the creator to know what it meant.
 *
 * **Media Status is per-variant** (Parker, 2026-10-17): a video row shows the same
 * chips its Manage tab shows — the original, the audio rendition, the ladder — rather
 * than a badge that only says "Ready", so a back catalog's encoding state reads in place.
 * The other kinds keep the single processing badge, which for a one-file Work is the
 * whole truth.
 */

import { isEmptyWriting, needsChosenThumbnail, workNeedsFile } from "@anthers/shared/content";
import { gridFor, isRatingComplete } from "@anthers/shared/content-rating";
import { TrashIcon } from "@heroicons/react/24/outline";
import { Link } from "../../lib/router";
import { studioEditWorkUrl } from "../../lib/studio";
import type { Work } from "../../lib/types";
import { isUploading, useSourceUpload } from "../../lib/work-uploads";
import { VideoMediaStatusChips } from "./media-status";
import { etaLeft } from "./processing";
import { WorkReleaseCell, type WorkReleaseFields } from "./release-date";
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
	onRelease,
	busy,
}: {
	item: Work;
	onDelete: (item: Work) => void;
	/** One release act — publish now, schedule, clear, unrelease — from the row. */
	onRelease: (item: Work, fields: WorkReleaseFields) => Promise<boolean>;
	/** True while this row's own release act is in flight. */
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
			{/* WORK — the thumbnail and the title, as one link target like the
			    video column the table is modeled on. The thumbnail is out of the accessibility
			    tree because the title already names the same place. The rating rides the type
			    badge: both describe the Work rather than any one column's business. The access
			    chip sits on its own line beneath them (Parker, 2026-10-19) — the two describe
			    the Work together on its own page, so the table keeps them together too. */}
			<td className="py-2.5 pr-4 align-middle border-r border-base-300">
				<div className="flex items-center gap-3">
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
						<div className="mt-0.5 flex flex-wrap items-center gap-1">
							<TypeBadge type={item.type} />
							<MaturityBadge work={item} />
						</div>
						<div className="mt-1 flex flex-wrap items-center gap-1">
							<AccessBadge item={item} />
						</div>
					</div>
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
			</td>

			{/* DESCRIPTION — its own column beside the title (Parker, 2026-10-16): the row had
			    the room, and a back catalog's descriptions read in place rather than on the edit
			    page. The empty case keeps the row's quiet register instead of rendering nothing.
			    It is also the table's one flexible column, so its clamp is what makes a narrow
			    window cost nothing but excerpt (Parker, 2026-10-19). */}
			<td className="py-2.5 pr-4 align-middle border-r border-base-300/50">
				<p className="text-xs text-base-content/60 line-clamp-2 break-words max-w-lg">
					{item.description || "No description"}
				</p>
			</td>

			{/* MEDIA STATUS — what is moving, what is missing, and what is owed before a
			    release. A video shows the same chips its Manage tab shows; the other kinds
			    keep the one badge that is their whole media state. */}
			<td className="py-2.5 pr-4 align-middle border-r border-base-300/50">
				{item.type === "video" ? (
					<div className="flex flex-col gap-1">
						<VideoMediaStatusChips work={item} sourceUpload={upload} />
						{processing && eta && <p className="text-xs text-base-content/60">{eta}</p>}
					</div>
				) : (
					<ProcessingBadge item={item} />
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
			</td>

			{/* RELEASE DATE — the Work's place in the public Catalog, as the editable field
			    the Work's own page carries: publish now, schedule, clear, unrelease. The
			    rating link rides here rather than in Media Status because the rating is
			    what the release waits on, not media. */}
			<td className="py-2.5 pr-4 align-middle border-r border-base-300/50">
				<WorkReleaseCell
					item={item}
					blocked={blocked}
					blockedWhy={blockedWhy}
					onRelease={onRelease}
					busy={busy}
				/>
				{unrated && !released && (
					<p className="text-xs text-warning mt-1">
						<Link to={editUrl} className="link">
							Rate this
						</Link>{" "}
						before it can be released.
					</p>
				)}
			</td>

			{/* Counts — what the Work has done. A zero reads as an em dash, which is quieter. */}
			<td className="py-2.5 pr-4 align-middle border-r border-base-300/50 text-sm text-base-content/70 tabular-nums">
				{item.viewCount ? item.viewCount.toLocaleString() : "—"}
				{item.downloadCount ? (
					<p className="text-xs text-base-content/40">
						{item.downloadCount.toLocaleString()} downloads
					</p>
				) : null}
			</td>

			{/* REVIEWS — the net verdict and the counts behind it, the same figures the Work
			    page's review section leads with: `+10 (+30/-20)` reads as ten more people
			    recommended it than did not, from thirty for and twenty against. */}
			<td className="py-2.5 pr-4 align-middle border-r border-base-300/50 text-sm text-base-content/70 tabular-nums whitespace-nowrap">
				<ReviewCounts item={item} />
			</td>

			{/* Row actions: the delete dialog the page owns. The Work's page — the title,
			    the thumbnail, the same place — is the editing surface, so no Edit button. */}
			<td className="py-2.5 pr-4 align-middle text-right whitespace-nowrap">
				<button
					type="button"
					className="btn btn-ghost btn-xs text-error"
					onClick={() => onDelete(item)}
				>
					Delete
					<TrashIcon className="w-4 h-4" />
				</button>
			</td>
		</tr>
	);
}

/**
 * The Reviews column's content: the net and the pair behind it, or the quiet em dash a
 * Work nobody has reviewed shares with a zero Views cell.
 */
function ReviewCounts({ item }: { item: Work }) {
	const recommended = item.reviewCounts?.recommended ?? 0;
	const notRecommended = item.reviewCounts?.notRecommended ?? 0;
	if (recommended + notRecommended === 0) return <>—</>;
	const net = recommended - notRecommended;
	const netText = net > 0 ? `+${net.toLocaleString()}` : net.toLocaleString();
	return (
		<>
			{netText}{" "}
			<span className="text-xs text-base-content/40">
				({recommended.toLocaleString()}/{notRecommended.toLocaleString()})
			</span>
		</>
	);
}

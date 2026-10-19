// SPDX-License-Identifier: Apache-2.0
/**
 * One post in the creator's Posts table as a row — the Works table's row treatment
 * (`WorkRow.tsx`): thumbnail, title and tags down the left, the post's state, its date
 * and its counts. This is the plain list the page's predecessor rendered inline, given
 * the tall-row treatment so the three Studio listings read as one product.
 *
 * The thumbnail is the first linked Work's — a post has no image of its own, and the
 * linked Work's cover is what the feed card shows. The title opens the editor, the same
 * choice the Projects row makes: the row is the management surface, and the editor is
 * where a creator acts on a post. The Unpublish switch sits under the status badge, the
 * same slot the Work row's Release switch sits in.
 */

import {
	DocumentTextIcon,
	EyeSlashIcon,
	PencilSquareIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { Link } from "../../lib/router";
import { studioEditPostUrl } from "../../lib/studio";
import type { PostListItem } from "../../lib/types";
import { postDate, stateOf } from "./posts-list";

export default function PostRow({
	post,
	onDelete,
	onUnpublish,
	busy,
}: {
	post: PostListItem;
	onDelete: (post: PostListItem) => void;
	/** Withdraw the post to draft. Absent → the control is not rendered. */
	onUnpublish?: (post: PostListItem) => void;
	/** True while the page's own row action is in flight, so one click can't double-fire. */
	busy?: boolean;
}) {
	const editUrl = studioEditPostUrl(post.slug);
	const status = stateOf(post);
	const scheduled = post.scheduledFor ? new Date(post.scheduledFor).toLocaleString() : null;
	// The post's own date: published when it went out, written otherwise — the same
	// date the feed orders by. Absent (nothing published, nothing written) reads as
	// nothing at all, the Work row's rule.
	const dateLabel = postDate(post)
		? new Date(postDate(post)).toLocaleString(undefined, { dateStyle: "medium" })
		: "—";

	return (
		<tr className="border-b border-base-300/50 hover:bg-base-200/40 align-middle">
			{/* POST — the linked Work's thumbnail, the title and the tags, as one block. The
			    thumbnail is out of the accessibility tree because the title already names
			    the same place. */}
			<td className="py-2.5 pr-4">
				<div className="flex items-center gap-3 max-w-md">
					<div className="block w-24 aspect-video rounded bg-base-200 overflow-hidden shrink-0">
						{post.thumbnail ? (
							<img src={post.thumbnail} alt="" className="w-full h-full object-cover" />
						) : (
							<span className="w-full h-full flex items-center justify-center">
								<DocumentTextIcon className="w-6 h-6 text-base-content/30" />
							</span>
						)}
					</div>
					<div className="min-w-0">
						<p className="font-medium text-sm truncate" title={post.title ?? undefined}>
							<Link to={editUrl} className="link link-hover">
								{post.title || "Untitled"}
							</Link>
						</p>
						{(post.tags?.length ?? 0) > 0 && (
							<p className="mt-0.5 flex flex-wrap gap-1">
								{post.tags?.map((tag) => (
									<span key={tag} className="badge badge-ghost badge-sm">
										{tag}
									</span>
								))}
							</p>
						)}
						<p className="text-xs text-base-content/60 mt-0.5">
							{post.linkedWorkCount > 0
								? `Links ${post.linkedWorkCount} ${post.linkedWorkCount === 1 ? "Work" : "Works"}`
								: "No linked Works"}
						</p>
					</div>
				</div>
			</td>

			{/* STATUS — the post's state, the schedule beneath it, and the Unpublish switch
			    in the slot the Work row's Release switch occupies. A published post the
			    creator took off the timeline still reaches its URL; the badge says what the
			    feed shows, and the note says what the creator did. */}
			<td className="py-2.5 pr-4">
				<div className="flex flex-col items-start gap-1">
					<span
						className={`badge badge-sm ${
							status === "published"
								? "badge-success"
								: status === "scheduled"
									? "badge-info"
									: "badge-warning"
						}`}
					>
						{status === "published" ? "Published" : status === "scheduled" ? "Scheduled" : "Draft"}
					</span>
					{status === "scheduled" && scheduled && (
						<p className="text-xs text-info" title={`Scheduled for ${scheduled}`}>
							Scheduled for {scheduled}
						</p>
					)}
					{status === "published" && onUnpublish && (
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => onUnpublish(post)}
							disabled={busy}
							title="Move back to drafts"
						>
							<EyeSlashIcon className="w-4 h-4" />
							Unpublish
						</button>
					)}
				</div>
			</td>

			{/* DATE — the post's own date: published when it went out, written otherwise,
			    the same date the feed orders by. */}
			<td className="py-2.5 pr-4 whitespace-nowrap text-sm text-base-content/70">{dateLabel}</td>

			{/* Counts — what the post has done. A zero reads as an em dash, which is quieter. */}
			<td className="py-2.5 pr-4 text-sm text-base-content/70 tabular-nums">
				{post.viewCount ? post.viewCount.toLocaleString() : "—"}
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
						onClick={() => onDelete(post)}
						disabled={busy}
						title="Delete"
					>
						<TrashIcon className="w-4 h-4" />
					</button>
				</div>
			</td>
		</tr>
	);
}

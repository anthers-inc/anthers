// SPDX-License-Identifier: AGPL-3.0-or-later

import { LockedCover, lockedByBadge, unlockLabel } from "@anthers/web-shared/post/unlock";
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import type { Work } from "@anthers/web-shared/types";
import { MusicalNoteIcon, PlayIcon } from "@heroicons/react/24/solid";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import PricingBadge from "../ui/PricingBadge";

/** Who the Seeds would go to, for a card's unlock copy. */
function cardCreatorName(work: WorkCardItem): string {
	return work.creator?.displayName || work.creator?.username || "this creator";
}

/** A Work as the Catalog lists it, plus the creator the listing joins on. */
type WorkCardItem = Work & {
	creator?: { username: string; displayName?: string | null; avatar?: string | null };
};

/**
 * Renders the creator-asserted **Created** date at exactly the precision they claimed.
 *
 * A Work back-dated to "2015" must render "2015", not "1 January 2015" — inventing a day
 * the creator never asserted is the kind of false precision the whole `authoredPrecision`
 * column exists to prevent. Falls back to the release date when nothing was asserted.
 */
function madeLabel(work: WorkCardItem): string {
	const iso = work.authoredAt ?? work.releasedAt ?? work.createdAt;
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	if (!work.authoredAt) {
		return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	}
	switch (work.authoredPrecision) {
		case "year":
			return String(d.getUTCFullYear());
		case "month":
			return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
		default:
			return d.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			});
	}
}

export default function WorkCard({ work: post }: { work: WorkCardItem }) {
	const date = madeLabel(post);

	// Locked to the viewer → the card is a gated preview (blurred cover, visible title).
	// Clicking still navigates into the post, where the unlock options live.
	const locked = post.access ? !post.access.canAccess : false;

	const content = (
		<>
			{/* Thumbnail / cover area */}
			{locked ? (
				<LockedCover
					thumbnail={post.thumbnail}
					className="aspect-video"
					lockedBy={post.access ? lockedByBadge(post.access, cardCreatorName(post)) : null}
				/>
			) : (
				<>
					{post.type === "video" && (
						<div className="relative aspect-video bg-base-300">
							{post.thumbnail ? (
								<img src={post.thumbnail} alt="" className="w-full h-full object-cover" />
							) : (
								<div className="w-full h-full flex items-center justify-center">
									<PlayIcon className="w-12 h-12 text-base-content/20" />
								</div>
							)}
							{/* Play icon overlay */}
							<div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/20">
								<div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
									<PlayIcon className="w-6 h-6 text-black ml-0.5" />
								</div>
							</div>
						</div>
					)}

					{post.type === "audio" && (
						<div className="relative h-24 bg-gradient-to-br from-secondary/20 to-primary/20">
							<div className="absolute inset-0 flex items-center justify-center">
								<MusicalNoteIcon className="w-10 h-10 text-base-content/20" />
							</div>
						</div>
					)}

					{post.type === "text" && post.thumbnail && (
						<figure>
							<img src={post.thumbnail} alt="" className="w-full h-36 object-cover" />
						</figure>
					)}
				</>
			)}

			{/* Card body */}
			<div className="card-body p-4 gap-2">
				{/* Creator info */}
				<div className="flex items-center gap-2">
					{post.creator?.avatar ? (
						<img
							src={post.creator.avatar}
							alt={post.creator.username}
							className="w-6 h-6 rounded-full object-cover"
						/>
					) : (
						<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
							{(post.creator?.username ?? "?").charAt(0).toUpperCase()}
						</div>
					)}
					<span className="text-sm text-base-content/70">{post.creator?.username}</span>
					<span className="text-xs text-base-content/40 ml-auto">{date}</span>
				</div>

				{/* Title */}
				{post.title && <h3 className="font-semibold line-clamp-2">{post.title}</h3>}

				{locked && post.access ? (
					<>
						<p className="text-xs text-base-content/40 italic line-clamp-2">
							Members-only work from this creator.
						</p>
						{/* Visual affordance only — the whole card opens the unlock modal. */}
						<span className="btn btn-sm btn-outline btn-block mt-1 pointer-events-none">
							{unlockLabel(post.access, cardCreatorName(post))}
						</span>
					</>
				) : (
					/* Badges row */
					<div className="flex items-center gap-2 mt-auto pt-1">
						<ContentTypeBadge contentType={post.type} />
						<PricingBadge access={post.access} />
						{post.estimatedReadMinutes && post.type === "text" && (
							<span className="text-xs text-base-content/40">
								{post.estimatedReadMinutes} min read
							</span>
						)}
					</div>
				)}
			</div>
		</>
	);

	const cardClass =
		"card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden text-left";

	return (
		<Link to={workUrl(post)} className={cardClass}>
			{content}
		</Link>
	);
}

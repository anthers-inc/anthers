// SPDX-License-Identifier: AGPL-3.0-or-later
import { MusicalNoteIcon, PlayIcon } from "@heroicons/react/24/solid";
import { Link } from "react-router-dom";
import { postUrl } from "../../lib/postUrl";
import type { PostListItem } from "../../lib/types";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import PricingBadge from "../ui/PricingBadge";

export default function ContentCard({ post }: { post: PostListItem }) {
	const date = new Date(post.createdAt).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

	return (
		<Link
			to={postUrl(post)}
			className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
		>
			{/* Thumbnail area */}
			{post.contentType === "video" && (
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

			{post.contentType === "audio" && (
				<div className="relative h-24 bg-gradient-to-br from-secondary/20 to-primary/20">
					<div className="absolute inset-0 flex items-center justify-center">
						<MusicalNoteIcon className="w-10 h-10 text-base-content/20" />
					</div>
				</div>
			)}

			{post.contentType === "text" && post.thumbnail && (
				<figure>
					<img src={post.thumbnail} alt="" className="w-full h-36 object-cover" />
				</figure>
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

				{/* Badges row */}
				<div className="flex items-center gap-2 mt-auto pt-1">
					<ContentTypeBadge contentType={post.contentType} />
					<PricingBadge access={post.access} />
					{post.estimatedReadMinutes && post.contentType === "text" && (
						<span className="text-xs text-base-content/40">
							{post.estimatedReadMinutes} min read
						</span>
					)}
				</div>
			</div>
		</Link>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownTrayIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";
import type { PostListItem } from "../../lib/types";
import ContentTypeBadge from "../ui/ContentTypeBadge";

export default function PostCard({ post }: { post: PostListItem }) {
	const date = new Date(post.createdAt).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

	const access = post.access;

	return (
		<Link
			to={`/${post.creator?.username ?? "unknown"}/posts/${post.slug}`}
			className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow"
		>
			<div className="card-body p-4 gap-2">
				<div className="flex items-center gap-2">
					{post.creator?.avatar ? (
						<img
							src={post.creator.avatar}
							alt={post.creator.username}
							className="w-8 h-8 rounded-full object-cover"
						/>
					) : (
						<div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
							{(post.creator?.username ?? "?").charAt(0).toUpperCase()}
						</div>
					)}
					<div>
						<span className="text-sm font-medium">{post.creator?.username}</span>
						<span className="text-xs text-base-content/50 ml-2">{date}</span>
					</div>
				</div>
				{post.title && <h3 className="font-semibold line-clamp-1">{post.title}</h3>}
				<div className="flex items-center gap-2 mt-auto pt-2">
					<ContentTypeBadge contentType={post.contentType} />
					{post.downloadEnabled && (
						<span className="badge badge-sm badge-ghost gap-1">
							<ArrowDownTrayIcon className="w-3 h-3" />
						</span>
					)}
					{access && !access.canAccess && access.requiresPurchase && (
						<span className="badge badge-sm badge-secondary">${access.price}</span>
					)}
					{access && !access.canAccess && !access.requiresPurchase && (
						<span className="badge badge-sm badge-ghost gap-1">
							<LockClosedIcon className="w-3 h-3" />
							Gated
						</span>
					)}
				</div>
			</div>
		</Link>
	);
}

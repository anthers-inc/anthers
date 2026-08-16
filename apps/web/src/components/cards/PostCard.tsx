// SPDX-License-Identifier: AGPL-3.0-or-later

import { postUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import type { PostListItem } from "@anthers/web-shared/types";
import { LinkIcon } from "@heroicons/react/24/outline";

export default function PostCard({ post }: { post: PostListItem }) {
	const date = new Date(post.createdAt).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

	return (
		<Link
			to={postUrl(post)}
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
				{/* A post carries no type, no delivery and no gate — it is words and links.
				    What it can say is how many Works it points at. */}
				{post.linkedWorkCount > 0 && (
					<div className="flex items-center gap-2 mt-auto pt-2">
						<span className="badge badge-sm badge-ghost gap-1">
							<LinkIcon className="w-3 h-3" />
							{post.linkedWorkCount} {post.linkedWorkCount === 1 ? "work" : "works"}
						</span>
					</div>
				)}
			</div>
		</Link>
	);
}

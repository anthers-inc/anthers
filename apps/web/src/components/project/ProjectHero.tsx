// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router-dom";
import type { Post } from "../../lib/types";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import StarRating from "../ui/StarRating";

export default function ProjectHero({ post }: { post: Post }) {
	return (
		<div>
			{post.coverImage && (
				<div className="w-full h-64 md:h-80 overflow-hidden rounded-lg mb-6">
					<img
						src={post.coverImage}
						alt={post.title ?? "Cover"}
						className="w-full h-full object-cover"
					/>
				</div>
			)}
			<div className="flex flex-wrap items-start gap-2 mb-2">
				<ContentTypeBadge contentType={post.contentType} />
				{Array.isArray(post.tags) &&
					post.tags.map((tag) => (
						<Link key={tag} to={`/discover?tag=${tag}`} className="badge badge-outline badge-sm">
							{tag}
						</Link>
					))}
			</div>
			{post.title && <h1 className="text-3xl font-bold mb-2">{post.title}</h1>}
			<div className="flex items-center gap-4 text-sm">
				<span>
					by{" "}
					<Link to={`/${post.creator?.username}`} className="link link-hover font-medium">
						{post.creator?.displayName || post.creator?.username}
					</Link>
				</span>
				<StarRating rating={post.ratingAverage} count={post.ratingCount} />
			</div>
		</div>
	);
}

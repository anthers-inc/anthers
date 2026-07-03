// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownTrayIcon, CodeBracketIcon, EyeIcon, LinkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { client } from "../../lib/rpc";
import type { Post, PublicUser } from "../../lib/types";

export default function ProjectSidebar({ post }: { post: Post }) {
	const { isAuthenticated, user } = useAuth();
	const [creator, setCreator] = useState<PublicUser | null>(null);
	const [isFollowing, setIsFollowing] = useState(false);

	useEffect(() => {
		const username = post.creator?.username;
		if (!username) return;

		client.api.accounts.users[":username"]
			.$get({ param: { username } })
			.then(async (res) => {
				if (!res.ok) return;
				const data = await res.json();
				setCreator(data.user);
				setIsFollowing(data.user.isFollowing);
			})
			.catch(console.error);
	}, [post.creator?.username]);

	const handleFollow = async () => {
		if (!isAuthenticated || !creator) return;
		try {
			if (isFollowing) {
				await client.api.accounts.users[":username"].unfollow.$post({
					param: { username: creator.username },
				});
				setIsFollowing(false);
			} else {
				await client.api.accounts.users[":username"].follow.$post({
					param: { username: creator.username },
				});
				setIsFollowing(true);
			}
		} catch (err) {
			console.error("Follow/unfollow failed:", err);
		}
	};

	const isOwnPost = user?.username === post.creator?.username;

	return (
		<div className="flex flex-col gap-6">
			{/* Creator card */}
			{creator && (
				<div className="card bg-base-200">
					<div className="card-body p-4 items-center text-center">
						<Link to={`/${creator.username}`}>
							{creator.avatar ? (
								<img
									src={creator.avatar}
									alt={creator.displayName || creator.username}
									className="w-16 h-16 rounded-full object-cover"
								/>
							) : (
								<div className="w-16 h-16 rounded-full bg-base-300 flex items-center justify-center text-2xl font-bold text-base-content/40">
									{(creator.displayName || creator.username).charAt(0).toUpperCase()}
								</div>
							)}
						</Link>
						<Link to={`/${creator.username}`} className="font-semibold link link-hover">
							{creator.displayName || creator.username}
						</Link>
						<span className="text-xs text-base-content/50">{creator.followerCount} followers</span>
						{isAuthenticated && !isOwnPost && (
							<button
								type="button"
								className={`btn btn-sm w-full ${isFollowing ? "btn-outline" : "btn-primary"}`}
								onClick={handleFollow}
							>
								{isFollowing ? "Following" : "Follow"}
							</button>
						)}
					</div>
				</div>
			)}

			{/* Draft state */}
			{post.isPublished === false && (
				<div className="badge badge-warning badge-sm">Draft — not published</div>
			)}

			{/* Tags */}
			{Array.isArray(post.tags) && post.tags.length > 0 && (
				<div>
					<h3 className="font-semibold text-sm mb-2">Tags</h3>
					<div className="flex flex-wrap gap-1">
						{post.tags.map((tag) => (
							<Link key={tag} to={`/discover?tag=${tag}`} className="badge badge-outline badge-sm">
								{tag}
							</Link>
						))}
					</div>
				</div>
			)}

			{/* Links */}
			{(post.websiteUrl || post.sourceUrl) && (
				<div>
					<h3 className="font-semibold text-sm mb-2">Links</h3>
					<div className="flex flex-col gap-1">
						{post.websiteUrl && (
							<a
								href={post.websiteUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="link link-hover text-sm flex items-center gap-1"
							>
								<LinkIcon className="w-4 h-4" />
								Website
							</a>
						)}
						{post.sourceUrl && (
							<a
								href={post.sourceUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="link link-hover text-sm flex items-center gap-1"
							>
								<CodeBracketIcon className="w-4 h-4" />
								Source Code
							</a>
						)}
					</div>
				</div>
			)}

			{/* Stats */}
			<div className="flex gap-4 text-sm text-base-content/60">
				<span className="flex items-center gap-1">
					<EyeIcon className="w-4 h-4" />
					{(post.viewCount ?? 0).toLocaleString()}
				</span>
				{(post.downloadCount ?? 0) > 0 && (
					<span className="flex items-center gap-1">
						<ArrowDownTrayIcon className="w-4 h-4" />
						{(post.downloadCount ?? 0).toLocaleString()}
					</span>
				)}
			</div>

			{/* Published date */}
			<div className="text-xs text-base-content/50">
				Published{" "}
				{new Date(post.createdAt).toLocaleDateString("en-US", {
					month: "long",
					day: "numeric",
					year: "numeric",
				})}
			</div>
		</div>
	);
}

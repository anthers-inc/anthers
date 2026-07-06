// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import { useState } from "react";
import { Link } from "react-router-dom";

export default function CreatorCard({ creator }: { creator: PublicUser }) {
	const { isAuthenticated, user } = useAuth();
	const [isFollowing, setIsFollowing] = useState(creator.isFollowing);
	const [followerCount, setFollowerCount] = useState(creator.followerCount);
	const isOwnProfile = user?.username === creator.username;

	const handleFollow = async (e: React.MouseEvent) => {
		e.preventDefault(); // Prevent link navigation
		if (!isAuthenticated) return;
		try {
			if (isFollowing) {
				await client.api.accounts.users[":username"].unfollow.$post({
					param: { username: creator.username },
				});
				setIsFollowing(false);
				setFollowerCount((c) => c - 1);
			} else {
				await client.api.accounts.users[":username"].follow.$post({
					param: { username: creator.username },
				});
				setIsFollowing(true);
				setFollowerCount((c) => c + 1);
			}
		} catch (err) {
			console.error("Follow/unfollow failed:", err);
		}
	};

	return (
		<Link
			to={`/${creator.username}`}
			className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow"
		>
			<div className="card-body p-4 gap-2 items-center text-center">
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
				<h3 className="font-semibold">{creator.displayName || creator.username}</h3>
				<p className="text-xs text-base-content/50">@{creator.username}</p>
				{creator.bio && <p className="text-sm text-base-content/70 line-clamp-2">{creator.bio}</p>}
				<div className="flex gap-4 text-xs text-base-content/60 mt-1">
					<span>{followerCount} followers</span>
					<span>{creator.projectCount} projects</span>
				</div>
				{isAuthenticated && !isOwnProfile && (
					<button
						type="button"
						className={`btn btn-sm mt-2 ${isFollowing ? "btn-outline" : "btn-primary"}`}
						onClick={handleFollow}
					>
						{isFollowing ? "Following" : "Follow"}
					</button>
				)}
			</div>
		</Link>
	);
}

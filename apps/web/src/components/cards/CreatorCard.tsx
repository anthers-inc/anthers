// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "@anthers/web-shared/auth";
import { profileUrl } from "@anthers/web-shared/profile";
import {
	INTERACTION_PERMISSION_HINT,
	useInteractionPermissionMissing,
} from "@anthers/web-shared/publishing";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import { useState } from "react";

export default function CreatorCard({ creator }: { creator: PublicUser }) {
	const { isAuthenticated, user } = useAuth();
	const [isFollowing, setIsFollowing] = useState(creator.isFollowing);
	const [followerCount, setFollowerCount] = useState(creator.followerCount);
	const isOwnProfile = user?.handle === creator.handle;
	const permissionMissing = useInteractionPermissionMissing(isAuthenticated) === true;

	const handleFollow = async (e: React.MouseEvent) => {
		e.preventDefault(); // Prevent link navigation
		if (!isAuthenticated) return;
		try {
			if (isFollowing) {
				await client.api.accounts.users[":handle"].unfollow.$post({
					param: { handle: creator.handle },
				});
				setIsFollowing(false);
				setFollowerCount((c) => c - 1);
			} else {
				const res = await client.api.accounts.users[":handle"].follow.$post({
					param: { handle: creator.handle },
				});
				// Only a follow that was kept reads as one.
				if (!res.ok) return;
				setIsFollowing(true);
				setFollowerCount((c) => c + 1);
			}
		} catch (err) {
			console.error("Follow/unfollow failed:", err);
		}
	};

	return (
		<Link
			to={profileUrl(creator.handle)}
			className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow"
		>
			<div className="card-body p-4 gap-2 items-center text-center">
				{creator.avatar ? (
					<img
						src={creator.avatar}
						alt={creator.displayName || creator.handle}
						className="w-16 h-16 rounded-full object-cover"
					/>
				) : (
					<div className="w-16 h-16 rounded-full bg-base-300 flex items-center justify-center text-2xl font-bold text-base-content/40">
						{(creator.displayName || creator.handle).charAt(0).toUpperCase()}
					</div>
				)}
				<h3 className="font-semibold">{creator.displayName || creator.handle}</h3>
				<p className="text-xs text-base-content/50">@{creator.handle}</p>
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
						// Unfollowing is never blocked; following writes a record.
						disabled={!isFollowing && permissionMissing}
						title={!isFollowing && permissionMissing ? INTERACTION_PERMISSION_HINT : undefined}
					>
						{isFollowing ? "Following" : "Follow"}
					</button>
				)}
			</div>
		</Link>
	);
}

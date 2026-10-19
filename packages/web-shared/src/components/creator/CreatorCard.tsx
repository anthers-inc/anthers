// SPDX-License-Identifier: Apache-2.0
/**
 * The **creator card** — the one way Anthers shows a person wherever a reader should be
 * able to meet them and follow them: their thumbnail, their name and handle, their own
 * bio, and the Follow control.
 *
 * ⭐ **It is the standard card rather than a per-surface arrangement** (Parker,
 * 2026-10-19): the Showings panel's creator entry and every creator listing draw this,
 * so a creator reads the same wherever they are met. Its shape follows Bluesky's profile
 * row — the avatar leading, the name and handle beside it, the bio under both, the
 * follow action at the right — adapted to Anthers' own surfaces (the `rounded-box`
 * border the other Work-page cards wear rather than a social post's borderless row).
 *
 * The card is one link to the profile; the Follow button sits inside it and stops the
 * navigation itself, because following somebody is not visiting them.
 */

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import { profileUrl } from "../../lib/profile";
import { INTERACTION_PERMISSION_HINT, useInteractionPermissionMissing } from "../../lib/publishing";
import { Link } from "../../lib/router";
import { client } from "../../lib/rpc";

/** The facts a creator card needs. Every creator shape carries these; the counts and the follow state are optional because not every listing asks for them. */
export interface CreatorCardUser {
	handle: string;
	displayName?: string | null;
	avatar?: string | null;
	bio?: string | null;
	isFollowing?: boolean;
	followerCount?: number;
	projectCount?: number;
}

export default function CreatorCard({
	creator,
	className,
}: {
	creator: CreatorCardUser;
	/** Extra layout classes for the grid or column the card sits in. */
	className?: string;
}) {
	const { isAuthenticated, user } = useAuth();
	const [isFollowing, setIsFollowing] = useState(creator.isFollowing ?? false);
	const [followerCount, setFollowerCount] = useState(creator.followerCount);
	const isOwnProfile = user?.handle === creator.handle;
	const permissionMissing = useInteractionPermissionMissing(isAuthenticated) === true;
	const name = creator.displayName || creator.handle;

	const handleFollow = async (e: React.MouseEvent) => {
		e.preventDefault(); // The card is a link; following is its own act.
		e.stopPropagation();
		if (!isAuthenticated) return;
		try {
			if (isFollowing) {
				await client.api.accounts.users[":handle"].unfollow.$post({
					param: { handle: creator.handle },
				});
				setIsFollowing(false);
				setFollowerCount((c) => (c === undefined ? c : Math.max(0, c - 1)));
			} else {
				const res = await client.api.accounts.users[":handle"].follow.$post({
					param: { handle: creator.handle },
				});
				// Only a follow that was kept reads as one.
				if (!res.ok) return;
				setIsFollowing(true);
				setFollowerCount((c) => (c === undefined ? c : c + 1));
			}
		} catch (err) {
			console.error("Follow/unfollow failed:", err);
		}
	};

	return (
		<Link
			to={profileUrl(creator.handle)}
			className={`rounded-box flex items-start gap-3 border border-base-300 bg-base-200/40 p-3 transition-colors hover:border-base-content/25 ${className ?? ""}`}
		>
			{creator.avatar ? (
				<img
					src={creator.avatar}
					alt={name}
					className="size-12 shrink-0 rounded-full object-cover"
				/>
			) : (
				<div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-base-300 text-lg font-bold text-base-content/40">
					{name.charAt(0).toUpperCase()}
				</div>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<p className="truncate text-sm font-semibold">{name}</p>
						<p className="truncate text-xs text-base-content/50">@{creator.handle}</p>
					</div>
					{isAuthenticated && !isOwnProfile && (
						<button
							type="button"
							className={`btn btn-xs shrink-0 ${isFollowing ? "btn-outline" : "btn-primary"}`}
							onClick={handleFollow}
							// Unfollowing is never blocked; following writes a record.
							disabled={!isFollowing && permissionMissing}
							title={!isFollowing && permissionMissing ? INTERACTION_PERMISSION_HINT : undefined}
						>
							{isFollowing ? "Following" : "Follow"}
						</button>
					)}
				</div>
				{creator.bio && (
					<p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm text-base-content/70">
						{creator.bio}
					</p>
				)}
				{(followerCount !== undefined || creator.projectCount !== undefined) && (
					<p className="mt-1.5 flex gap-3 text-xs text-base-content/50">
						{followerCount !== undefined && <span>{followerCount} followers</span>}
						{creator.projectCount !== undefined && <span>{creator.projectCount} projects</span>}
					</p>
				)}
			</div>
		</Link>
	);
}

import { Link } from "react-router-dom";
import type { PublicUser } from "../../lib/api";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useState } from "react";

export default function CreatorCard({ creator }: { creator: PublicUser }) {
  const { isAuthenticated, user } = useAuth();
  const [isFollowing, setIsFollowing] = useState(creator.is_following);
  const [followerCount, setFollowerCount] = useState(creator.follower_count);
  const isOwnProfile = user?.username === creator.username;

  const handleFollow = async (e: React.MouseEvent) => {
    e.preventDefault(); // Prevent link navigation
    if (!isAuthenticated) return;
    try {
      if (isFollowing) {
        await api.post(`/api/v1/accounts/users/${creator.username}/unfollow/`);
        setIsFollowing(false);
        setFollowerCount((c) => c - 1);
      } else {
        await api.post(`/api/v1/accounts/users/${creator.username}/follow/`);
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
            alt={creator.display_name || creator.username}
            className="w-16 h-16 rounded-full object-cover"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-base-300 flex items-center justify-center text-2xl font-bold text-base-content/40">
            {(creator.display_name || creator.username).charAt(0).toUpperCase()}
          </div>
        )}
        <h3 className="font-semibold">
          {creator.display_name || creator.username}
        </h3>
        <p className="text-xs text-base-content/50">@{creator.username}</p>
        {creator.bio && (
          <p className="text-sm text-base-content/70 line-clamp-2">
            {creator.bio}
          </p>
        )}
        <div className="flex gap-4 text-xs text-base-content/60 mt-1">
          <span>{followerCount} followers</span>
          <span>{creator.project_count} projects</span>
        </div>
        {isAuthenticated && !isOwnProfile && (
          <button
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

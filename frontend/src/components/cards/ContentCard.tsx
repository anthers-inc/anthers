import { Link } from "react-router-dom";
import type { PostListItem } from "../../lib/api";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import {
  PlayIcon,
  MusicalNoteIcon,
  LockClosedIcon,
} from "@heroicons/react/24/solid";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ContentCard({ post }: { post: PostListItem }) {
  const date = new Date(post.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Link
      to={`/posts/${post.id}`}
      className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
    >
      {/* Thumbnail area */}
      {post.content_type === "video" && (
        <div className="relative aspect-video bg-base-300">
          {post.thumbnail ? (
            <img
              src={post.thumbnail}
              alt=""
              className="w-full h-full object-cover"
            />
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
          {/* Duration badge */}
          {post.duration_seconds && (
            <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
              {formatDuration(post.duration_seconds)}
            </span>
          )}
        </div>
      )}

      {post.content_type === "audio" && (
        <div className="relative h-24 bg-gradient-to-br from-secondary/20 to-primary/20">
          <div className="absolute inset-0 flex items-center justify-center">
            <MusicalNoteIcon className="w-10 h-10 text-base-content/20" />
          </div>
          {post.duration_seconds && (
            <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
              {formatDuration(post.duration_seconds)}
            </span>
          )}
        </div>
      )}

      {post.content_type === "text" && post.thumbnail && (
        <figure>
          <img
            src={post.thumbnail}
            alt=""
            className="w-full h-36 object-cover"
          />
        </figure>
      )}

      {/* Card body */}
      <div className="card-body p-4 gap-2">
        {/* Creator info */}
        <div className="flex items-center gap-2">
          {post.creator_avatar ? (
            <img
              src={post.creator_avatar}
              alt={post.creator}
              className="w-6 h-6 rounded-full object-cover"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
              {(post.creator_username ?? post.creator).charAt(0).toUpperCase()}
            </div>
          )}
          <span className="text-sm text-base-content/70">{post.creator}</span>
          <span className="text-xs text-base-content/40 ml-auto">{date}</span>
        </div>

        {/* Title */}
        {post.title && (
          <h3 className="font-semibold line-clamp-2">{post.title}</h3>
        )}

        {/* Badges row */}
        <div className="flex items-center gap-2 mt-auto pt-1">
          <ContentTypeBadge contentType={post.content_type} />
          {post.is_premium && (
            <span className="badge badge-sm badge-secondary gap-1">
              <LockClosedIcon className="w-3 h-3" />
              Premium
            </span>
          )}
          {post.estimated_read_minutes && post.content_type === "text" && (
            <span className="text-xs text-base-content/40">
              {post.estimated_read_minutes} min read
            </span>
          )}
          {post.project_title && (
            <span className="badge badge-sm badge-outline ml-auto">
              {post.project_title}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

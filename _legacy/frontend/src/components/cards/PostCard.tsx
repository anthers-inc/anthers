import { Link } from "react-router-dom";
import type { Post } from "../../lib/api";

export default function PostCard({ post }: { post: Post }) {
  const excerpt =
    post.body.length > 150 ? post.body.slice(0, 150) + "..." : post.body;
  const date = new Date(post.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Link
      to={`/posts/${post.id}`}
      className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow"
    >
      <div className="card-body p-4 gap-2">
        <div className="flex items-center gap-2">
          {post.creator_avatar ? (
            <img
              src={post.creator_avatar}
              alt={post.creator}
              className="w-8 h-8 rounded-full object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
              {(post.creator_username ?? post.creator).charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <span className="text-sm font-medium">{post.creator}</span>
            <span className="text-xs text-base-content/50 ml-2">{date}</span>
          </div>
        </div>
        {post.title && (
          <h3 className="font-semibold line-clamp-1">{post.title}</h3>
        )}
        <p className="text-sm text-base-content/70 line-clamp-3">{excerpt}</p>
        {post.project_title && (
          <div className="mt-auto pt-2">
            <span className="badge badge-sm badge-outline">
              {post.project_title}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

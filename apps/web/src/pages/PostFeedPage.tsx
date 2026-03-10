import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { PostListItem } from "../lib/types";
import ContentCard from "../components/cards/ContentCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";

const FILTERS = [
  { key: "", label: "All" },
  { key: "text", label: "Writing" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
] as const;

const baseUrl =
  typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "http://localhost:8000"
    : "";

export default function PostFeedPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const contentTypeFilter = searchParams.get("content_type") ?? "";

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (contentTypeFilter) params.set("content_type", contentTypeFilter);
    const qs = params.toString();
    fetch(`${baseUrl}/api/content/posts${qs ? `?${qs}` : ""}`, {
      credentials: "include",
    })
      .then((res) => res.json())
      .then((data: { posts: PostListItem[] }) => setPosts(data.posts))
      .catch((err) => console.error("Failed to load posts:", err))
      .finally(() => setLoading(false));
  }, [contentTypeFilter]);

  const setFilter = (key: string) => {
    const params: Record<string, string> = {};
    if (key) params.content_type = key;
    setSearchParams(params);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">Posts</h1>
      <p className="text-base-content/60 mb-6">
        Updates, devlogs, and announcements from creators across Anthers.
      </p>

      {/* Content type filter buttons */}
      <div className="flex gap-2 mb-6">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            className={`btn btn-sm ${contentTypeFilter === key ? "btn-primary" : "btn-outline"}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : posts.length === 0 ? (
        <EmptyState
          title="No posts yet"
          description="No one has published a post yet. Check back soon."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-7xl">
          {posts.map((post) => (
            <ContentCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}

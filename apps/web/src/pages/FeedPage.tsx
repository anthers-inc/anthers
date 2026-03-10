import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { client } from "../lib/rpc";
import type { PostListItem } from "../lib/types";
import ContentCard from "../components/cards/ContentCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import { RssIcon } from "@heroicons/react/24/outline";

export default function FeedPage() {
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    client.api.accounts.me.feed
      .$get()
      .then((res) => res.json())
      .then((data) => setPosts((data as { posts: PostListItem[] }).posts))
      .catch(() => setError("Failed to load feed."))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-error">{error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Your Feed</h1>

      {posts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {posts.map((post) => (
            <ContentCard key={post.id} post={post} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<RssIcon className="w-12 h-12" />}
          title="Your feed is empty"
          description="Follow creators to see their posts here."
          action={
            <Link to="/creators" className="btn btn-primary btn-sm">
              Discover creators
            </Link>
          }
        />
      )}
    </div>
  );
}

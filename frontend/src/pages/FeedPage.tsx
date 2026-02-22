import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Post, PaginatedResponse } from "../lib/api";
import PostCard from "../components/cards/PostCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import Pagination from "../components/ui/Pagination";
import { RssIcon } from "@heroicons/react/24/outline";

export default function FeedPage() {
  const [data, setData] = useState<PaginatedResponse<Post> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    api
      .get<PaginatedResponse<Post>>(
        `/api/v1/accounts/me/feed/?page=${page}`,
      )
      .then(setData)
      .catch(() => setError("Failed to load feed."))
      .finally(() => setLoading(false));
  }, [page]);

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

      {data && data.results.length > 0 ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.results.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
          <Pagination
            count={data.count}
            next={data.next}
            previous={data.previous}
            currentPage={page}
            onPageChange={setPage}
          />
        </>
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

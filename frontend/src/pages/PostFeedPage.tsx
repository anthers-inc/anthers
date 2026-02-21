import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type PaginatedResponse, type Post } from "../lib/api";
import PostCard from "../components/cards/PostCard";
import Pagination from "../components/ui/Pagination";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";

export default function PostFeedPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<PaginatedResponse<Post> | null>(null);
  const [loading, setLoading] = useState(true);

  const currentPage = parseInt(searchParams.get("page") ?? "1");

  useEffect(() => {
    setLoading(true);
    api
      .get<PaginatedResponse<Post>>(
        `/api/v1/content/posts/?page=${currentPage}`
      )
      .then(setData)
      .catch((err) => console.error("Failed to load posts:", err))
      .finally(() => setLoading(false));
  }, [currentPage]);

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Posts</h1>
      <p className="text-base-content/60 mb-6">
        Updates, devlogs, and announcements from creators across Bluebell.
      </p>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : !data || data.results.length === 0 ? (
        <EmptyState
          title="No posts yet"
          description="No one has published a post yet. Check back soon."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl">
            {data.results.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
          <Pagination
            count={data.count}
            next={data.next}
            previous={data.previous}
            currentPage={currentPage}
            onPageChange={(page) =>
              setSearchParams({ page: String(page) })
            }
          />
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type PaginatedResponse, type PostListItem } from "../lib/api";
import ContentCard from "../components/cards/ContentCard";
import Pagination from "../components/ui/Pagination";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";

const FILTERS = [
  { key: "", label: "All" },
  { key: "text", label: "Writing" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
] as const;

export default function PostFeedPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<PaginatedResponse<PostListItem> | null>(null);
  const [loading, setLoading] = useState(true);

  const currentPage = parseInt(searchParams.get("page") ?? "1");
  const contentTypeFilter = searchParams.get("content_type") ?? "";

  useEffect(() => {
    setLoading(true);
    let url = `/api/v1/content/posts/?page=${currentPage}`;
    if (contentTypeFilter) {
      url += `&content_type=${contentTypeFilter}`;
    }
    api
      .get<PaginatedResponse<PostListItem>>(url)
      .then(setData)
      .catch((err) => console.error("Failed to load posts:", err))
      .finally(() => setLoading(false));
  }, [currentPage, contentTypeFilter]);

  const setFilter = (key: string) => {
    const params: Record<string, string> = { page: "1" };
    if (key) params.content_type = key;
    setSearchParams(params);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">Posts</h1>
      <p className="text-base-content/60 mb-6">
        Updates, devlogs, and announcements from creators across Bluebell.
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
      ) : !data || data.results.length === 0 ? (
        <EmptyState
          title="No posts yet"
          description="No one has published a post yet. Check back soon."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl">
            {data.results.map((post) => (
              <ContentCard key={post.id} post={post} />
            ))}
          </div>
          <Pagination
            count={data.count}
            next={data.next}
            previous={data.previous}
            currentPage={currentPage}
            onPageChange={(page) =>
              setSearchParams({
                page: String(page),
                ...(contentTypeFilter ? { content_type: contentTypeFilter } : {}),
              })
            }
          />
        </>
      )}
    </div>
  );
}

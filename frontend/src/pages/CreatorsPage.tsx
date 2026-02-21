import { useEffect, useState } from "react";
import { api, type PaginatedResponse, type PublicUser } from "../lib/api";
import CreatorCard from "../components/cards/CreatorCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import Pagination from "../components/ui/Pagination";
import { useSearchParams } from "react-router-dom";

export default function CreatorsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<PaginatedResponse<PublicUser> | null>(null);
  const [loading, setLoading] = useState(true);

  const currentPage = parseInt(searchParams.get("page") ?? "1");

  useEffect(() => {
    setLoading(true);
    api
      .get<PaginatedResponse<PublicUser>>(
        `/api/v1/accounts/creators/?page=${currentPage}`
      )
      .then(setData)
      .catch((err) => console.error("Failed to load creators:", err))
      .finally(() => setLoading(false));
  }, [currentPage]);

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Creators</h1>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : !data || data.results.length === 0 ? (
        <EmptyState
          title="No creators yet"
          description="Be the first to start creating on Bluebell."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.results.map((creator) => (
              <CreatorCard key={creator.id} creator={creator} />
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

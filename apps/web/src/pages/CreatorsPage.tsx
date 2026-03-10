import { useEffect, useState } from "react";
import { client } from "../lib/rpc";
import type { PublicUser } from "../lib/types";
import CreatorCard from "../components/cards/CreatorCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";

export default function CreatorsPage() {
  const [creators, setCreators] = useState<PublicUser[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    client.api.accounts.creators
      .$get()
      .then((res) => res.json())
      .then((data) => setCreators(data.creators))
      .catch((err) => console.error("Failed to load creators:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Creators</h1>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : !creators || creators.length === 0 ? (
        <EmptyState
          title="No creators yet"
          description="Be the first to start creating on Anthers."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {creators.map((creator) => (
            <CreatorCard key={creator.id} creator={creator} />
          ))}
        </div>
      )}
    </div>
  );
}

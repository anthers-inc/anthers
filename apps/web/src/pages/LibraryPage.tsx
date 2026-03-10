import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../lib/rpc";
import type { Purchase } from "../lib/types";
import LoadingSpinner from "../components/ui/LoadingSpinner";

export default function LibraryPage() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.api.payments.purchases
      .$get()
      .then((res) => res.json())
      .then((data) => setPurchases((data as { purchases: Purchase[] }).purchases))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">My Library</h1>

      {purchases.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-base-content/60 mb-4">
            You haven't purchased any projects yet.
          </p>
          <Link to="/explore" className="btn btn-primary">
            Explore Projects
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {purchases.map((purchase) => (
            <Link
              key={purchase.id}
              to={`/explore/${purchase.project?.slug}`}
              className="card bg-base-200 hover:shadow-lg transition-shadow"
            >
              {purchase.project?.coverImage ? (
                <figure>
                  <img
                    src={purchase.project.coverImage}
                    alt={purchase.project?.title}
                    className="w-full h-40 object-cover"
                  />
                </figure>
              ) : (
                <div className="w-full h-40 bg-base-300 flex items-center justify-center">
                  <span className="text-base-content/30 text-sm">
                    No cover
                  </span>
                </div>
              )}
              <div className="card-body p-4">
                <h2 className="card-title text-sm">{purchase.project?.title}</h2>
                <p className="text-xs text-base-content/60">
                  Purchased{" "}
                  {new Date(purchase.createdAt).toLocaleDateString()}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

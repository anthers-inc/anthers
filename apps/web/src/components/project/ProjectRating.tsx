import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { RatingAggregate } from "../../lib/types";
import { useAuth } from "../../lib/auth";
import StarRating from "../ui/StarRating";

export default function ProjectRating({ slug }: { slug: string }) {
  const { isAuthenticated } = useAuth();
  const [rating, setRating] = useState<RatingAggregate | null>(null);

  const fetchRating = () => {
    client.api.content.projects[":slug"].ratings
      .$get({ param: { slug } })
      .then((res) => res.json())
      .then(setRating)
      .catch(console.error);
  };

  useEffect(() => {
    fetchRating();
  }, [slug]);

  const handleRate = async (score: number) => {
    if (!isAuthenticated) return;
    try {
      await client.api.content.projects[":slug"].ratings.$post({
        param: { slug },
        json: { score },
      });
      fetchRating();
    } catch (err) {
      console.error("Failed to rate:", err);
    }
  };

  if (!rating) return null;

  return (
    <div>
      <h2 className="text-xl font-bold mb-3">Rating</h2>
      <div className="flex items-center gap-4">
        <StarRating
          rating={rating.average}
          count={rating.count}
          interactive={isAuthenticated}
          onRate={handleRate}
        />
        {rating.userRating !== null && (
          <span className="text-sm text-base-content/60">
            Your rating: {rating.userRating}/5
          </span>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api, type Post, type PaginatedResponse } from "../../lib/api";
import PostCard from "../cards/PostCard";

export default function ProjectDevlog({ slug }: { slug: string }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<PaginatedResponse<Post>>(
        `/api/v1/content/posts/?project=${slug}`
      )
      .then((data) => setPosts(data.results))
      .catch((err) => console.error("Failed to load devlog:", err))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading || posts.length === 0) return null;

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Devlog</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {posts.slice(0, 4).map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>
    </div>
  );
}

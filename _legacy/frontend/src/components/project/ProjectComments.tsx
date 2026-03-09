import { useEffect, useState } from "react";
import { api, type Comment, type PaginatedResponse } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import LoadingSpinner from "../ui/LoadingSpinner";

export default function ProjectComments({ slug }: { slug: string }) {
  const { isAuthenticated } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchComments = () => {
    api
      .get<PaginatedResponse<Comment>>(
        `/api/v1/content/projects/${slug}/comments/`
      )
      .then((data) => setComments(data.results))
      .catch((err) => console.error("Failed to load comments:", err))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchComments();
  }, [slug]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true);
    try {
      const comment = await api.post<Comment>(
        `/api/v1/content/projects/${slug}/comments/`,
        { body }
      );
      setComments([comment, ...comments]);
      setBody("");
    } catch (err) {
      console.error("Failed to post comment:", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Comments</h2>

      {isAuthenticated && (
        <form onSubmit={handleSubmit} className="mb-6">
          <textarea
            className="textarea textarea-bordered w-full"
            placeholder="Write a comment..."
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm mt-2"
            disabled={submitting || !body.trim()}
          >
            {submitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              "Post comment"
            )}
          </button>
        </form>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-base-content/50 text-sm">
          No comments yet. {isAuthenticated ? "Be the first!" : "Log in to comment."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-3">
              {comment.avatar ? (
                <img
                  src={comment.avatar}
                  alt={comment.username}
                  className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
                  {comment.username.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{comment.username}</span>
                  <span className="text-base-content/40 text-xs">
                    {new Date(comment.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm mt-1">{comment.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

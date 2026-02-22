import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Post, ProjectListItem, PaginatedResponse } from "../lib/api";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";

export default function PostFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [isPublished, setIsPublished] = useState(false);

  const [myProjects, setMyProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    // Load user's projects for the project link dropdown
    api
      .get<PaginatedResponse<ProjectListItem>>(
        "/api/v1/content/projects/?mine=true",
      )
      .then((data) => setMyProjects(data.results))
      .catch(() => {});

    // Load existing post if editing
    if (isEdit && id) {
      api
        .get<Post>(`/api/v1/content/posts/${id}/`)
        .then((post) => {
          setTitle(post.title);
          setBody(post.body);
          setProjectId(post.project ? String(post.project) : "");
          setIsPublished(post.is_published);
        })
        .catch(() => setError("Failed to load post."))
        .finally(() => setLoading(false));
    }
  }, [id, isEdit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setErrors({});

    const payload: Record<string, unknown> = {
      title,
      body,
      is_published: isPublished,
    };
    if (projectId) payload.project = Number(projectId);

    try {
      if (isEdit) {
        await api.patch(`/api/v1/content/posts/${id}/`, payload);
      } else {
        await api.post("/api/v1/content/posts/", payload);
      }
      navigate("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && err.data && typeof err.data === "object") {
        const fieldErrors: Record<string, string> = {};
        for (const [key, val] of Object.entries(
          err.data as Record<string, string[]>,
        )) {
          fieldErrors[key] = Array.isArray(val) ? val[0] : String(val);
        }
        setErrors(fieldErrors);
      } else {
        setError("Failed to save post.");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">
        {isEdit ? "Edit Post" : "New Post"}
      </h1>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FormField label="Title" error={errors.title}>
          <input
            type="text"
            className="input input-bordered w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Post title"
          />
        </FormField>

        <FormField label="Body" required error={errors.body}>
          <textarea
            className="textarea textarea-bordered w-full min-h-[200px]"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your post content here... (Markdown supported)"
          />
        </FormField>

        <FormField label="Linked Project" error={errors.project}>
          <select
            className="select select-bordered w-full"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">None</option>
            {myProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </FormField>

        <div className="form-control">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={isPublished}
              onChange={(e) => setIsPublished(e.target.checked)}
            />
            <span className="label-text">Publish</span>
          </label>
        </div>

        <div className="flex gap-2 mt-2">
          <button
            type="submit"
            className={`btn btn-primary ${saving ? "btn-disabled" : ""}`}
            disabled={saving}
          >
            {saving
              ? "Saving..."
              : isEdit
                ? "Update Post"
                : "Create Post"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate("/dashboard")}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

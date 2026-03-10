import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { client } from "../lib/rpc";
import type { Project, Screenshot } from "../lib/types";
import FormField from "../components/ui/FormField";
import FileUpload from "../components/ui/FileUpload";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { XMarkIcon } from "@heroicons/react/24/outline";

const apiBase =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:8000"
    : "";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function ProjectFormPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(slug);

  // Fields
  const [title, setTitle] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [description, setDescription] = useState("");
  const [shortDescription, setShortDescription] = useState("");
  const [mediaType, setMediaType] = useState<string>("game");
  const [tagsInput, setTagsInput] = useState("");
  const [pricingType, setPricingType] = useState<string>("free");
  const [price, setPrice] = useState("");
  const [embedUrl, setEmbedUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [isPublished, setIsPublished] = useState(false);

  // Images
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);

  // State
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isEdit && slug) {
      client.api.content.projects[":slug"]
        .$get({ param: { slug } })
        .then((res) => res.json())
        .then((data) => {
          const project = (data as { project: Project }).project;
          setTitle(project.title);
          setProjectSlug(project.slug);
          setSlugManual(true);
          setDescription(project.description || "");
          setShortDescription(project.shortDescription || "");
          setMediaType(project.mediaType);
          setTagsInput(project.tags.join(", "));
          setPricingType(project.pricingType);
          setPrice(project.price || "");
          setEmbedUrl(project.embedUrl || "");
          setWebsiteUrl(project.websiteUrl || "");
          setSourceUrl(project.sourceUrl || "");
          setIsPublished(project.isPublished ?? false);
          setCoverPreview(project.coverImage);
          setScreenshots(project.screenshots || []);
        })
        .catch(() => setError("Failed to load project."))
        .finally(() => setLoading(false));
    }
  }, [slug, isEdit]);

  // Auto-generate slug from title
  useEffect(() => {
    if (!slugManual && !isEdit) {
      setProjectSlug(slugify(title));
    }
  }, [title, slugManual, isEdit]);

  const handleScreenshotUpload = useCallback(
    async (file: File) => {
      if (!isEdit || !slug) return;
      const formData = new FormData();
      formData.append("image", file);
      try {
        const res = await fetch(
          `${apiBase}/api/content/projects/${slug}/screenshots`,
          {
            method: "POST",
            credentials: "include",
            body: formData,
          },
        );
        if (!res.ok) throw new Error("Upload failed");
        const screenshot = (await res.json()) as { screenshot: Screenshot };
        setScreenshots((prev) => [...prev, screenshot.screenshot]);
      } catch {
        setError("Failed to upload screenshot.");
      }
    },
    [isEdit, slug],
  );

  const handleScreenshotDelete = useCallback(
    async (id: number) => {
      if (!slug) return;
      try {
        const res = await fetch(
          `${apiBase}/api/content/projects/${slug}/screenshots/${id}`,
          {
            method: "DELETE",
            credentials: "include",
          },
        );
        if (!res.ok) throw new Error("Delete failed");
        setScreenshots((prev) => prev.filter((s) => s.id !== id));
      } catch {
        setError("Failed to delete screenshot.");
      }
    },
    [slug],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setErrors({});

    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (isEdit) {
        const formData = new FormData();
        formData.append("title", title);
        formData.append("description", description);
        formData.append("shortDescription", shortDescription);
        formData.append("mediaType", mediaType);
        formData.append("tags", JSON.stringify(tags));
        formData.append("pricingType", pricingType);
        if (pricingType === "paid" && price) formData.append("price", price);
        formData.append("embedUrl", embedUrl);
        formData.append("websiteUrl", websiteUrl);
        formData.append("sourceUrl", sourceUrl);
        formData.append("isPublished", String(isPublished));
        if (coverFile) formData.append("coverImage", coverFile);

        const res = await fetch(
          `${apiBase}/api/content/projects/${slug}`,
          {
            method: "PATCH",
            credentials: "include",
            body: formData,
          },
        );
        if (!res.ok) throw res;
      } else {
        // Create with JSON first (no file upload), then patch with cover
        const payload: Record<string, unknown> = {
          title,
          slug: projectSlug,
          description,
          shortDescription,
          mediaType,
          tags,
          pricingType,
          embedUrl,
          websiteUrl,
          sourceUrl,
          isPublished,
        };
        if (pricingType === "paid" && price) payload.price = price;

        const res = await client.api.content.projects.$post({
          json: payload as Record<string, unknown> & {
            title: string;
            slug: string;
          },
        });
        const created = (await res.json()) as { project: Project };

        // Upload cover image if provided
        if (coverFile) {
          const formData = new FormData();
          formData.append("coverImage", coverFile);
          await fetch(
            `${apiBase}/api/content/projects/${created.project.slug}`,
            {
              method: "PATCH",
              credentials: "include",
              body: formData,
            },
          );
        }
      }
      navigate("/dashboard");
    } catch (err) {
      if (err instanceof Response) {
        try {
          const data = await err.json();
          if (data && typeof data === "object") {
            const fieldErrors: Record<string, string> = {};
            for (const [key, val] of Object.entries(
              data as Record<string, string[]>,
            )) {
              fieldErrors[key] = Array.isArray(val) ? val[0] : String(val);
            }
            setErrors(fieldErrors);
            return;
          }
        } catch {
          // Fall through
        }
      }
      setError("Failed to save project.");
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
        {isEdit ? "Edit Project" : "New Project"}
      </h1>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Basic Info */}
        <FormField label="Title" required error={errors.title}>
          <input
            type="text"
            className="input input-bordered w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="My Awesome Game"
          />
        </FormField>

        {!isEdit && (
          <FormField label="Slug" required error={errors.slug}>
            <input
              type="text"
              className="input input-bordered w-full"
              value={projectSlug}
              onChange={(e) => {
                setProjectSlug(e.target.value);
                setSlugManual(true);
              }}
              placeholder="my-awesome-game"
            />
            <p className="text-xs text-base-content/50 mt-1">
              URL: /explore/{projectSlug || "..."}
            </p>
          </FormField>
        )}

        <FormField
          label="Short Description"
          error={errors.shortDescription}
        >
          <input
            type="text"
            className="input input-bordered w-full"
            value={shortDescription}
            onChange={(e) => setShortDescription(e.target.value)}
            maxLength={300}
            placeholder="A brief tagline for your project"
          />
        </FormField>

        <FormField label="Description" error={errors.description}>
          <textarea
            className="textarea textarea-bordered w-full min-h-[150px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Full description of your project (Markdown supported)"
          />
        </FormField>

        {/* Metadata */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="Media Type" error={errors.mediaType}>
            <select
              className="select select-bordered w-full"
              value={mediaType}
              onChange={(e) => setMediaType(e.target.value)}
            >
              <option value="game">Game</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="text">Text</option>
            </select>
          </FormField>

          <FormField label="Tags" error={errors.tags}>
            <input
              type="text"
              className="input input-bordered w-full"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="rpg, pixel-art, roguelike"
            />
            <p className="text-xs text-base-content/50 mt-1">
              Comma-separated
            </p>
          </FormField>
        </div>

        {/* Pricing */}
        <FormField label="Pricing" error={errors.pricingType}>
          <select
            className="select select-bordered w-full"
            value={pricingType}
            onChange={(e) => setPricingType(e.target.value)}
          >
            <option value="free">Free</option>
            <option value="paid">Paid</option>
          </select>
        </FormField>

        {pricingType === "paid" && (
          <FormField label="Price ($)" error={errors.price}>
            <input
              type="number"
              className="input input-bordered w-full"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              min="0.50"
              step="0.01"
              placeholder="9.99"
            />
          </FormField>
        )}

        {/* Cover Image */}
        <FormField label="Cover Image" error={errors.coverImage}>
          <FileUpload
            accept="image/*"
            maxSize={10 * 1024 * 1024}
            preview={coverPreview}
            label="Upload cover image (recommended 630x500)"
            onFileSelect={(file) => {
              setCoverFile(file);
              setCoverPreview(URL.createObjectURL(file));
            }}
            onClear={() => {
              setCoverFile(null);
              setCoverPreview(null);
            }}
          />
        </FormField>

        {/* Screenshots (edit mode only) */}
        {isEdit && (
          <div className="form-control w-full">
            <label className="label">
              <span className="label-text">Screenshots</span>
            </label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-2">
              {screenshots.map((ss) => (
                <div key={ss.id} className="relative group">
                  <img
                    src={ss.image}
                    alt={ss.caption || "Screenshot"}
                    className="w-full h-24 object-cover rounded"
                  />
                  <button
                    type="button"
                    className="btn btn-circle btn-xs btn-error absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleScreenshotDelete(ss.id)}
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            <FileUpload
              accept="image/*"
              maxSize={10 * 1024 * 1024}
              label="Add screenshot"
              compact
              onFileSelect={handleScreenshotUpload}
            />
          </div>
        )}

        {/* Links */}
        <FormField label="Embed URL" error={errors.embedUrl}>
          <input
            type="url"
            className="input input-bordered w-full"
            value={embedUrl}
            onChange={(e) => setEmbedUrl(e.target.value)}
            placeholder="https://example.com/game/embed"
          />
          <p className="text-xs text-base-content/50 mt-1">
            URL for HTML5/WebGL game embed (sandboxed iframe)
          </p>
        </FormField>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="Website URL" error={errors.websiteUrl}>
            <input
              type="url"
              className="input input-bordered w-full"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://mygame.com"
            />
          </FormField>

          <FormField label="Source Code URL" error={errors.sourceUrl}>
            <input
              type="url"
              className="input input-bordered w-full"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://github.com/..."
            />
          </FormField>
        </div>

        {/* Publish */}
        <div className="form-control">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={isPublished}
              onChange={(e) => setIsPublished(e.target.checked)}
            />
            <div>
              <span className="label-text font-medium">Publish</span>
              <p className="text-xs text-base-content/50 mt-0.5">
                Published projects are visible to everyone
              </p>
            </div>
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
                ? "Update Project"
                : "Create Project"}
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

import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Project, Asset } from "../lib/api";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import { TrashIcon, ArrowUpTrayIcon } from "@heroicons/react/24/outline";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function BuildsPage() {
  const { slug } = useParams<{ slug: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload form
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState("windows");
  const [version, setVersion] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!slug) return;
    api
      .get<Project>(`/api/v1/content/projects/${slug}/`)
      .then(setProject)
      .catch(() => setError("Failed to load project."))
      .finally(() => setLoading(false));
  }, [slug]);

  const handleUpload = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!file || !slug) return;
      setUploading(true);
      setError(null);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("filename", file.name);
      formData.append("file_size", String(file.size));
      formData.append("mime_type", file.type || "application/octet-stream");
      formData.append("platform", platform);
      formData.append("version", version);

      try {
        const asset = await api.upload<Asset>(
          `/api/v1/content/projects/${slug}/assets/`,
          formData,
        );
        setProject((prev) =>
          prev ? { ...prev, assets: [asset, ...prev.assets] } : prev,
        );
        setFile(null);
        setVersion("");
      } catch {
        setError("Failed to upload build.");
      } finally {
        setUploading(false);
      }
    },
    [file, slug, platform, version],
  );

  const handleDelete = useCallback(
    async (assetId: number) => {
      if (!slug) return;
      try {
        await api.delete(`/api/v1/content/projects/${slug}/assets/${assetId}/`);
        setProject((prev) =>
          prev
            ? { ...prev, assets: prev.assets.filter((a) => a.id !== assetId) }
            : prev,
        );
      } catch {
        setError("Failed to delete build.");
      }
    },
    [slug],
  );

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-error">{error || "Project not found."}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Link to="/dashboard" className="link text-sm">
          Dashboard
        </Link>
        <span className="text-base-content/30">/</span>
        <h1 className="text-2xl font-bold">{project.title}—Builds</h1>
      </div>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      {/* Upload form */}
      <div className="card bg-base-200 mb-8">
        <div className="card-body">
          <h2 className="card-title text-lg">Upload Build</h2>
          <form
            onSubmit={handleUpload}
            className="flex flex-col sm:flex-row gap-3 items-end"
          >
            <div className="flex-1">
              <FormField label="File">
                <input
                  type="file"
                  className="file-input file-input-bordered w-full"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </FormField>
            </div>
            <FormField label="Platform">
              <select
                className="select select-bordered"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              >
                <option value="windows">Windows</option>
                <option value="mac">macOS</option>
                <option value="linux">Linux</option>
                <option value="web">Web</option>
                <option value="android">Android</option>
                <option value="ios">iOS</option>
                <option value="other">Other</option>
              </select>
            </FormField>
            <FormField label="Version">
              <input
                type="text"
                className="input input-bordered w-28"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </FormField>
            <button
              type="submit"
              className={`btn btn-primary ${uploading || !file ? "btn-disabled" : ""}`}
              disabled={uploading || !file}
            >
              {uploading ? (
                <LoadingSpinner size="sm" />
              ) : (
                <ArrowUpTrayIcon className="w-4 h-4" />
              )}
              Upload
            </button>
          </form>
        </div>
      </div>

      {/* Existing builds */}
      {project.assets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Platform</th>
                <th>Version</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {project.assets.map((asset) => (
                <tr key={asset.id}>
                  <td className="font-mono text-sm">{asset.filename}</td>
                  <td>
                    <span className="badge badge-sm badge-outline capitalize">
                      {asset.platform}
                    </span>
                  </td>
                  <td>{asset.version || "—"}</td>
                  <td className="text-sm text-base-content/60">
                    {formatFileSize(asset.file_size)}
                  </td>
                  <td className="text-sm text-base-content/60">
                    {new Date(asset.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => handleDelete(asset.id)}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<ArrowUpTrayIcon className="w-12 h-12" />}
          title="No builds uploaded"
          description="Upload your first build above."
        />
      )}
    </div>
  );
}

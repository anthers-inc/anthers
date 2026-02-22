import { useState } from "react";
import { useAuth } from "../lib/auth";
import { api, ApiError } from "../lib/api";
import FormField from "../components/ui/FormField";
import FileUpload from "../components/ui/FileUpload";

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();

  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [bio, setBio] = useState(user?.bio || "");
  const [websiteUrl, setWebsiteUrl] = useState(user?.website_url || "");
  const [location, setLocation] = useState(user?.location || "");
  const [isCreator, setIsCreator] = useState(user?.is_creator || false);

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    user?.avatar || null,
  );
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [headerPreview, setHeaderPreview] = useState<string | null>(
    user?.header_image || null,
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);
    setErrors({});

    try {
      const formData = new FormData();
      formData.append("display_name", displayName);
      formData.append("bio", bio);
      formData.append("website_url", websiteUrl);
      formData.append("location", location);
      formData.append("is_creator", String(isCreator));
      if (avatarFile) formData.append("avatar", avatarFile);
      if (headerFile) formData.append("header_image", headerFile);

      await api.uploadPatch("/api/v1/accounts/me/", formData);
      await refreshUser();
      setSuccess(true);
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
        setError("Failed to save settings.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="alert alert-success mb-4">
          <span>Settings saved successfully.</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FormField label="Display Name" error={errors.display_name}>
          <input
            type="text"
            className="input input-bordered w-full"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={150}
          />
        </FormField>

        <FormField label="Bio" error={errors.bio}>
          <textarea
            className="textarea textarea-bordered w-full"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
        </FormField>

        <FormField label="Avatar" error={errors.avatar}>
          <FileUpload
            accept="image/*"
            maxSize={5 * 1024 * 1024}
            preview={avatarPreview}
            label="Upload avatar image"
            compact
            onFileSelect={(file) => {
              setAvatarFile(file);
              setAvatarPreview(URL.createObjectURL(file));
            }}
            onClear={() => {
              setAvatarFile(null);
              setAvatarPreview(null);
            }}
          />
        </FormField>

        <FormField label="Header Image" error={errors.header_image}>
          <FileUpload
            accept="image/*"
            maxSize={10 * 1024 * 1024}
            preview={headerPreview}
            label="Upload header/banner image"
            onFileSelect={(file) => {
              setHeaderFile(file);
              setHeaderPreview(URL.createObjectURL(file));
            }}
            onClear={() => {
              setHeaderFile(null);
              setHeaderPreview(null);
            }}
          />
        </FormField>

        <FormField label="Website URL" error={errors.website_url}>
          <input
            type="url"
            className="input input-bordered w-full"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="https://example.com"
          />
        </FormField>

        <FormField label="Location" error={errors.location}>
          <input
            type="text"
            className="input input-bordered w-full"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={100}
          />
        </FormField>

        <div className="form-control">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={isCreator}
              onChange={(e) => setIsCreator(e.target.checked)}
            />
            <div>
              <span className="label-text font-medium">
                Enable creator mode
              </span>
              <p className="text-xs text-base-content/50 mt-0.5">
                Allows you to publish projects and posts
              </p>
            </div>
          </label>
        </div>

        <div className="mt-2">
          <button
            type="submit"
            className={`btn btn-primary ${saving ? "btn-disabled" : ""}`}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </form>
    </div>
  );
}

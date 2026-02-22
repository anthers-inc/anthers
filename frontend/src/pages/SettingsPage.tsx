import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, ApiError, type StripeAccountStatus } from "../lib/api";
import FormField from "../components/ui/FormField";
import FileUpload from "../components/ui/FileUpload";

function StripeOnboardingSection() {
  const [stripeStatus, setStripeStatus] = useState<StripeAccountStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [searchParams] = useSearchParams();

  const stripeResult = searchParams.get("stripe");

  useEffect(() => {
    api
      .get<StripeAccountStatus>("/api/v1/payments/stripe/onboard/")
      .then(setStripeStatus)
      .catch(() => setStripeStatus(null))
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await api.post<{ url: string }>(
        "/api/v1/payments/stripe/onboard/",
      );
      window.location.href = res.url;
    } catch {
      setConnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="card bg-base-200">
        <div className="card-body">
          <h3 className="card-title text-lg">Stripe Payments</h3>
          <p className="text-sm text-base-content/60">Loading...</p>
        </div>
      </div>
    );
  }

  const isConnected =
    stripeStatus?.charges_enabled && stripeStatus?.onboarding_complete;
  const isIncomplete =
    stripeStatus && !stripeStatus.charges_enabled;

  return (
    <div className="card bg-base-200">
      <div className="card-body">
        <h3 className="card-title text-lg">Stripe Payments</h3>

        {stripeResult === "complete" && !isConnected && (
          <div className="alert alert-info text-sm">
            <span>
              Stripe onboarding submitted. It may take a moment for your account
              to be fully activated.
            </span>
          </div>
        )}

        {stripeResult === "refresh" && (
          <div className="alert alert-warning text-sm">
            <span>
              Stripe onboarding link expired. Click below to continue.
            </span>
          </div>
        )}

        {isConnected ? (
          <div className="flex items-center gap-2">
            <div className="badge badge-success">Connected</div>
            <span className="text-sm text-base-content/60">
              Your Stripe account is active and ready to receive payments.
            </span>
          </div>
        ) : isIncomplete ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-base-content/60">
              Your Stripe account setup is incomplete. Complete onboarding to
              start receiving payments.
            </p>
            <button
              className={`btn btn-primary btn-sm w-fit ${connecting ? "btn-disabled" : ""}`}
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? "Redirecting..." : "Complete Stripe Setup"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-base-content/60">
              Connect a Stripe account to receive payments for your paid
              projects. Bluebell uses Stripe Connect — you keep 100% of
              earnings, only real costs are passed through.
            </p>
            <button
              className={`btn btn-primary btn-sm w-fit ${connecting ? "btn-disabled" : ""}`}
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? "Redirecting..." : "Connect Stripe"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

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

      {/* Stripe Onboarding — only shown for creators */}
      {isCreator && (
        <div className="mt-8">
          <StripeOnboardingSection />
        </div>
      )}
    </div>
  );
}

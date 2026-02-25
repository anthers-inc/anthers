import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type SubscriptionStatus } from "../lib/api";

export default function SubscriptionPage() {
  const [searchParams] = useSearchParams();
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const sessionId = searchParams.get("session_id");

  useEffect(() => {
    fetchSubscription();
  }, []);

  useEffect(() => {
    if (sessionId) {
      setSuccess(
        "Subscription activated! Welcome aboard. It may take a moment for your plan to update.",
      );
      // Re-fetch after a short delay for webhook processing
      const timer = setTimeout(fetchSubscription, 2000);
      return () => clearTimeout(timer);
    }
  }, [sessionId]);

  async function fetchSubscription() {
    try {
      const data = await api.get<SubscriptionStatus>(
        "/api/v1/subscriptions/me/",
      );
      setSub(data);
    } catch {
      setError("Failed to load subscription.");
    } finally {
      setLoading(false);
    }
  }

  const handleCancel = async () => {
    setActionLoading("cancel");
    setError(null);
    try {
      const data = await api.post<SubscriptionStatus>(
        "/api/v1/subscriptions/cancel/",
      );
      setSub(data);
      setSuccess("Your subscription will cancel at the end of the current billing period.");
    } catch {
      setError("Failed to cancel subscription.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async () => {
    setActionLoading("resume");
    setError(null);
    try {
      const data = await api.post<SubscriptionStatus>(
        "/api/v1/subscriptions/resume/",
      );
      setSub(data);
      setSuccess("Subscription resumed.");
    } catch {
      setError("Failed to resume subscription.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleBillingPortal = async () => {
    setActionLoading("portal");
    try {
      const res = await api.post<{ portal_url: string }>(
        "/api/v1/subscriptions/billing-portal/",
      );
      window.location.href = res.portal_url;
    } catch {
      setError("Failed to open billing portal.");
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (!sub) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">No Subscription</h1>
        <p className="mb-4">You don't have an active subscription yet.</p>
        <Link to="/subscribe" className="btn btn-primary">
          Choose a Plan
        </Link>
      </div>
    );
  }

  const isPaid = sub.is_paid;
  const isCanceling = !!sub.canceled_at;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Your Subscription</h1>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="alert alert-success mb-4">
          <span>{success}</span>
        </div>
      )}

      {/* Current Plan Card */}
      <div className="card bg-base-200 mb-6">
        <div className="card-body">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="card-title">{sub.tier_display} Plan</h2>
              <div className="flex items-center gap-2 mt-1">
                {sub.is_active ? (
                  <div className="badge badge-success badge-sm">Active</div>
                ) : (
                  <div className="badge badge-error badge-sm">Inactive</div>
                )}
                {isCanceling && (
                  <div className="badge badge-warning badge-sm">
                    Cancels at period end
                  </div>
                )}
              </div>
            </div>
            {!isPaid && (
              <Link to="/subscribe" className="btn btn-primary btn-sm">
                Upgrade
              </Link>
            )}
          </div>

          {isPaid && (
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Creator Pool
                </div>
                <div className="text-lg font-semibold">
                  ${sub.creator_pool_amount}/mo
                </div>
              </div>
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Boost Pool
                </div>
                <div className="text-lg font-semibold">
                  {parseFloat(sub.boost_pool_amount) > 0
                    ? `$${sub.boost_pool_amount}/mo`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Content Hours
                </div>
                <div className="text-lg font-semibold">
                  {sub.monthly_content_hours
                    ? `${sub.monthly_content_hours} hrs/mo`
                    : "Unlimited"}
                </div>
              </div>
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Gate Access
                </div>
                <div className="text-lg font-semibold">
                  {sub.has_gate_access ? (
                    <span className="text-success">Yes</span>
                  ) : (
                    "No"
                  )}
                </div>
              </div>
            </div>
          )}

          {sub.current_period_end && (
            <div className="text-sm text-base-content/60 mt-4">
              {isCanceling ? "Access until" : "Next billing date"}:{" "}
              <span className="font-medium">
                {new Date(sub.current_period_end).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {isPaid && (
        <div className="flex flex-wrap gap-3">
          <Link to="/subscribe" className="btn btn-outline btn-sm">
            Change Plan
          </Link>

          {isCanceling ? (
            <button
              className={`btn btn-success btn-sm ${
                actionLoading === "resume" ? "btn-disabled" : ""
              }`}
              onClick={handleResume}
              disabled={!!actionLoading}
            >
              {actionLoading === "resume" ? "Resuming..." : "Resume Subscription"}
            </button>
          ) : (
            <button
              className={`btn btn-outline btn-error btn-sm ${
                actionLoading === "cancel" ? "btn-disabled" : ""
              }`}
              onClick={handleCancel}
              disabled={!!actionLoading}
            >
              {actionLoading === "cancel" ? "Canceling..." : "Cancel Subscription"}
            </button>
          )}

          <button
            className={`btn btn-ghost btn-sm ${
              actionLoading === "portal" ? "btn-disabled" : ""
            }`}
            onClick={handleBillingPortal}
            disabled={!!actionLoading}
          >
            {actionLoading === "portal"
              ? "Opening..."
              : "Manage Billing"}
          </button>
        </div>
      )}

      {/* Pool Distribution Preview (placeholder for Phase 4C) */}
      {isPaid && (
        <div className="mt-8">
          <h2 className="text-lg font-bold mb-3">
            This Month's Creator Support
          </h2>
          <div className="card bg-base-200">
            <div className="card-body text-center text-base-content/60">
              <p>
                Pool distribution details will appear here once attention
                tracking is active.
              </p>
              <p className="text-sm mt-1">
                Your ${sub.creator_pool_amount} creator pool will be distributed
                proportionally based on the content you watch, read, and listen to.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

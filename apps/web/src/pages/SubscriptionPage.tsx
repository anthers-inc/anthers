import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type {
  Subscription,
  AttentionSummary,
  PoolDistribution,
} from "../lib/types";

export default function SubscriptionPage() {
  const [searchParams] = useSearchParams();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [attention, setAttention] = useState<AttentionSummary | null>(null);
  const [distributions, setDistributions] = useState<{
    distributions: PoolDistribution[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const sessionId = searchParams.get("session_id");

  useEffect(() => {
    fetchSubscription();
    fetchAttention();
    fetchDistributions();
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
      const res = await client.api.subscriptions.me.$get();
      const data = (await res.json()) as { subscription: Subscription };
      setSub(data.subscription);
    } catch {
      setError("Failed to load subscription.");
    } finally {
      setLoading(false);
    }
  }

  async function fetchAttention() {
    try {
      const res = await client.api.subscriptions.attention.summary.$get();
      const data = (await res.json()) as AttentionSummary;
      setAttention(data);
    } catch {
      // Non-critical—don't show error
    }
  }

  async function fetchDistributions() {
    try {
      const res = await client.api.subscriptions.distributions.$get();
      const data = (await res.json()) as {
        distributions: PoolDistribution[];
      };
      setDistributions(data);
    } catch {
      // Non-critical
    }
  }

  const handleCancel = async () => {
    setActionLoading("cancel");
    setError(null);
    try {
      const res = await client.api.subscriptions.cancel.$post();
      const data = (await res.json()) as { subscription: Subscription };
      setSub(data.subscription);
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
      const res = await client.api.subscriptions.resume.$post();
      const data = (await res.json()) as { subscription: Subscription };
      setSub(data.subscription);
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
      const res = await client.api.subscriptions["billing-portal"].$post();
      const data = (await res.json()) as { portalUrl: string };
      window.location.href = data.portalUrl;
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

  const isPaid = sub.tier !== "free";
  const isCanceling = !!sub.canceledAt;

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
              <h2 className="card-title">{sub.tier.charAt(0).toUpperCase() + sub.tier.slice(1)} Plan</h2>
              <div className="flex items-center gap-2 mt-1">
                {sub.isActive ? (
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

          {/* Content Hours Usage */}
          {attention && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-base-content/60">Content Hours Used</span>
                <span className="font-medium">
                  {attention.hoursUsed} hrs
                </span>
              </div>
            </div>
          )}

          {sub.currentPeriodEnd && (
            <div className="text-sm text-base-content/60 mt-4">
              {isCanceling ? "Access until" : "Next billing date"}:{" "}
              <span className="font-medium">
                {new Date(sub.currentPeriodEnd).toLocaleDateString()}
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

      {/* Pool Distribution */}
      {isPaid && (
        <div className="mt-8">
          <h2 className="text-lg font-bold mb-3">
            This Month's Creator Support
          </h2>
          {distributions && distributions.distributions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Creator</th>
                    <th className="text-right">Time</th>
                    <th className="text-right">Pool</th>
                    <th className="text-right">Boost</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {distributions.distributions.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link
                          to={`/${d.creator?.username}`}
                          className="link link-hover"
                        >
                          {d.creator?.displayName || d.creator?.username}
                        </Link>
                      </td>
                      <td className="text-right text-base-content/60">
                        {Math.round((d.attentionSeconds ?? 0) / 60)}m
                      </td>
                      <td className="text-right">${d.poolAmount}</td>
                      <td className="text-right">
                        {parseFloat(d.boostAmount) > 0
                          ? `$${d.boostAmount}`
                          : "—"}
                      </td>
                      <td className="text-right font-medium">
                        ${(
                          parseFloat(d.poolAmount) +
                          parseFloat(d.boostAmount)
                        ).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card bg-base-200">
              <div className="card-body text-center text-base-content/60">
                <p>No distributions yet this cycle.</p>
                <p className="text-sm mt-1">
                  Your creator pool will be distributed proportionally based
                  on the content you watch, read, and listen to.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import {
  api,
  type SubscriptionTierOption,
  type SubscriptionStatus,
} from "../lib/api";

const TIER_HIGHLIGHTS: Record<string, string[]> = {
  free: [
    "Browse and discover creators",
    "10 hours/month content access",
    "Follow creators and get updates",
  ],
  root: [
    "25 hours/month content access",
    "Support creators through attention-based pool",
    "$4.85/mo goes directly to creators you engage with",
  ],
  sprout: [
    "Unlimited content access",
    "$4.70/mo creator pool + $5.00 boost pool",
    "Manually boost your favorite creators",
    "Access gated/exclusive content",
  ],
  petal: [
    "Unlimited content access",
    "$4.55/mo creator pool + $10.00 boost pool",
    "More boost budget for creators you love",
    "Access gated/exclusive content",
  ],
  bloom: [
    "Unlimited content access",
    "$4.40/mo creator pool + $15.00 boost pool",
    "Maximum support for your creators",
    "Access gated/exclusive content",
  ],
};

function TierCard({
  tier,
  currentTier,
  onSelect,
  subscribing,
}: {
  tier: SubscriptionTierOption;
  currentTier: string;
  onSelect: (tier: string) => void;
  subscribing: string | null;
}) {
  const isCurrentTier = tier.tier === currentTier;
  const isFree = tier.tier === "free";
  const price = parseFloat(tier.price);

  return (
    <div
      className={`card bg-base-200 border-2 transition-all border-base-300 ${
        isCurrentTier ? "ring-2 ring-success" : ""
      }`}
    >
      <div className="card-body">
        <h3 className="card-title text-lg">{tier.name}</h3>

        <div className="flex items-baseline gap-1 my-2">
          <span className="text-3xl font-bold">
            {isFree ? "Free" : `$${price}`}
          </span>
          {!isFree && (
            <span className="text-sm text-base-content/60">/month</span>
          )}
        </div>

        <div className="divider my-1" />

        <ul className="space-y-2 text-sm flex-grow">
          {TIER_HIGHLIGHTS[tier.tier]?.map((highlight, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-success mt-0.5">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </span>
              <span>{highlight}</span>
            </li>
          ))}
        </ul>

        {!isFree && (
          <div className="text-xs text-base-content/50 mt-2">
            <p>
              Creator Pool: ${tier.creator_pool}/mo
              {parseFloat(tier.boost_pool) > 0 && (
                <> &middot; Boost Pool: ${tier.boost_pool}/mo</>
              )}
            </p>
            {tier.content_hours ? (
              <p>{tier.content_hours} hrs/mo content</p>
            ) : (
              <p>Unlimited content</p>
            )}
          </div>
        )}

        <div className="card-actions mt-4">
          {isCurrentTier ? (
            <button className="btn btn-success btn-sm w-full" disabled>
              Current Plan
            </button>
          ) : isFree ? (
            <button className="btn btn-ghost btn-sm w-full" disabled>
              Default Tier
            </button>
          ) : (
            <button
              className={`btn btn-sm w-full btn-outline btn-primary ${
                subscribing === tier.tier ? "btn-disabled" : ""
              }`}
              onClick={() => onSelect(tier.tier)}
              disabled={!!subscribing}
            >
              {subscribing === tier.tier
                ? "Redirecting..."
                : currentTier !== "free"
                  ? `Switch to ${tier.name}`
                  : `Subscribe`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SubscribePage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();

  const [tiers, setTiers] = useState<SubscriptionTierOption[]>([]);
  const [currentSub, setCurrentSub] = useState<SubscriptionStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wasCanceled = searchParams.get("canceled") === "true";

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tierList, sub] = await Promise.all([
          api.get<SubscriptionTierOption[]>(
            "/api/v1/subscriptions/tiers/",
          ),
          user
            ? api.get<SubscriptionStatus>("/api/v1/subscriptions/me/")
            : Promise.resolve(null),
        ]);
        setTiers(tierList);
        setCurrentSub(sub);
      } catch {
        setError("Failed to load subscription info.");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [user]);

  const handleSelect = async (tier: string) => {
    if (!user) {
      window.location.href = `/login?next=/subscribe`;
      return;
    }

    setSubscribing(tier);
    setError(null);

    try {
      const res = await api.post<{
        checkout_url?: string;
        tier?: string;
      }>("/api/v1/subscriptions/subscribe/", { tier });

      if (res.checkout_url) {
        window.location.href = res.checkout_url;
      } else {
        // Tier change on existing subscription (no checkout needed)
        const sub = await api.get<SubscriptionStatus>(
          "/api/v1/subscriptions/me/",
        );
        setCurrentSub(sub);
        setSubscribing(null);
      }
    } catch {
      setError("Failed to start subscription. Please try again.");
      setSubscribing(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  const currentTier = currentSub?.tier || "free";

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Choose Your Plan</h1>
        <p className="text-base-content/70 max-w-xl mx-auto">
          Your subscription directly funds the creators you engage with.
          No algorithms, no middlemen — just transparent, attention-based
          support.
        </p>
      </div>

      {wasCanceled && (
        <div className="alert alert-warning mb-6 max-w-lg mx-auto">
          <span>Checkout was canceled. You can try again anytime.</span>
        </div>
      )}

      {error && (
        <div className="alert alert-error mb-6 max-w-lg mx-auto">
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-12">
        {tiers.map((tier) => (
          <TierCard
            key={tier.tier}
            tier={tier}
            currentTier={currentTier}
            onSelect={handleSelect}
            subscribing={subscribing}
          />
        ))}
      </div>

      {/* Detailed comparison table */}
      <div className="overflow-x-auto">
        <h2 className="text-xl font-bold mb-4 text-center">
          Compare All Plans
        </h2>
        <table className="table table-zebra w-full">
          <thead>
            <tr>
              <th>Feature</th>
              {tiers.map((t) => (
                <th
                  key={t.tier}
                  className={`text-center ${
                    t.tier === currentTier ? "bg-success/10" : ""
                  }`}
                >
                  {t.name}
                  {t.tier === currentTier && (
                    <div className="badge badge-success badge-xs ml-1">
                      You
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="font-medium">Monthly Price</td>
              {tiers.map((t) => (
                <td key={t.tier} className="text-center">
                  {parseFloat(t.price) === 0
                    ? "Free"
                    : `$${parseFloat(t.price)}`}
                </td>
              ))}
            </tr>
            <tr>
              <td className="font-medium">Content Hours</td>
              {tiers.map((t) => (
                <td key={t.tier} className="text-center">
                  {t.content_hours ? `${t.content_hours} hrs` : "Unlimited"}
                </td>
              ))}
            </tr>
            <tr>
              <td className="font-medium">Creator Pool</td>
              {tiers.map((t) => (
                <td key={t.tier} className="text-center">
                  {parseFloat(t.creator_pool) > 0
                    ? `$${t.creator_pool}`
                    : "—"}
                </td>
              ))}
            </tr>
            <tr>
              <td className="font-medium">Boost Pool</td>
              {tiers.map((t) => (
                <td key={t.tier} className="text-center">
                  {parseFloat(t.boost_pool) > 0
                    ? `$${t.boost_pool}`
                    : "—"}
                </td>
              ))}
            </tr>
            <tr>
              <td className="font-medium">Gate Access</td>
              {tiers.map((t) => (
                <td key={t.tier} className="text-center">
                  {t.gate_access ? (
                    <span className="text-success">Yes</span>
                  ) : (
                    "—"
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* How it works section */}
      <div className="mt-16 max-w-4xl mx-auto">
        <h2 className="text-xl font-bold mb-2 text-center">
          How it Works
        </h2>
        <p className="text-sm text-base-content/60 text-center mb-8 max-w-2xl mx-auto">
          Every paid subscription is split into three transparent layers.
          You always know where your money goes.
        </p>

        {/* Visual bar breakdown — example: Sprout @ $10/mo */}
        <div className="card bg-base-200 p-5 mb-8">
          <p className="text-xs text-base-content/50 uppercase tracking-wider mb-3">
            Example: Sprout plan &mdash; $10/mo
          </p>
          {/* Proportional bar */}
          <div className="flex rounded-lg overflow-hidden h-10 text-xs font-medium">
            {/* CRF 3% */}
            <div
              className="bg-neutral text-neutral-content flex items-center justify-center"
              style={{ width: "3%" }}
              title="Community Resilience Fund — $0.30"
            />
            {/* Creator Pool ~47% */}
            <div
              className="bg-success text-success-content flex items-center justify-center"
              style={{ width: "47%" }}
            >
              Creator Pool
            </div>
            {/* Boost Pool 50% */}
            <div
              className="bg-primary text-primary-content flex items-center justify-center"
              style={{ width: "50%" }}
            >
              Boost Pool
            </div>
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs text-base-content/60">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-neutral inline-block" />
              CRF &mdash; $0.30
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-success inline-block" />
              Creator Pool &mdash; $4.70
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-primary inline-block" />
              Boost Pool &mdash; $5.00
            </span>
          </div>
        </div>

        {/* Layer detail rows */}
        <div className="space-y-4">
          {/* Layer 1 — CRF */}
          <div className="flex gap-4 items-start">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-neutral text-neutral-content flex items-center justify-center mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-sm">
                Community Resilience Fund
                <span className="font-normal text-base-content/40 ml-2">3%</span>
              </h3>
              <p className="text-sm text-base-content/60 mt-0.5">
                Covers free-tier infrastructure, shields creators from viral
                traffic spikes, and subsidizes small creators whose earnings
                don't yet cover hosting costs.
              </p>
            </div>
          </div>

          {/* Layer 2 — Creator Pool */}
          <div className="flex gap-4 items-start">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-success text-success-content flex items-center justify-center mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-sm">
                Creator Pool
                <span className="font-normal text-base-content/40 ml-2">automatic &middot; watch-time proportional</span>
              </h3>
              <p className="text-sm text-base-content/60 mt-0.5">
                Distributed to every creator you engage with, proportional to
                the time you spend watching, reading, listening, or playing.
                No action needed — it happens in the background.
              </p>
            </div>
          </div>

          {/* Layer 3 — Boost Pool */}
          <div className="flex gap-4 items-start">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary text-primary-content flex items-center justify-center mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-sm">
                Boost Pool
                <span className="font-normal text-base-content/40 ml-2">Sprout+ &middot; manual or auto</span>
              </h3>
              <p className="text-sm text-base-content/60 mt-0.5">
                Extra funds you can direct to specific creators with sliders.
                Your boost to each creator determines which gated content you
                unlock. Left untouched, it follows the same watch-time split
                as the Creator Pool.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

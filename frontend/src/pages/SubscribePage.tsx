import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import {
  api,
  type SubscriptionTierOption,
  type SubscriptionStatus,
} from "../lib/api";

const TIER_HIGHLIGHTS: Record<string, string[]> = {
  window: [
    "Browse and discover creators",
    "10 hours/month content access",
    "Follow creators and get updates",
  ],
  base: [
    "25 hours/month content access",
    "Support creators through attention-based pool",
    "$4.85/mo goes directly to creators you engage with",
  ],
  supporter: [
    "Unlimited content access",
    "$4.70/mo creator pool + $5.00 boost pool",
    "Manually boost your favorite creators",
    "Access gated/exclusive content",
  ],
  advocate: [
    "Unlimited content access",
    "$4.55/mo creator pool + $10.00 boost pool",
    "More boost budget for creators you love",
    "Access gated/exclusive content",
  ],
  champion: [
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
  const isFree = tier.tier === "window";
  const isPopular = tier.tier === "supporter";
  const price = parseFloat(tier.price);

  return (
    <div
      className={`card bg-base-200 border-2 transition-all ${
        isPopular ? "border-primary shadow-lg scale-105" : "border-base-300"
      } ${isCurrentTier ? "ring-2 ring-success" : ""}`}
    >
      <div className="card-body">
        {isPopular && (
          <div className="badge badge-primary badge-sm self-end">
            Most Popular
          </div>
        )}

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
              className={`btn btn-sm w-full ${isPopular ? "btn-primary" : "btn-outline btn-primary"} ${
                subscribing === tier.tier ? "btn-disabled" : ""
              }`}
              onClick={() => onSelect(tier.tier)}
              disabled={!!subscribing}
            >
              {subscribing === tier.tier
                ? "Redirecting..."
                : currentTier !== "window"
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

  const currentTier = currentSub?.tier || "window";

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
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
      <div className="mt-12 max-w-3xl mx-auto">
        <h2 className="text-xl font-bold mb-4 text-center">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="card bg-base-200">
            <div className="card-body text-center">
              <div className="text-3xl mb-2">1</div>
              <h3 className="font-bold">Subscribe</h3>
              <p className="text-sm text-base-content/70">
                Pick a tier. Your subscription is split into a Creator Pool
                and a Boost Pool.
              </p>
            </div>
          </div>
          <div className="card bg-base-200">
            <div className="card-body text-center">
              <div className="text-3xl mb-2">2</div>
              <h3 className="font-bold">Engage</h3>
              <p className="text-sm text-base-content/70">
                Watch, read, listen, play. Your Creator Pool is distributed
                proportionally to the creators you spend time with.
              </p>
            </div>
          </div>
          <div className="card bg-base-200">
            <div className="card-body text-center">
              <div className="text-3xl mb-2">3</div>
              <h3 className="font-bold">Boost</h3>
              <p className="text-sm text-base-content/70">
                Supporter+ tiers get a Boost Pool. Manually allocate extra
                funds to your favorite creators and unlock gated content.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

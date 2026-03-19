import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Sankey,
  ResponsiveContainer,
  Layer,
  Rectangle,
  useChartWidth,
  type SankeyNodeProps,
  type SankeyLinkProps,
} from "recharts";
import { useAuth } from "../lib/auth";
import { client } from "../lib/rpc";
import type { SubscriptionTierOption, Subscription } from "../lib/types";

/** Each tier's highlights are framed as what changes from the previous tier. */
const TIER_HIGHLIGHTS: Record<
  string,
  { included: string[]; upgrade?: string }
> = {
  free: {
    included: [
      "Browse and discover creators",
      "10 hours/month content access",
      "Follow creators and get updates",
    ],
  },
  root: {
    upgrade: "Everything in Free, plus:",
    included: [
      "25 hours/month content access",
      "Creator Pool—funds every creator you engage with",
      "92% to creators, 8% to the Anthers Foundation",
    ],
  },
  sprout: {
    upgrade: "Everything in Root, plus:",
    included: [
      "Unlimited content access",
      "Boost Pool—direct extra funds to your favorite creators",
      "Access gated/exclusive content",
    ],
  },
  petal: {
    upgrade: "Everything in Sprout, plus:",
    included: [
      "Double the Boost Pool budget",
      "More support for the creators you love",
    ],
  },
  bloom: {
    upgrade: "Everything in Petal, plus:",
    included: [
      "Triple the Boost Pool budget",
      "Maximum direct support for your creators",
    ],
  },
};

/* ------------------------------------------------------------------ */
/*  Sankey diagram—"Where Your Money Goes" visualization            */
/* ------------------------------------------------------------------ */

/** Tier configuration for Sankey generation. */
interface SankeyTierConfig {
  id: string;
  name: string;
  price: number;
  boostBudget: number;
  delivery: number;
}

const SANKEY_TIERS: SankeyTierConfig[] = [
  { id: "root",   name: "Root",   price: 3,  boostBudget: 0,     delivery: 1.65 },
  { id: "sprout", name: "Sprout", price: 7,  boostBudget: 3.68,  delivery: 1.65 },
  { id: "petal",  name: "Petal",  price: 15, boostBudget: 11.04, delivery: 1.65 },
  { id: "bloom",  name: "Bloom",  price: 30, boostBudget: 24.84, delivery: 1.65 },
];

/* Allocation percentages (fixed across all tiers). */
const ALLOC = {
  creators: 0.92,
  foundation: 0.08,
  /* Foundation sub-splits (proportions of Foundation total). */
  foundationPrograms: 0.60,
  foundationOps: 0.40,
  /* Creator Pool engagement-time share (proportional — same as viewing). */
  poolA: 0.51,
  poolB: 0.26,
  poolC: 0.23,
  /* Boost Pool share (disproportional — user has manually boosted Creator A). */
  boostA: 0.68,
  boostB: 0.20,
  boostC: 0.12,
};

/** Round to 2 decimal places (financial display). */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

const COLORS = {
  pool:       "#2563eb",  // Creator Pool—blue-600
  boost:      "#c026d3",  // Boost Pool—fuchsia-600
  muted:      "#a3a3a3",  // neutral / subscription node
  // Creator flow—decreasing shades of violet
  crA:        "#4c1d95",  // Creator A—violet-900
  crB:        "#6d28d9",  // Creator B—violet-700
  crC:        "#8b5cf6",  // Creator C—violet-500
  // Delivery infrastructure—pink
  delivery:   "#db2777",  // Delivery—pink-600
  // Anthers Foundation—teal tones
  foundation: "#0f766e",  // Foundation node—dark teal
  programs:   "#14b8a6",  // Programs—bright teal
  ops:        "#0d9488",  // Operations—medium teal
};

/**
 * Build a Sankey data set + node metadata for a given tier config.
 *
 * Node layout:
 *   0: Your Payment  (subscription + delivery)
 *   1: Subscription
 *   2: Delivery Infrastructure
 *   3: Creator Pool
 *   4: Boost Pool           (omitted for Root)
 *   5: Anthers Foundation
 *   6: Programs              (Foundation sub-split)
 *   7: Operations            (Foundation sub-split)
 *   8: Creator A
 *   9: Creator B
 *  10: Creator C
 *
 * Creator Pool and Boost Pool each flow directly to creators—Pool
 * proportionally (matching engagement time) and Boost disproportionally
 * (reflecting manual boost toward a favorite creator).
 */
function buildSankeyForTier(tier: SankeyTierConfig) {
  const price = tier.price;
  const boost = tier.boostBudget;
  const deliveryAmt = tier.delivery;
  const hasBoost = boost > 0;

  const totalPayment = r2(price + deliveryAmt);
  const creatorTotal = r2(price * ALLOC.creators);
  const foundationTotal = r2(price - creatorTotal); // remainder to avoid rounding drift

  const poolAmount = r2(creatorTotal - boost);
  const boostAmount = boost;

  // Pool → creators (proportional, engagement-time weighted)
  const poolA = r2(poolAmount * ALLOC.poolA);
  const poolB = r2(poolAmount * ALLOC.poolB);
  const poolC = r2(poolAmount - poolA - poolB); // remainder

  // Boost → creators (disproportional, user has boosted Creator A)
  const boostA = hasBoost ? r2(boostAmount * ALLOC.boostA) : 0;
  const boostB = hasBoost ? r2(boostAmount * ALLOC.boostB) : 0;
  const boostC = hasBoost ? r2(boostAmount - boostA - boostB) : 0; // remainder

  // Total per creator (for label display)
  const crA = r2(poolA + boostA);
  const crB = r2(poolB + boostB);
  const crC = r2(poolC + boostC);

  // Foundation sub-splits
  const foundationPrograms = r2(foundationTotal * ALLOC.foundationPrograms);
  const foundationOps = r2(foundationTotal - foundationPrograms); // remainder

  // --- Node index map (always 11 slots) ---
  // Vertical order matters: nodes listed earlier appear higher in the
  // diagram.  Creators are placed before Foundation sub-splits so that
  // pool/boost flows reach creators without crossing the Foundation
  // Programs/Operations flows below.
  const N = {
    PAYMENT: 0,
    SUB: 1,
    DELIVERY: 2,
    CPOOL: 3,
    BOOST: 4,
    CREATOR_A: 5,
    CREATOR_B: 6,
    CREATOR_C: 7,
    FOUNDATION: 8,
    PROGRAMS: 9,
    OPS: 10,
  } as const;

  const nodes = [
    { name: "Your Payment" },
    { name: "Subscription" },
    { name: "Delivery Infrastructure" },
    { name: "Creator Pool" },
    { name: "Boost Pool" },
    { name: "Creator A" },
    { name: "Creator B" },
    { name: "Creator C" },
    { name: "Anthers Foundation" },
    { name: "Programs" },
    { name: "Operations" },
  ];

  const links: { source: number; target: number; value: number }[] = [
    // Your Payment → Subscription + Delivery
    { source: N.PAYMENT, target: N.SUB, value: price },
    { source: N.PAYMENT, target: N.DELIVERY, value: deliveryAmt },

    // Subscription → pools + foundation
    { source: N.SUB, target: N.CPOOL, value: poolAmount },
    ...(hasBoost
      ? [{ source: N.SUB, target: N.BOOST, value: boostAmount }]
      : []),
    { source: N.SUB, target: N.FOUNDATION, value: foundationTotal },

    // Creator Pool → each creator (proportional, engagement-time split)
    { source: N.CPOOL, target: N.CREATOR_A, value: poolA },
    { source: N.CPOOL, target: N.CREATOR_B, value: poolB },
    { source: N.CPOOL, target: N.CREATOR_C, value: poolC },

    // Boost Pool → each creator (disproportional, user-directed)
    ...(hasBoost
      ? [
          { source: N.BOOST, target: N.CREATOR_A, value: boostA },
          { source: N.BOOST, target: N.CREATOR_B, value: boostB },
          { source: N.BOOST, target: N.CREATOR_C, value: boostC },
        ]
      : []),

    // Foundation → Programs + Operations
    { source: N.FOUNDATION, target: N.PROGRAMS, value: foundationPrograms },
    { source: N.FOUNDATION, target: N.OPS, value: foundationOps },
  ];

  const meta: { label: string; sub: string; color: string }[] = [
    { label: "Your Payment",            sub: `${fmt(totalPayment)}/mo`,  color: COLORS.muted },
    { label: "Subscription",            sub: fmt(price),                 color: COLORS.muted },
    { label: "Delivery",                sub: fmt(deliveryAmt),           color: COLORS.delivery },
    { label: "Creator Pool",            sub: fmt(poolAmount),            color: COLORS.pool },
    { label: "Boost Pool",              sub: fmt(boostAmount),           color: COLORS.boost },
    { label: "Creator A",               sub: fmt(crA),                   color: COLORS.crA },
    { label: "Creator B",               sub: fmt(crB),                   color: COLORS.crB },
    { label: "Creator C",               sub: fmt(crC),                   color: COLORS.crC },
    { label: "Anthers Foundation",       sub: fmt(foundationTotal),       color: COLORS.foundation },
    { label: "Programs",                sub: fmt(foundationPrograms),    color: COLORS.programs },
    { label: "Operations",              sub: fmt(foundationOps),         color: COLORS.ops },
  ];

  // Pre-compute link colors
  const linkColors: Record<number, string> = {};
  links.forEach((link, i) => {
    const { source, target } = link;
    if (source === N.PAYMENT) {
      if (target === N.SUB) linkColors[i] = COLORS.muted;
      else if (target === N.DELIVERY) linkColors[i] = COLORS.delivery;
      else linkColors[i] = COLORS.muted;
    } else if (source === N.SUB) {
      if (target === N.CPOOL) linkColors[i] = COLORS.pool;
      else if (target === N.BOOST) linkColors[i] = COLORS.boost;
      else if (target === N.FOUNDATION) linkColors[i] = COLORS.foundation;
      else linkColors[i] = COLORS.muted;
    } else if (source === N.CPOOL) {
      // Pool links to creators use pool color
      linkColors[i] = COLORS.pool;
    } else if (source === N.BOOST) {
      // Boost links to creators use boost color
      linkColors[i] = COLORS.boost;
    } else if (source === N.FOUNDATION) {
      if (target === N.PROGRAMS) linkColors[i] = COLORS.programs;
      else if (target === N.OPS) linkColors[i] = COLORS.ops;
      else linkColors[i] = COLORS.foundation;
    } else {
      linkColors[i] = COLORS.muted;
    }
  });

  return { data: { nodes, links }, meta, linkColors, N, hasBoost };
}

// Pre-build Sankey data for each tier (avoids recomputation on every render).
const SANKEY_BY_TIER: Record<
  string,
  ReturnType<typeof buildSankeyForTier>
> = Object.fromEntries(SANKEY_TIERS.map((t) => [t.id, buildSankeyForTier(t)]));

// Default to sprout for initial render
const DEFAULT_SANKEY_TIER = "sprout";

/** Stable node indices used across all tier variants. */
const CREATOR_NODES: Set<number> = new Set([5, 6, 7]);
const FOUNDATION_SUB_NODES: Set<number> = new Set([9, 10]);

/** Map each node index to a hover section key. */
type SectionKey =
  | "support"
  | "foundation"
  | "delivery"
  | null;

function nodeToSection(index: number): SectionKey {
  // Creator Pool (3), Boost Pool (4), Creators (5-7)
  if (index === 3 || index === 4) return "support";
  if (CREATOR_NODES.has(index)) return "support";
  // Foundation (8), Programs (9), Operations (10)
  if (index === 8 || FOUNDATION_SUB_NODES.has(index)) return "foundation";
  // Delivery (2)
  if (index === 2) return "delivery";
  return null;
}

/*
 * We need a factory so each Sankey instance can wire hover callbacks
 * without breaking the function-ref requirement (no JSX wrapper).
 */
function makeSankeyNodeComponent(
  onEnter: (section: SectionKey) => void,
  onLeave: () => void,
  activeSection: SectionKey,
  nodeMeta: { label: string; sub: string; color: string }[],
) {
  return function SankeyNodeComponent({
    x,
    y,
    width,
    height,
    index,
  }: SankeyNodeProps) {
    const containerWidth = useChartWidth();
    if (containerWidth == null) return null;

    const meta = nodeMeta[index];
    if (!meta) return null;

    const isOut = x + width + 6 > containerWidth;
    const section = nodeToSection(index);
    const dimmed = activeSection !== null && section !== activeSection;

    return (
      <Layer key={`SankeyNode${index}`}>
        {/* Invisible wider hit area for thin nodes */}
        <Rectangle
          x={x - 6}
          y={y}
          width={width + 12}
          height={height}
          fill="transparent"
          style={{ cursor: section ? "pointer" : "default" }}
          onMouseEnter={() => section && onEnter(section)}
          onMouseLeave={onLeave}
        />
        <Rectangle
          x={x}
          y={y}
          width={width}
          height={height}
          fill={meta.color}
          fillOpacity={dimmed ? 0.12 : 0.9}
          radius={2}
          style={{ pointerEvents: "none", transition: "fill-opacity 1000ms" }}
        />
        <text
          textAnchor={isOut ? "end" : "start"}
          x={isOut ? x - 8 : x + width + 8}
          y={y + height / 2}
          fontSize="12"
          fontWeight="600"
          fill="currentColor"
          dominantBaseline="middle"
          style={{ pointerEvents: "none", opacity: dimmed ? 0.25 : 1, transition: "opacity 1000ms" }}
        >
          {meta.label}
          <tspan fontWeight="400" fillOpacity={0.45} dx={6}>
            {meta.sub}
          </tspan>
        </text>
      </Layer>
    );
  };
}

function makeSankeyLinkComponent(
  onEnter: (section: SectionKey) => void,
  onLeave: () => void,
  activeSection: SectionKey,
  tierData: ReturnType<typeof buildSankeyForTier>,
) {
  return function SankeyLinkComponent({
    sourceX,
    sourceY,
    sourceControlX,
    targetX,
    targetY,
    targetControlX,
    linkWidth,
    index,
  }: SankeyLinkProps) {
    const color = tierData.linkColors[index] ?? "#888";
    const link = tierData.data.links[index];
    // Derive section from the link's target node
    const section = link ? nodeToSection(link.target) : null;
    // Also check the source—links from Sub split into multiple sections
    const sourceSection = link ? nodeToSection(link.source) : null;
    const dimmed = activeSection !== null && section !== activeSection && sourceSection !== activeSection;

    const d = `
      M${sourceX},${sourceY}
      C${sourceControlX},${sourceY}
       ${targetControlX},${targetY}
       ${targetX},${targetY}
    `;

    return (
      <Layer key={`SankeyLink${index}`}>
        {/* Visible link */}
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={linkWidth}
          strokeOpacity={dimmed ? 0.05 : 0.2}
          style={{ pointerEvents: "none", transition: "stroke-opacity 1000ms" }}
        />
        {/* Invisible wider hit area for hover */}
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(linkWidth, 8)}
          style={{ cursor: section ? "pointer" : "default" }}
          onMouseEnter={() => section && onEnter(section)}
          onMouseLeave={onLeave}
        />
      </Layer>
    );
  };
}

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
  const isCurrentTier = tier.id === currentTier;
  const isFree = tier.id === "free";
  const price = tier.price;

  return (
    <div
      className={`card bg-base-200/60 shadow-xl border-2 transition-all border-base-300 ${
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

        {(() => {
          const info = TIER_HIGHLIGHTS[tier.id];
          if (!info) return null;
          return (
            <div className="flex-grow">
              {info.upgrade && (
                <p className="text-xs text-base-content/40 mb-2">
                  {info.upgrade}
                </p>
              )}
              <ul className="space-y-2 text-sm">
                {info.included.map((highlight, i) => (
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
            </div>
          );
        })()}

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
                subscribing === tier.id ? "btn-disabled" : ""
              }`}
              onClick={() => onSelect(tier.id)}
              disabled={!!subscribing}
            >
              {subscribing === tier.id
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

/* ------------------------------------------------------------------ */
/*  Hover-conditional content sections below the Sankey diagram       */
/* ------------------------------------------------------------------ */

/** Maps each section component to the SectionKey(s) that highlight it. */
const SECTION_KEYS: { keys: SectionKey[]; id: string }[] = [
  { keys: ["support"], id: "support" },
  { keys: ["foundation"], id: "foundation" },
  { keys: ["delivery"], id: "delivery" },
];

function dimClass(active: SectionKey, keys: SectionKey[]): string {
  if (active === null) return "";
  return keys.includes(active)
    ? ""
    : "opacity-25";
}

function SectionContent({
  section,
  onEnter,
  onLeave,
}: {
  section: SectionKey;
  onEnter: (s: SectionKey) => void;
  onLeave: () => void;
}) {
  return (
    <>
      {SECTION_KEYS.map(({ keys, id }) => (
        <div
          key={id}
          className={`transition-opacity duration-1000 h-full ${dimClass(section, keys)}`}
          onMouseEnter={() => onEnter(keys[0])}
          onMouseLeave={onLeave}
        >
          {id === "support" && <CreatorSupportSection />}
          {id === "foundation" && <FoundationSection />}
          {id === "delivery" && <DeliverySection />}
        </div>
      ))}
    </>
  );
}

function CreatorSupportSection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex gap-1">
          <div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.pool }} />
          <div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.boost }} />
        </div>
        <h3 className="font-semibold text-sm">Creator Support</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        92% of your subscription goes to creators through two pools.
        The <strong>Creator Pool</strong> is distributed automatically,
        proportional to time spent engaging—watching, reading,
        listening, or playing. The <strong>Boost Pool</strong> lets
        you direct extra funds to specific creators with sliders;
        left untouched, it follows the same engagement-time split.
        Your boost also determines which gated content you unlock.
      </p>
    </div>
  );
}

function FoundationSection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded" style={{ backgroundColor: COLORS.foundation }} />
        <h3 className="font-semibold text-sm">Anthers Foundation</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        8% of your subscription funds the Anthers Foundation, which
        allocates internally between charitable programs (infrastructure
        equity, education, creation grants, emergency assistance) and
        organizational operations (staff, legal, admin). At least 50%
        goes to programs in any year. The Foundation publishes quarterly
        allocation reports.
      </p>
    </div>
  );
}

function DeliverySection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded" style={{ backgroundColor: COLORS.delivery }} />
        <h3 className="font-semibold text-sm">Delivery Infrastructure</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        Delivery infrastructure covers the bandwidth cost of the content
        you watch, listen to, read, and play. It's billed on top of your
        subscription based on your actual usage. Smart quality controls,
        local caching, downloads for offline replay, and shared viewing
        all help keep costs low — and you're always in control.
      </p>
    </div>
  );
}

export default function SubscribePage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();

  const [tiers, setTiers] = useState<SubscriptionTierOption[]>([]);
  const [currentSub, setCurrentSub] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionKey>(null);
  const [sankeyTier, setSankeyTier] = useState(DEFAULT_SANKEY_TIER);

  const activeTierData = SANKEY_BY_TIER[sankeyTier]!;
  const activeTierConfig = SANKEY_TIERS.find((t) => t.id === sankeyTier)!;

  const onSectionEnter = useCallback(
    (s: SectionKey) => setActiveSection(s),
    [],
  );
  const onSectionLeave = useCallback(
    () => setActiveSection(null),
    [],
  );

  // Recreate node/link components when activeSection or tier changes so
  // Recharts re-renders with updated dim/highlight opacity and data.
  const sankeyNode = useMemo(
    () =>
      makeSankeyNodeComponent(
        onSectionEnter,
        onSectionLeave,
        activeSection,
        activeTierData.meta,
      ),
    [onSectionEnter, onSectionLeave, activeSection, activeTierData],
  );
  const sankeyLink = useMemo(
    () =>
      makeSankeyLinkComponent(
        onSectionEnter,
        onSectionLeave,
        activeSection,
        activeTierData,
      ),
    [onSectionEnter, onSectionLeave, activeSection, activeTierData],
  );

  const wasCanceled = searchParams.get("canceled") === "true";

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tierRes, subRes] = await Promise.all([
          client.api.subscriptions.tiers.$get(),
          user
            ? client.api.subscriptions.me.$get()
            : Promise.resolve(null),
        ]);
        const tierData = (await tierRes.json()) as {
          tiers: SubscriptionTierOption[];
        };
        setTiers(tierData.tiers);
        if (subRes) {
          const subData = (await subRes.json()) as {
            subscription: Subscription;
          };
          setCurrentSub(subData.subscription);
        }
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
      const res = await client.api.subscriptions.subscribe.$post({
        json: { tier: tier as "root" | "sprout" | "petal" | "bloom" },
      });
      const data = (await res.json()) as {
        checkoutUrl?: string;
        tier?: string;
      };

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        // Tier change on existing subscription (no checkout needed)
        const subRes = await client.api.subscriptions.me.$get();
        const subData = (await subRes.json()) as {
          subscription: Subscription;
        };
        setCurrentSub(subData.subscription);
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
    <div className="mx-auto px-4 py-8" style={{ maxWidth: "110rem" }}>
      <div className="text-center mb-8">
        <p className="text-xs uppercase tracking-wider text-base-content/40 mb-1">
          501(c)(3) non-profit
        </p>
        <h1 className="text-3xl font-bold mb-2">Choose Your Plan</h1>
        <p className="text-base-content/70 max-w-xl mx-auto">
          Your subscription directly funds the creators you engage with
          and the charitable programs that keep the creative internet
          equitable. No algorithms, no middlemen, no shareholders—just
          transparent, accountable support.
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
            key={tier.id}
            tier={tier}
            currentTier={currentTier}
            onSelect={handleSelect}
            subscribing={subscribing}
          />
        ))}
      </div>

      {/* Where Your Money Goes */}
      <div className="mt-16">
        <div className="max-w-4xl mx-auto mb-8">
          <h2 className="text-2xl font-bold mb-2 text-center">
            Where Your Money Goes
          </h2>
          <p className="text-sm text-base-content/60 text-center max-w-2xl mx-auto">
            Anthers is structured so that it cannot extract profit from
            creators. Every tier splits the same way: 92% to creators, 8%
            to the Anthers Foundation. Delivery infrastructure is billed
            separately based on your usage. You always know exactly where
            every dollar goes.
          </p>
        </div>

        {/* Sankey flow diagram—full width */}
        <div className="card bg-base-200/60 shadow-xl p-5 overflow-x-auto">
          {/* Tier selector tabs */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {SANKEY_TIERS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setSankeyTier(t.id);
                  setActiveSection(null);
                }}
                className={`btn ${
                  sankeyTier === t.id
                    ? "btn-primary"
                    : "btn-ghost"
                }`}
              >
                {t.name}
                <span className="ml-1 text-sm opacity-60">
                  ${t.price}/mo
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs text-base-content/30 mb-3">
            Hover any section to learn more
          </p>

          {!activeTierData.hasBoost && (
            <p className="text-xs text-base-content/40 mb-2">
              The {activeTierConfig.name} tier directs all creator funding
              through the Creator Pool. Boost Pool is available starting at
              Sprout.
            </p>
          )}

          <div style={{ minWidth: 1000 }}>
            <ResponsiveContainer width="100%" height={800}>
              <Sankey
                data={activeTierData.data}
                node={sankeyNode}
                link={sankeyLink}
                nodeWidth={14}
                nodePadding={24}
                margin={{ top: 16, right: 180, bottom: 16, left: 160 }}
                sort={false}
                iterations={128}
                linkCurvature={0.5}
                align="left"
                verticalAlign="top"
              />
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-base-content/40 mt-1 text-center">
            92% of your subscription goes directly to creators. 8% funds the
            Anthers Foundation's charitable programs and operations. Delivery
            infrastructure is usage-based, billed separately.
          </p>
        </div>

        {/* Detail breakdown—compact grid below chart */}
        <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
          <SectionContent
            section={activeSection}
            onEnter={onSectionEnter}
            onLeave={onSectionLeave}
          />
        </div>
      </div>

      {/* Why Non-Profit */}
      <div className="mt-16 max-w-3xl mx-auto text-center pb-4">
        <h2 className="text-xl font-bold mb-3">Why Non-Profit</h2>
        <p className="text-sm text-base-content/60 leading-relaxed max-w-2xl mx-auto">
          Anthers is a non-profit because the only way to
          guarantee that our platform always serves creators is to make it legally
          impossible for it to act otherwise. Anthers cannot distribute profits to
            insiders, cannot be acquired, and cannot have its mission diluted by investors.
            If it ever ceases to operate, its assets go to another exempt organization,
              not to founders or shareholders.
        </p>
      </div>
    </div>
  );
}

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
      "85% to creators, 10% CRF, 5% operations",
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
}

const SANKEY_TIERS: SankeyTierConfig[] = [
  { id: "root",   name: "Root",   price: 3,  boostBudget: 0 },
  { id: "sprout", name: "Sprout", price: 7,  boostBudget: 2 },
  { id: "petal",  name: "Petal",  price: 15, boostBudget: 5 },
  { id: "bloom",  name: "Bloom",  price: 30, boostBudget: 12 },
];

/* Allocation percentages (fixed across all tiers). */
const ALLOC = {
  creators: 0.85,
  crf: 0.10,
  ops: 0.05,
  /* CRF sub-splits (proportions of CRF total). */
  crfInfra: 0.35,
  crfEdu: 0.30,
  crfRelief: 0.20,
  crfCommunity: 0.15,
  /* Ops sub-splits (proportions of Ops total). */
  opsStaff: 0.56,
  opsAdmin: 0.32,
  opsReserves: 0.12,
  /* Creator engagement-time share (example proportions). */
  creatorA: 0.51,
  creatorB: 0.26,
  creatorC: 0.23,
  /* Infra cost as fraction of each creator's total. */
  infraDeliveryRate: 0.07,
  infraStorageRate: 0.05,
};

/** Round to 2 decimal places (financial display). */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

const COLORS = {
  pool:     "#2563eb",  // Creator Pool—blue-600
  boost:    "#c026d3",  // Boost Pool—fuchsia-600
  muted:    "#a3a3a3",  // neutral / subscription node
  // Creator flow—decreasing shades of violet
  support:  "#7c3aed",  // Creator Support (merged pool—violet-600)
  crA:      "#4c1d95",  // Creator A—violet-900
  crB:      "#6d28d9",  // Creator B—violet-700
  crC:      "#8b5cf6",  // Creator C—violet-500
  // Infra costs—pink tones
  delivery: "#db2777",  // Infra: Delivery—pink-600
  storage:  "#9d174d",  // Infra: Storage—pink-800
  // Resilience Fund—teal/cyan tones (secondary family)
  crf:      "#0f766e",  // Resilience Fund node—dark teal
  crfA:     "#14b8a6",  // CRF pillar 1—bright teal
  crfB:     "#0d9488",  // CRF pillar 2—medium teal
  crfC:     "#0f766e",  // CRF pillar 3—muted teal
  crfD:     "#115e59",  // CRF pillar 4—dark teal
  // Platform Ops—dark orange tones
  grey:     "#c2410c",  // Platform Operations node—orange-700
  grey1:    "#ea580c",  // Staff—orange-600
  grey2:    "#c2410c",  // Admin—orange-700
  grey3:    "#7c2d12",  // Reserves—orange-900
};

/**
 * Build a Sankey data set + node metadata for a given tier config.
 *
 * For tiers without a Boost Pool (boost = 0), the Boost node and its
 * links are omitted and Creator Pool receives all 85%.  To keep node
 * indices stable we always allocate all 25 node slots but only include
 * links for nodes that carry value.
 */
function buildSankeyForTier(tier: SankeyTierConfig) {
  const price = tier.price;
  const boost = tier.boostBudget;
  const hasBoost = boost > 0;

  const creatorTotal = r2(price * ALLOC.creators);
  const crfTotal = r2(price * ALLOC.crf);
  const opsTotal = r2(price - creatorTotal - crfTotal); // remainder to avoid rounding drift

  const poolAmount = r2(creatorTotal - boost);
  const boostAmount = boost;

  // Creator Support → individual creators (engagement-time weighted)
  const supportTotal = creatorTotal;
  const crA = r2(supportTotal * ALLOC.creatorA);
  const crB = r2(supportTotal * ALLOC.creatorB);
  const crC = r2(supportTotal - crA - crB); // remainder

  // Each creator → income + infra
  function creatorSplit(total: number) {
    const delivery = r2(total * ALLOC.infraDeliveryRate);
    const storage = r2(total * ALLOC.infraStorageRate);
    const income = r2(total - delivery - storage);
    return { income, delivery, storage };
  }
  const splitA = creatorSplit(crA);
  const splitB = creatorSplit(crB);
  const splitC = creatorSplit(crC);

  // CRF sub-splits
  const crfInfra = r2(crfTotal * ALLOC.crfInfra);
  const crfEdu = r2(crfTotal * ALLOC.crfEdu);
  const crfRelief = r2(crfTotal * ALLOC.crfRelief);
  const crfCommunity = r2(crfTotal - crfInfra - crfEdu - crfRelief);

  // Ops sub-splits
  const opsStaff = r2(opsTotal * ALLOC.opsStaff);
  const opsAdmin = r2(opsTotal * ALLOC.opsAdmin);
  const opsReserves = r2(opsTotal - opsStaff - opsAdmin);

  // --- Node index map (always 25 slots) ---
  const N = {
    SUB: 0,
    CPOOL: 1,
    BOOST: 2,
    CRF: 3,
    OPS: 4,
    SUPPORT: 5,
    CRF_INFRA: 6,
    CRF_EDU: 7,
    CRF_RELIEF: 8,
    CRF_COMMUNITY: 9,
    OPS_STAFF: 10,
    OPS_ADMIN: 11,
    OPS_RESERVES: 12,
    CREATOR_A: 13,
    CREATOR_B: 14,
    CREATOR_C: 15,
    A_INCOME: 16,
    A_DELIVERY: 17,
    A_STORAGE: 18,
    B_INCOME: 19,
    B_DELIVERY: 20,
    B_STORAGE: 21,
    C_INCOME: 22,
    C_DELIVERY: 23,
    C_STORAGE: 24,
  } as const;

  const nodes = [
    { name: "Your Subscription" },
    { name: "Creator Pool" },
    { name: "Boost Pool" },
    { name: "Resilience Fund" },
    { name: "Platform Operations" },
    { name: "Creator Support" },
    { name: "Infrastructure Equity" },
    { name: "Education & Development" },
    { name: "Econ. Resilience & Relief" },
    { name: "Community & Public Benefit" },
    { name: "Staff" },
    { name: "Admin" },
    { name: "Reserves" },
    { name: "Creator A" },
    { name: "Creator B" },
    { name: "Creator C" },
    { name: "Income" },
    { name: "Infra: Delivery" },
    { name: "Infra: Storage" },
    { name: "Income" },
    { name: "Infra: Delivery" },
    { name: "Infra: Storage" },
    { name: "Income" },
    { name: "Infra: Delivery" },
    { name: "Infra: Storage" },
  ];

  const links: { source: number; target: number; value: number }[] = [
    // Col 0 → Col 1
    { source: N.SUB, target: N.CPOOL, value: poolAmount },
    ...(hasBoost
      ? [{ source: N.SUB, target: N.BOOST, value: boostAmount }]
      : []),
    { source: N.SUB, target: N.CRF, value: crfTotal },
    { source: N.SUB, target: N.OPS, value: opsTotal },

    // Col 1 → Col 2: pools merge into Creator Support
    { source: N.CPOOL, target: N.SUPPORT, value: poolAmount },
    ...(hasBoost
      ? [{ source: N.BOOST, target: N.SUPPORT, value: boostAmount }]
      : []),

    // Col 2 → Col 3: Creator Support → creators
    { source: N.SUPPORT, target: N.CREATOR_A, value: crA },
    { source: N.SUPPORT, target: N.CREATOR_B, value: crB },
    { source: N.SUPPORT, target: N.CREATOR_C, value: crC },

    // Col 3 → Col 4: each creator → income + infra
    { source: N.CREATOR_A, target: N.A_INCOME, value: splitA.income },
    { source: N.CREATOR_A, target: N.A_DELIVERY, value: splitA.delivery },
    { source: N.CREATOR_A, target: N.A_STORAGE, value: splitA.storage },

    { source: N.CREATOR_B, target: N.B_INCOME, value: splitB.income },
    { source: N.CREATOR_B, target: N.B_DELIVERY, value: splitB.delivery },
    { source: N.CREATOR_B, target: N.B_STORAGE, value: splitB.storage },

    { source: N.CREATOR_C, target: N.C_INCOME, value: splitC.income },
    { source: N.CREATOR_C, target: N.C_DELIVERY, value: splitC.delivery },
    { source: N.CREATOR_C, target: N.C_STORAGE, value: splitC.storage },

    // CRF → pillars
    { source: N.CRF, target: N.CRF_INFRA, value: crfInfra },
    { source: N.CRF, target: N.CRF_EDU, value: crfEdu },
    { source: N.CRF, target: N.CRF_RELIEF, value: crfRelief },
    { source: N.CRF, target: N.CRF_COMMUNITY, value: crfCommunity },

    // Ops → branches
    { source: N.OPS, target: N.OPS_STAFF, value: opsStaff },
    { source: N.OPS, target: N.OPS_ADMIN, value: opsAdmin },
    { source: N.OPS, target: N.OPS_RESERVES, value: opsReserves },
  ];

  const meta: { label: string; sub: string; color: string }[] = [
    { label: "Your Subscription",       sub: `$${price}/mo`,       color: COLORS.muted },
    { label: "Creator Pool",            sub: fmt(poolAmount),      color: COLORS.pool },
    { label: "Boost Pool",              sub: fmt(boostAmount),     color: COLORS.boost },
    { label: "Resilience Fund",         sub: fmt(crfTotal),        color: COLORS.crf },
    { label: "Platform Operations",     sub: fmt(opsTotal),        color: COLORS.grey },
    { label: "Creator Support",         sub: fmt(supportTotal),    color: COLORS.support },
    { label: "Infrastructure Equity",   sub: fmt(crfInfra),        color: COLORS.crfA },
    { label: "Education & Dev.",        sub: fmt(crfEdu),          color: COLORS.crfB },
    { label: "Resilience & Relief",     sub: fmt(crfRelief),       color: COLORS.crfC },
    { label: "Community & Public",      sub: fmt(crfCommunity),    color: COLORS.crfD },
    { label: "Staff",                   sub: fmt(opsStaff),        color: COLORS.grey1 },
    { label: "Admin",                   sub: fmt(opsAdmin),        color: COLORS.grey2 },
    { label: "Reserves",                sub: fmt(opsReserves),     color: COLORS.grey3 },
    { label: "Creator A",               sub: fmt(crA),             color: COLORS.crA },
    { label: "Creator B",               sub: fmt(crB),             color: COLORS.crB },
    { label: "Creator C",               sub: fmt(crC),             color: COLORS.crC },
    { label: "Income",                  sub: fmt(splitA.income),   color: COLORS.crA },
    { label: "Infra: Delivery",         sub: fmt(splitA.delivery), color: COLORS.delivery },
    { label: "Infra: Storage",          sub: fmt(splitA.storage),  color: COLORS.storage },
    { label: "Income",                  sub: fmt(splitB.income),   color: COLORS.crB },
    { label: "Infra: Delivery",         sub: fmt(splitB.delivery), color: COLORS.delivery },
    { label: "Infra: Storage",          sub: fmt(splitB.storage),  color: COLORS.storage },
    { label: "Income",                  sub: fmt(splitC.income),   color: COLORS.crC },
    { label: "Infra: Delivery",         sub: fmt(splitC.delivery), color: COLORS.delivery },
    { label: "Infra: Storage",          sub: fmt(splitC.storage),  color: COLORS.storage },
  ];

  // Pre-compute link colors
  const linkColors: Record<number, string> = {};
  links.forEach((link, i) => {
    const { source, target } = link;
    if (source === N.SUB) {
      if (target === N.CPOOL) linkColors[i] = COLORS.pool;
      else if (target === N.BOOST) linkColors[i] = COLORS.boost;
      else if (target === N.CRF) linkColors[i] = COLORS.crf;
      else if (target === N.OPS) linkColors[i] = COLORS.grey;
      else linkColors[i] = COLORS.muted;
    } else if (source === N.CRF) {
      const crfMap: Record<number, string> = {
        [N.CRF_INFRA]: COLORS.crfA,
        [N.CRF_EDU]: COLORS.crfB,
        [N.CRF_RELIEF]: COLORS.crfC,
        [N.CRF_COMMUNITY]: COLORS.crfD,
      };
      linkColors[i] = crfMap[target] ?? COLORS.crf;
    } else if (source === N.OPS) {
      const opsMap: Record<number, string> = {
        [N.OPS_STAFF]: COLORS.grey1,
        [N.OPS_ADMIN]: COLORS.grey2,
        [N.OPS_RESERVES]: COLORS.grey3,
      };
      linkColors[i] = opsMap[target] ?? COLORS.grey;
    } else if (source === N.CPOOL) {
      linkColors[i] = COLORS.pool;
    } else if (source === N.BOOST) {
      linkColors[i] = COLORS.boost;
    } else if (source === N.SUPPORT) {
      const crMap: Record<number, string> = {
        [N.CREATOR_A]: COLORS.crA,
        [N.CREATOR_B]: COLORS.crB,
        [N.CREATOR_C]: COLORS.crC,
      };
      linkColors[i] = crMap[target] ?? COLORS.support;
    } else if (
      target === N.A_INCOME ||
      target === N.B_INCOME ||
      target === N.C_INCOME
    ) {
      const crMap: Record<number, string> = {
        [N.CREATOR_A]: COLORS.crA,
        [N.CREATOR_B]: COLORS.crB,
        [N.CREATOR_C]: COLORS.crC,
      };
      linkColors[i] = crMap[source] ?? COLORS.support;
    } else if (
      target === N.A_DELIVERY ||
      target === N.B_DELIVERY ||
      target === N.C_DELIVERY
    ) {
      linkColors[i] = COLORS.delivery;
    } else if (
      target === N.A_STORAGE ||
      target === N.B_STORAGE ||
      target === N.C_STORAGE
    ) {
      linkColors[i] = COLORS.storage;
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
const INCOME_NODES: Set<number> = new Set([16, 19, 22]);
const DELIVERY_NODES: Set<number> = new Set([17, 20, 23]);
const STORAGE_NODES: Set<number> = new Set([18, 21, 24]);
const INFRA_NODES: Set<number> = new Set([...DELIVERY_NODES, ...STORAGE_NODES]);
const CRF_PILLAR_NODES: Set<number> = new Set([6, 7, 8, 9]);
const OPS_BRANCH_NODES: Set<number> = new Set([10, 11, 12]);
const CREATOR_NODES: Set<number> = new Set([13, 14, 15]);

/** Map each node index to a hover section key. */
type SectionKey =
  | "support"
  | "income"
  | "infra"
  | "crf"
  | "ops"
  | null;

function nodeToSection(index: number): SectionKey {
  if (index === 1 || index === 2 || index === 5) return "support";
  if (CREATOR_NODES.has(index)) return "support";
  if (INCOME_NODES.has(index)) return "income";
  if (INFRA_NODES.has(index)) return "infra";
  if (index === 3 || CRF_PILLAR_NODES.has(index)) return "crf";
  if (index === 4 || OPS_BRANCH_NODES.has(index)) return "ops";
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
  { keys: ["income"], id: "income" },
  { keys: ["infra"], id: "infra" },
  { keys: ["crf"], id: "crf" },
  { keys: ["ops"], id: "ops" },
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
          {id === "income" && <CreatorIncomeSection />}
          {id === "infra" && <InfraCostsSection />}
          {id === "crf" && <CRFSection />}
          {id === "ops" && <OpsSection />}
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
        85% of your subscription goes to creators through two pools.
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

function CreatorIncomeSection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded" style={{ backgroundColor: COLORS.crA }} />
        <h3 className="font-semibold text-sm">Creator Income</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        Both pools merge into a single stream and are distributed to
        creators weighted by engagement time. Engage with Creator A
        twice as much as Creator B, and A receives roughly twice the
        funding—automatically. After infrastructure costs, the
        remainder is the creator's income, paid out via Stripe
        Connect. Anthers takes zero percentage cut.
      </p>
    </div>
  );
}

function InfraCostsSection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex gap-1">
          <div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.delivery }} />
          <div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.storage }} />
        </div>
        <h3 className="font-semibold text-sm">Infrastructure Costs</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        CDN bandwidth (delivery) and object storage are passed through
        at cost with no markup. These are the only deductions from a
        creator's revenue—real, itemized costs they can see and
        verify. Creators whose costs exceed their revenue are covered
        by the CRF's Infrastructure Equity program.
      </p>
    </div>
  );
}

function CRFSection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded" style={{ backgroundColor: COLORS.crf }} />
        <h3 className="font-semibold text-sm">Resilience Fund</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        10% of every subscription funds four charitable pillars:
        Infrastructure Equity, Education & Development, Economic
        Resilience & Relief, and Community & Public Benefit. The CRF
        is governed by a committee with direct creator representation
        and is the operational heart of Anthers's mission.
      </p>
    </div>
  );
}

function OpsSection() {
  return (
    <div className="card bg-base-200/60 shadow-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded" style={{ backgroundColor: COLORS.grey }} />
        <h3 className="font-semibold text-sm">Platform Operations</h3>
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">
        5% covers staff, legal, accounting, insurance, and tools.
        The board reviews this rate annually—if it generates more
        than 130–150% of projected costs, the rate is reduced. As
        Anthers scales, this percentage shrinks.
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
            creators. Every tier splits the same way: 85% to creators, 10%
            to the Creator Resilience Fund, 5% to platform operations. You
            always know exactly where every dollar goes.
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
            85% of your subscription goes directly to creators
            and their infrastructure. 10% funds the Creator Resilience
            Fund's charitable programs. 5% covers platform operations.
          </p>
        </div>

        {/* Detail breakdown—compact grid below chart */}
        <div className="mt-10 grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
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

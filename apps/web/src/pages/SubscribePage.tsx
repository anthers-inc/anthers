// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
	Layer,
	Rectangle,
	ResponsiveContainer,
	Sankey,
	type SankeyLinkProps,
	type SankeyNodeProps,
	useChartWidth,
} from "recharts";
import { useAuth } from "../lib/auth";
import { client } from "../lib/rpc";
import type { Subscription, SubscriptionTierOption } from "../lib/types";

// Sales tax rates file retained for reference; we use the national average here.
// import { STATE_SALES_TAX_RATES } from "../lib/sales-tax-rates";

/* ------------------------------------------------------------------ */
/*  Tier thresholds                                                   */
/* ------------------------------------------------------------------ */

interface TierThreshold {
	id: string;
	name: string;
	price: number;
}

const TIER_THRESHOLDS: TierThreshold[] = [
	{ id: "root", name: "Root", price: 3 },
	{ id: "sprout", name: "Sprout", price: 7 },
	{ id: "petal", name: "Petal", price: 15 },
	{ id: "bloom", name: "Bloom", price: 30 },
];

/**
 * Flat delivery credit for all paid subscribers, funded by the Foundation.
 * $1/month covers ~15 hours of 1080p60 video, more for audio/text.
 * Expressed as a dollar amount so it's media-agnostic.
 */
const DELIVERY_CREDIT = 1.0;

function tierForAmount(amount: number): TierThreshold | null {
	for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
		if (amount >= TIER_THRESHOLDS[i].price) return TIER_THRESHOLDS[i];
	}
	return null;
}

/* ------------------------------------------------------------------ */
/*  Financial helpers                                                 */
/* ------------------------------------------------------------------ */

const ALLOC = {
	creators: 0.92,
	foundation: 0.08,
	foundationPrograms: 0.6,
	foundationOps: 0.4,
};

/** V2: Boost Pool = ceil(F × 0.5), Time Pool = (F × 0.92) − boostPool */
function computePools(fundingLevel: number) {
	const creatorShare = Number((fundingLevel * 0.92).toFixed(2));
	const boostPool = fundingLevel >= 3 ? Math.ceil(fundingLevel * 0.5) : 0;
	const timePool = Math.max(0, Number((creatorShare - boostPool).toFixed(2)));
	return { creatorShare, boostPool, timePool };
}

/** 1080p60 midpoint ~15 Mbps = ~112.5 MB/min. Delivery at $0.01/GiB. */
const DELIVERY_PER_HOUR = ((112.5 * 60) / 1024) * 0.01; // ~$0.066/hr

/**
 * Non-linear streaming slider: maps a 0–1000 slider position to 0–200 hours
 * using a power curve (exponent 1.5), giving more granularity at lower values
 * without being as aggressive as quadratic.
 * slider 0 → 0 hrs, slider 500 → ~71 hrs, slider 1000 → 200 hrs.
 */
const STREAM_SLIDER_MAX = 1000;
const STREAM_HOURS_MAX = 200;
const STREAM_EASE = 1.5;

function sliderToHrs(slider: number): number {
	const t = slider / STREAM_SLIDER_MAX; // 0..1
	return Math.round(t ** STREAM_EASE * STREAM_HOURS_MAX);
}

function hrsToSlider(hrs: number): number {
	const t = Math.min(1, Math.max(0, hrs / STREAM_HOURS_MAX)) ** (1 / STREAM_EASE);
	return Math.round(t * STREAM_SLIDER_MAX);
}

/** National average combined state + local sales tax rate (2026 estimate). */
const AVG_SALES_TAX_RATE = 0.0663;

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}

function computeCardFee(amount: number, useCard: boolean): number {
	if (amount <= 0) return 0;
	if (useCard) return r2(amount * 0.029 + 0.3);
	return r2(Math.min(amount * 0.008, 5)); // ACH: 0.8% capped at $5
}

function computeSalesTax(amount: number): number {
	if (amount <= 0) return 0;
	return r2(amount * AVG_SALES_TAX_RATE);
}

/**
 * Zero-sum update for a triple of slider values.
 * When one slider moves, the delta is distributed equally across the
 * other two. If one of them hits 0, the remaining delta spills to the
 * other.
 */
function zeroSumUpdate(
	prev: [number, number, number],
	idx: 0 | 1 | 2,
	rawVal: number,
	total: number,
): [number, number, number] {
	const clamped = Math.min(total, Math.max(0, Math.round(rawVal)));
	const delta = clamped - prev[idx];
	if (delta === 0) return prev;

	const others = ([0, 1, 2] as const).filter((i) => i !== idx);
	const next: [number, number, number] = [...prev] as [number, number, number];
	next[idx] = clamped;

	// Try to subtract delta/2 from each other, clamping at 0
	let toDistribute = -delta;
	const perOther = Math.round(toDistribute / 2);

	for (const i of others) {
		const adjusted = Math.max(0, next[i] + perOther);
		toDistribute -= adjusted - next[i];
		next[i] = adjusted;
	}

	// Any leftover (from clamping at 0) goes to whichever other can absorb it
	if (toDistribute !== 0) {
		for (const i of others) {
			const adjusted = Math.max(0, next[i] + toDistribute);
			toDistribute -= adjusted - next[i];
			next[i] = adjusted;
			if (toDistribute === 0) break;
		}
	}

	// Final rounding correction
	const sum = next[0] + next[1] + next[2];
	if (sum !== total) {
		for (const i of others) {
			if (next[i] + (total - sum) >= 0) {
				next[i] += total - sum;
				break;
			}
		}
	}

	return next;
}

/* ------------------------------------------------------------------ */
/*  Sankey builder                                                    */
/* ------------------------------------------------------------------ */

const COLORS = {
	pool: "#2563eb",
	boost: "#c026d3",
	muted: "#a3a3a3",
	crA: "#4c1d95",
	crB: "#6d28d9",
	crC: "#8b5cf6",
	delivery: "#db2777",
	foundation: "#0f766e",
	programs: "#14b8a6",
	ops: "#0d9488",
	cardFee: "#d97706", // amber-600
	salesTax: "#737373", // neutral-500
};

interface SankeyParams {
	fundingLevel: number;
	grossDelivery: number;
	deliveryAmt: number;
	cardFee: number;
	salesTax: number;
	poolSplits: [number, number, number];
	boostSplits: [number, number, number];
}

/**
 * Three root inputs:
 *   0: Subscription        (time pool, boost, foundation fee)
 *   1: Fees                (user-paid delivery overage, card/bank fee, sales tax)
 *   2: Foundation Credit   ($1/mo delivery credit, always present)
 *
 * Subscription side:
 *   3: Time Pool
 *   4: Boost Pool
 *   5: Creator A
 *   6: Creator B
 *   7: Creator C
 *   8: Anthers Foundation
 *   9: Programs
 *  10: Operations
 *
 * Fees + Foundation Credit merge at Delivery:
 *  11: Delivery            (receives from Foundation Credit + optionally Fees)
 *  12: Processing Fee
 *  13: Sales Tax
 */
function buildSankey(p: SankeyParams) {
	const price = p.fundingLevel;
	const isFree = price <= 0;

	const creatorTotal = isFree ? 0 : r2(price * ALLOC.creators);
	const foundationTotal = isFree ? 0 : r2(price - creatorTotal);
	const { timePool: computedTimePool, boostPool: computedBoostPool } = computePools(price);
	const poolAmount = isFree ? 0 : computedTimePool;
	const boostAmount = isFree ? 0 : computedBoostPool;
	const hasBoost = boostAmount > 0;

	// Foundation credit covers up to $1 of delivery
	const creditUsed = r2(Math.min(DELIVERY_CREDIT, p.grossDelivery));
	const userDelivery = p.deliveryAmt; // already has credit subtracted

	const feesTotal = r2(userDelivery + p.cardFee + p.salesTax);
	const totalPayment = r2(price + feesTotal);

	const poolA = r2(poolAmount * p.poolSplits[0]);
	const poolB = r2(poolAmount * p.poolSplits[1]);
	const poolC = r2(poolAmount - poolA - poolB);

	const boostA = hasBoost ? r2(boostAmount * p.boostSplits[0]) : 0;
	const boostB = hasBoost ? r2(boostAmount * p.boostSplits[1]) : 0;
	const boostC = hasBoost ? r2(boostAmount - boostA - boostB) : 0;

	const crA = r2(poolA + boostA);
	const crB = r2(poolB + boostB);
	const crC = r2(poolC + boostC);

	const foundationPrograms = r2(foundationTotal * ALLOC.foundationPrograms);
	const foundationOps = r2(foundationTotal - foundationPrograms);

	const N = {
		SUB: 0,
		FEES: 1,
		FNDCREDIT: 2,
		CPOOL: 3,
		BOOST: 4,
		CREATOR_A: 5,
		CREATOR_B: 6,
		CREATOR_C: 7,
		FOUNDATION: 8,
		PROGRAMS: 9,
		OPS: 10,
		CARDFEE: 11,
		SALESTAX: 12,
		DELIVERY: 13,
	} as const;

	const nodes = [
		{ name: "User Subscription" },
		{ name: "User Fees" },
		{ name: "Foundation Credit" },
		{ name: "Time Pool" },
		{ name: "Boost Pool" },
		{ name: "Creator A" },
		{ name: "Creator B" },
		{ name: "Creator C" },
		{ name: "Anthers Foundation" },
		{ name: "Programs" },
		{ name: "Operations" },
		{ name: "Processing Fee" },
		{ name: "Sales Tax" },
		{ name: "Content Delivery" },
	];

	const links: { source: number; target: number; value: number }[] = [];

	// Subscription → pools + foundation
	if (poolAmount > 0) links.push({ source: N.SUB, target: N.CPOOL, value: poolAmount });
	if (hasBoost) links.push({ source: N.SUB, target: N.BOOST, value: boostAmount });
	if (foundationTotal > 0)
		links.push({ source: N.SUB, target: N.FOUNDATION, value: foundationTotal });

	// Pool → creators
	if (poolA > 0) links.push({ source: N.CPOOL, target: N.CREATOR_A, value: poolA });
	if (poolB > 0) links.push({ source: N.CPOOL, target: N.CREATOR_B, value: poolB });
	if (poolC > 0) links.push({ source: N.CPOOL, target: N.CREATOR_C, value: poolC });

	// Boost → creators
	if (hasBoost) {
		if (boostA > 0) links.push({ source: N.BOOST, target: N.CREATOR_A, value: boostA });
		if (boostB > 0) links.push({ source: N.BOOST, target: N.CREATOR_B, value: boostB });
		if (boostC > 0) links.push({ source: N.BOOST, target: N.CREATOR_C, value: boostC });
	}

	// Foundation → Programs + Operations
	if (foundationPrograms > 0)
		links.push({ source: N.FOUNDATION, target: N.PROGRAMS, value: foundationPrograms });
	if (foundationOps > 0) links.push({ source: N.FOUNDATION, target: N.OPS, value: foundationOps });

	// Foundation Credit → Delivery (always, even if $0 streaming — shows the credit exists)
	links.push({ source: N.FNDCREDIT, target: N.DELIVERY, value: Math.max(creditUsed, 0.01) });

	// Fees → user-paid delivery overage, processing, tax
	if (userDelivery > 0) links.push({ source: N.FEES, target: N.DELIVERY, value: userDelivery });
	if (p.cardFee > 0) links.push({ source: N.FEES, target: N.CARDFEE, value: p.cardFee });
	if (p.salesTax > 0) links.push({ source: N.FEES, target: N.SALESTAX, value: p.salesTax });

	const totalDelivery = r2(creditUsed + userDelivery);

	const meta: { label: string; sub: string; color: string }[] = [
		{ label: "User Subscription", sub: fmt(price), color: COLORS.muted },
		{ label: "User Fees", sub: fmt(feesTotal), color: COLORS.cardFee },
		{ label: "Foundation Credit", sub: fmt(creditUsed), color: COLORS.programs },
		{ label: "Time Pool", sub: fmt(poolAmount), color: COLORS.pool },
		{ label: "Boost Pool", sub: fmt(boostAmount), color: COLORS.boost },
		{ label: "Creator A", sub: fmt(crA), color: COLORS.crA },
		{ label: "Creator B", sub: fmt(crB), color: COLORS.crB },
		{ label: "Creator C", sub: fmt(crC), color: COLORS.crC },
		{ label: "Anthers Foundation", sub: fmt(foundationTotal), color: COLORS.foundation },
		{ label: "Programs", sub: fmt(foundationPrograms), color: COLORS.programs },
		{ label: "Operations", sub: fmt(foundationOps), color: COLORS.ops },
		{ label: "Processing Fee", sub: fmt(p.cardFee), color: COLORS.cardFee },
		{ label: "Sales Tax", sub: fmt(p.salesTax), color: COLORS.salesTax },
		{ label: "Content Delivery", sub: fmt(totalDelivery), color: COLORS.delivery },
	];

	const linkColors: Record<number, string> = {};
	links.forEach((link, i) => {
		const { source, target } = link;
		if (source === N.SUB) {
			if (target === N.CPOOL) linkColors[i] = COLORS.pool;
			else if (target === N.BOOST) linkColors[i] = COLORS.boost;
			else if (target === N.FOUNDATION) linkColors[i] = COLORS.foundation;
			else linkColors[i] = COLORS.muted;
		} else if (source === N.CPOOL) {
			linkColors[i] = COLORS.pool;
		} else if (source === N.BOOST) {
			linkColors[i] = COLORS.boost;
		} else if (source === N.FOUNDATION) {
			if (target === N.PROGRAMS) linkColors[i] = COLORS.programs;
			else if (target === N.OPS) linkColors[i] = COLORS.ops;
			else linkColors[i] = COLORS.foundation;
		} else if (source === N.FNDCREDIT) {
			linkColors[i] = COLORS.programs; // teal, matching Foundation
		} else if (source === N.FEES) {
			if (target === N.DELIVERY) linkColors[i] = COLORS.delivery;
			else if (target === N.CARDFEE) linkColors[i] = COLORS.cardFee;
			else if (target === N.SALESTAX) linkColors[i] = COLORS.salesTax;
			else linkColors[i] = COLORS.cardFee;
		} else {
			linkColors[i] = COLORS.muted;
		}
	});

	return { data: { nodes, links }, meta, linkColors, N, hasBoost, totalPayment };
}

/* ------------------------------------------------------------------ */
/*  Sankey hover logic                                                */
/* ------------------------------------------------------------------ */

const CREATOR_NODES: Set<number> = new Set([5, 6, 7]);
const FOUNDATION_SUB_NODES: Set<number> = new Set([9, 10]);
const FEE_LEAF_NODES: Set<number> = new Set([11, 12, 13]);

type SectionKey = "support" | "foundation" | "fees" | null;

function nodeToSection(index: number): SectionKey {
	// Time Pool (3), Boost Pool (4), Creators (5-7)
	if (index === 3 || index === 4) return "support";
	if (CREATOR_NODES.has(index)) return "support";
	// Foundation (8), Programs (9), Operations (10)
	if (index === 8 || FOUNDATION_SUB_NODES.has(index)) return "foundation";
	// Fees (1), Foundation Credit (2), Processing Fee (11), Sales Tax (12), Content Delivery (13)
	if (index === 1 || index === 2 || FEE_LEAF_NODES.has(index)) return "fees";
	return null;
}

function makeSankeyNodeComponent(
	onEnter: (section: SectionKey) => void,
	onLeave: () => void,
	activeSection: SectionKey,
	nodeMeta: { label: string; sub: string; color: string }[],
) {
	return function SankeyNodeComponent({ x, y, width, height, index }: SankeyNodeProps) {
		const containerWidth = useChartWidth();
		if (containerWidth == null) return null;
		const meta = nodeMeta[index];
		if (!meta) return null;

		const isOut = x + width + 6 > containerWidth;
		const section = nodeToSection(index);
		const dimmed = activeSection !== null && section !== activeSection;

		return (
			<Layer key={`SankeyNode${index}`}>
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
					style={{
						pointerEvents: "none",
						opacity: dimmed ? 0.25 : 1,
						transition: "opacity 1000ms",
					}}
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
	sankeyData: ReturnType<typeof buildSankey>,
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
		const color = sankeyData.linkColors[index] ?? "#888";
		const link = sankeyData.data.links[index];
		const section = link ? nodeToSection(link.target) : null;
		const sourceSection = link ? nodeToSection(link.source) : null;
		const dimmed =
			activeSection !== null && section !== activeSection && sourceSection !== activeSection;
		const d = `M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`;

		return (
			<Layer key={`SankeyLink${index}`}>
				<path
					d={d}
					fill="none"
					stroke={color}
					strokeWidth={linkWidth}
					strokeOpacity={dimmed ? 0.05 : 0.2}
					style={{ pointerEvents: "none", transition: "stroke-opacity 1000ms" }}
				/>
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

/* ------------------------------------------------------------------ */
/*  Funding Level Slider                                              */
/* ------------------------------------------------------------------ */

const SLIDER_MIN = 0;
const SLIDER_MAX = 40;

function FundingSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
	const ticks: number[] = [];
	for (let i = SLIDER_MIN; i <= SLIDER_MAX; i++) ticks.push(i);

	return (
		<div className="mb-4">
			{/* Tier threshold marks above the slider */}
			<div className="relative w-full h-6 mb-1">
				{TIER_THRESHOLDS.map((tier) => {
					const pct = ((tier.price - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
					return (
						<div
							key={tier.id}
							className="absolute -translate-x-1/2 flex flex-col items-center"
							style={{ left: `${pct}%`, bottom: 0 }}
						>
							<span
								className={`text-[10px] mb-0.5 ${tierForAmount(value)?.id === tier.id ? "text-base-content font-semibold" : "text-base-content/40"}`}
							>
								{tier.name}
							</span>
							<div className="w-px h-3 bg-base-content/20" />
						</div>
					);
				})}
			</div>
			<input
				type="range"
				min={SLIDER_MIN}
				max={SLIDER_MAX}
				step={1}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="range range-success w-full"
			/>
			<div className="relative w-full h-6 mt-1">
				{ticks.map((tick) => {
					const pct = ((tick - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
					const isLabeled = tick % 5 === 0;
					return (
						<div
							key={tick}
							className="absolute -translate-x-1/2 flex flex-col items-center"
							style={{ left: `${pct}%` }}
						>
							<div className={`bg-base-content/20 ${isLabeled ? "w-px h-3" : "w-px h-1.5"}`} />
							{isLabeled && (
								<span className="text-[10px] text-base-content/40 mt-0.5">${tick}</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Tier Cards                                                        */
/* ------------------------------------------------------------------ */

function TierCard({
	tier,
	currentTier,
	sliderTier,
	onSelect,
	subscribing,
}: {
	tier: SubscriptionTierOption;
	currentTier: string;
	sliderTier: string | null;
	onSelect: (tier: string) => void;
	subscribing: string | null;
}) {
	const isCurrentTier = tier.id === currentTier;
	const isSliderTier = tier.id === sliderTier;
	const isFree = tier.id === "free";

	return (
		<div
			className={`card bg-base-200/60 shadow-xl border-2 transition-all ${
				isSliderTier
					? "ring-2 ring-success border-success"
					: isCurrentTier
						? "ring-2 ring-primary/40 border-primary/40"
						: "border-base-300"
			}`}
		>
			<div className="card-body items-center text-center p-4">
				<h3 className="card-title text-lg">{tier.name}</h3>
				<div className="flex items-baseline gap-1 my-1">
					<span className="text-2xl font-bold">{isFree ? "Free" : `$${tier.price}`}</span>
					{!isFree && <span className="text-sm text-base-content/60">/mo</span>}
				</div>
				<div className="card-actions mt-2">
					{isCurrentTier ? (
						<button type="button" className="btn btn-success btn-sm w-full" disabled>
							Current Plan
						</button>
					) : isFree ? (
						<button type="button" className="btn btn-ghost btn-sm w-full" disabled>
							Default Tier
						</button>
					) : (
						<button
							type="button"
							className={`btn btn-sm w-full btn-outline btn-primary ${subscribing === tier.id ? "btn-disabled" : ""}`}
							onClick={() => onSelect(tier.id)}
							disabled={!!subscribing}
						>
							{subscribing === tier.id
								? "Redirecting..."
								: currentTier !== "free"
									? `Start at ${tier.name}`
									: `Subscribe`}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Hover-conditional content sections                                */
/* ------------------------------------------------------------------ */

const SECTION_KEYS: { keys: SectionKey[]; id: string }[] = [
	{ keys: ["support"], id: "support" },
	{ keys: ["foundation"], id: "foundation" },
	{ keys: ["fees"], id: "fees" },
];

function dimClass(active: SectionKey, keys: SectionKey[]): string {
	if (active === null) return "";
	return keys.includes(active) ? "" : "opacity-25";
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
					{id === "fees" && <FeesSection />}
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
				92% of your subscription goes to creators through two pools. The <strong>Time Pool</strong>{" "}
				($2.76) is distributed automatically, proportional to your time with each creator — whether
				you're watching videos, listening to music, reading articles, or playing games. The{" "}
				<strong>Boost Pool</strong> is everything above that — it lets you direct extra funds to
				specific creators. Your boost determines which gated content you unlock. Boost starts at any
				funding level above $3.
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
				8% of your subscription funds the Anthers Foundation, which allocates between charitable
				programs and organizational operations. At least 50% goes to programs in any year. The
				Foundation publishes quarterly allocation reports.
			</p>
		</div>
	);
}

function FeesSection() {
	return (
		<div className="card bg-base-200/60 shadow-xl p-4 h-full">
			<div className="flex items-center gap-2 mb-2">
				<div className="flex gap-1">
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.delivery }} />
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.cardFee }} />
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.salesTax }} />
				</div>
				<h3 className="font-semibold text-sm">Fees</h3>
			</div>
			<p className="text-xs text-base-content/60 leading-relaxed">
				<strong>Delivery:</strong> bandwidth cost of content you consume, billed based on actual
				usage. Video costs the most; audio is ~30x cheaper per minute; text is essentially free.
				Smart quality controls, caching, downloads, and shared viewing help keep costs low.{" "}
				<strong>Processing:</strong> 2.9% + $0.30 for credit/debit cards, or 0.8% (max $5) for bank
				payments (ACH). <strong>Sales tax:</strong> estimated at the national average (~6.6%).
				Actual tax may vary by state and locality.
			</p>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Creator scenario sliders                                          */
/* ------------------------------------------------------------------ */

function CreatorSliders({
	label,
	timePct,
	boostPct,
	boostAmt,
	boostDisabled,
	onTimeChange,
	onBoostChange,
	poolColor,
	boostColor,
}: {
	label: string;
	timePct: number;
	boostPct: number;
	boostAmt: string;
	boostDisabled: boolean;
	onTimeChange: (v: number) => void;
	onBoostChange: (v: number) => void;
	poolColor: string;
	boostColor: string;
}) {
	const [hover, setHover] = useState<"time" | "boost" | null>(null);

	return (
		<div className="space-y-2 px-4 first:pl-0">
			<label className="text-xs font-semibold text-center block">{label}</label>
			<div
				className="flex items-center gap-2"
				onMouseEnter={() => setHover("time")}
				onMouseLeave={() => setHover(null)}
			>
				<span className="text-[10px] text-base-content/40 w-12">Time</span>
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={timePct}
					onChange={(e) => onTimeChange(Number(e.target.value))}
					className="range range-xs flex-1"
					style={{ color: poolColor }}
				/>
				<span className="text-xs w-8 text-right">{timePct}%</span>
			</div>
			<div
				className="flex items-center gap-2"
				onMouseEnter={() => setHover("boost")}
				onMouseLeave={() => setHover(null)}
			>
				<span className="text-[10px] text-base-content/40 w-12">Boost</span>
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={boostPct}
					onChange={(e) => onBoostChange(Number(e.target.value))}
					className="range range-xs flex-1"
					style={{ color: boostColor }}
					disabled={boostDisabled}
				/>
				<span className="text-xs w-8 text-right">{boostAmt}</span>
			</div>
			<div className="mt-1 space-y-0.5">
				<p
					className={`text-[10px] leading-tight transition-colors duration-200 ${
						hover === "time" ? "text-base-content/60" : "text-base-content/20"
					}`}
				>
					Time — your consumption across all media. Drives the Time Pool split automatically.
				</p>
				<p
					className={`text-[10px] leading-tight transition-colors duration-200 ${
						hover === "boost" ? "text-base-content/60" : "text-base-content/20"
					}`}
				>
					Boost — extra funds you direct to this creator. Determines which gated content you unlock.
				</p>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_FUNDING = 7;

export default function SubscribePage() {
	const { user } = useAuth();
	const [searchParams] = useSearchParams();

	const [tiers, setTiers] = useState<SubscriptionTierOption[]>([]);
	const [currentSub, setCurrentSub] = useState<Subscription | null>(null);
	const [loading, setLoading] = useState(true);
	const [subscribing, setSubscribing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [activeSection, setActiveSection] = useState<SectionKey>(null);

	// --- Interactive controls ---
	const [fundingLevel, setFundingLevel] = useState(DEFAULT_FUNDING);

	// Creator time % — zero-sum, always sums to 100
	const [timePcts, setTimePcts] = useState<[number, number, number]>([51, 26, 23]);

	/**
	 * Update one slider in a zero-sum triple and distribute the change
	 * equally across the other two, clamping at 0.
	 */
	const setTime = useCallback((idx: 0 | 1 | 2, newVal: number) => {
		setTimePcts((prev) => zeroSumUpdate(prev, idx, newVal, 100));
	}, []);

	// Creator boost % — zero-sum, always sums to 100
	const [boostPcts, setBoostPcts] = useState<[number, number, number]>([68, 20, 12]);

	const boostTotal = useMemo(() => {
		return computePools(fundingLevel).boostPool;
	}, [fundingLevel]);

	const setBoost = useCallback((idx: 0 | 1 | 2, newVal: number) => {
		setBoostPcts((prev) => zeroSumUpdate(prev, idx, newVal, 100));
	}, []);

	// Content hours (non-linear slider: 0–1000 position → 0–200 hrs)
	const [streamSlider, setStreamSlider] = useState(() => hrsToSlider(25));
	const streamHours = sliderToHrs(streamSlider);

	// Payment method
	const [useCard, setUseCard] = useState(true);

	// --- Computed values ---
	const currentTier = tierForAmount(fundingLevel);
	const grossDelivery = r2(streamHours * DELIVERY_PER_HOUR);
	const deliveryAmt = r2(Math.max(0, grossDelivery - DELIVERY_CREDIT));
	const subtotal = r2(fundingLevel + deliveryAmt);
	const cardFee = computeCardFee(subtotal, useCard);
	const cardFeeIfCard = computeCardFee(subtotal, true);
	const cardFeeIfBank = computeCardFee(subtotal, false);
	const cardFeeSavings = r2(cardFeeIfCard - cardFeeIfBank);
	const salesTax = computeSalesTax(subtotal);

	// Show the full Sankey diagram, or just the Foundation explainer?
	const showDiagram = fundingLevel > 0 || deliveryAmt > 0;

	const poolSplits: [number, number, number] = [
		timePcts[0] / 100,
		timePcts[1] / 100,
		timePcts[2] / 100,
	];

	const boostSplits: [number, number, number] = [
		boostPcts[0] / 100,
		boostPcts[1] / 100,
		boostPcts[2] / 100,
	];

	const sankeyData = useMemo(
		() =>
			buildSankey({
				fundingLevel,
				grossDelivery,
				deliveryAmt,
				cardFee,
				salesTax,
				poolSplits,
				boostSplits,
			}),
		[fundingLevel, grossDelivery, deliveryAmt, cardFee, salesTax, poolSplits, boostSplits],
	);

	const onSectionEnter = useCallback((s: SectionKey) => setActiveSection(s), []);
	const onSectionLeave = useCallback(() => setActiveSection(null), []);

	const sankeyNode = useMemo(
		() => makeSankeyNodeComponent(onSectionEnter, onSectionLeave, activeSection, sankeyData.meta),
		[onSectionEnter, onSectionLeave, activeSection, sankeyData],
	);
	const sankeyLink = useMemo(
		() => makeSankeyLinkComponent(onSectionEnter, onSectionLeave, activeSection, sankeyData),
		[onSectionEnter, onSectionLeave, activeSection, sankeyData],
	);

	const wasCanceled = searchParams.get("canceled") === "true";

	useEffect(() => {
		const fetchData = async () => {
			try {
				const [tierRes, subRes] = await Promise.all([
					client.api.subscriptions.tiers.$get(),
					user ? client.api.subscriptions.me.$get() : Promise.resolve(null),
				]);
				const tierData = (await tierRes.json()) as { tiers: SubscriptionTierOption[] };
				setTiers(tierData.tiers);
				if (subRes) {
					const subData = (await subRes.json()) as { subscription: Subscription };
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
			const data = (await res.json()) as { checkoutUrl?: string; tier?: string };
			if (data.checkoutUrl) {
				window.location.href = data.checkoutUrl;
			} else {
				const subRes = await client.api.subscriptions.me.$get();
				const subData = (await subRes.json()) as { subscription: Subscription };
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

	const userTier = currentSub?.tier || "free";

	return (
		<div className="mx-auto px-4 py-8" style={{ maxWidth: "110rem" }}>
			<div className="text-center mb-8">
				<p className="text-xs uppercase tracking-wider text-base-content/40 mb-1">
					501(c)(3) non-profit
				</p>
				<h1 className="text-3xl font-bold mb-2">Support Your Creators</h1>
				<p className="text-base-content/70 max-w-xl mx-auto">
					Pick a starting tier, then adjust your support level anytime. Every dollar splits the same
					way: 92% to creators, 8% to the Anthers Foundation. You're always in control.
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

			{/* Tier cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-12">
				{tiers.map((tier) => (
					<TierCard
						key={tier.id}
						tier={tier}
						currentTier={userTier}
						sliderTier={currentTier?.id ?? null}
						onSelect={handleSelect}
						subscribing={subscribing}
					/>
				))}
			</div>

			{/* Build Your Scenario */}
			<div className="mt-16">
				<div className="card bg-base-200/60 shadow-xl p-5 overflow-x-auto">
					<h2 className="text-2xl font-bold mb-2 text-center">Build Your Scenario</h2>
					<p className="text-sm text-base-content/60 text-center max-w-2xl mx-auto mb-6">
						Set your subscription level, adjust how you split time and boost funds across creators,
						estimate your content consumption, and see the full cost breakdown below.
					</p>

					{/* ---- Subscription funding slider ---- */}
					<FundingSlider value={fundingLevel} onChange={setFundingLevel} />

					{/* ---- Customization controls ---- */}
					<div className="divider text-xs text-base-content/30 my-2">Customize the scenario</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-x divide-base-content/10 mb-2">
						{/* Creator A */}
						<CreatorSliders
							label="Creator A"
							timePct={timePcts[0]}
							boostPct={boostPcts[0]}
							boostAmt={fmt(boostTotal * boostSplits[0])}
							boostDisabled={boostTotal <= 0}
							onTimeChange={(v) => setTime(0, v)}
							onBoostChange={(v) => setBoost(0, v)}
							poolColor={COLORS.pool}
							boostColor={COLORS.boost}
						/>

						{/* Creator B */}
						<CreatorSliders
							label="Creator B"
							timePct={timePcts[1]}
							boostPct={boostPcts[1]}
							boostAmt={fmt(boostTotal * boostSplits[1])}
							boostDisabled={boostTotal <= 0}
							onTimeChange={(v) => setTime(1, v)}
							onBoostChange={(v) => setBoost(1, v)}
							poolColor={COLORS.pool}
							boostColor={COLORS.boost}
						/>

						{/* Creator C */}
						<CreatorSliders
							label="Creator C"
							timePct={timePcts[2]}
							boostPct={boostPcts[2]}
							boostAmt={fmt(boostTotal * boostSplits[2])}
							boostDisabled={boostTotal <= 0}
							onTimeChange={(v) => setTime(2, v)}
							onBoostChange={(v) => setBoost(2, v)}
							poolColor={COLORS.pool}
							boostColor={COLORS.boost}
						/>

						{/* Content delivery hours */}
						<div className="space-y-2 px-4 last:pr-0">
							<label className="text-xs font-semibold text-center block">Content Delivery</label>
							<div className="flex items-center gap-2">
								{(() => {
									const creditThresholdHrs = Math.round(DELIVERY_CREDIT / DELIVERY_PER_HOUR);
									return (
										<div className="flex-1 relative mb-5">
											<input
												type="range"
												min={0}
												max={1000}
												step={1}
												value={streamSlider}
												onChange={(e) => setStreamSlider(Number(e.target.value))}
												className="range range-xs w-full"
												style={{ color: deliveryAmt > 0 ? COLORS.delivery : "#14b8a6" }}
											/>
											{/* Threshold marker where the $1 credit runs out */}
											<div
												className="absolute top-full mt-0.5 -translate-x-1/2 flex flex-col items-center pointer-events-none"
												style={{ left: `${(hrsToSlider(creditThresholdHrs) / 1000) * 100}%` }}
											>
												<div className="w-px h-2.5 bg-success" />
												<span className="text-[9px] text-success font-semibold whitespace-nowrap">
													~{creditThresholdHrs}h free
												</span>
											</div>
										</div>
									);
								})()}
								<span className="text-xs w-14 text-right">{streamHours} hrs</span>
							</div>
							<p className="text-[10px] leading-tight">
								<span className={deliveryAmt > 0 ? "text-warning" : "text-success"}>
									{deliveryAmt > 0
										? `$1.00 credit applied — ${fmt(deliveryAmt)} billable delivery`
										: `$1.00/mo delivery credit covers this — no delivery charge`}
								</span>
							</p>
							<p className="text-[10px] text-base-content/30 leading-tight">
								Assumes 1080/60 video (~{fmt(grossDelivery)} gross). Audio costs ~30x less, text is
								essentially free. Downloads, caching, shared viewing, and auto-quality also reduce
								costs.
							</p>
						</div>
					</div>
					<div className="divider my-2" />

					{/* ---- Cost breakdown ---- */}
					<div className="flex justify-center mb-4">
						<div className="text-sm w-full max-w-lg">
							{/* Subscription amount */}
							<div className="flex items-center justify-between py-2 border-b border-base-content/10">
								<span className="text-base-content/60">Subscription</span>
								<div className="flex items-baseline gap-1">
									<span className="text-xl font-bold">${fundingLevel}</span>
									<span className="text-base-content/40 text-xs">/mo</span>
									{!sankeyData.hasBoost && fundingLevel > 0 && (
										<span className="text-xs text-base-content/40 ml-2">
											(above $3 for Boost Pool)
										</span>
									)}
								</div>
							</div>

							{/* Individual cost elements */}
							<div className="py-2 space-y-1.5">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.pool }}
										/>
										<span className="text-base-content/70">Time Pool</span>
									</div>
									<strong>{fmt(computePools(fundingLevel).timePool)}</strong>
								</div>
								{sankeyData.hasBoost && (
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2">
											<div
												className="w-2.5 h-2.5 rounded-sm"
												style={{ backgroundColor: COLORS.boost }}
											/>
											<span className="text-base-content/70">Boost Pool</span>
										</div>
										<strong>{fmt(boostTotal)}</strong>
									</div>
								)}
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.foundation }}
										/>
										<span className="text-base-content/70">Anthers Foundation</span>
									</div>
									<strong>{fmt(r2(fundingLevel * ALLOC.foundation))}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.delivery }}
										/>
										<span className="text-base-content/70">
											Delivery
											{deliveryAmt === 0 && (
												<span className="text-success text-xs ml-1">($1 credit covers this)</span>
											)}
											{deliveryAmt > 0 && (
												<span className="text-base-content/40 text-xs ml-1">
													({fmt(grossDelivery)} − $1.00 credit)
												</span>
											)}
										</span>
									</div>
									<strong>{fmt(deliveryAmt)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.salesTax }}
										/>
										<span className="text-base-content/70">Est. sales tax</span>
									</div>
									<strong>{fmt(salesTax)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.cardFee }}
										/>
										<span className="text-base-content/70">{useCard ? "Card" : "Bank"} fee</span>
										<span
											className={`text-[10px] cursor-pointer ${useCard ? "font-semibold" : "text-base-content/40"}`}
											onClick={() => setUseCard(true)}
										>
											Card
										</span>
										<input
											type="checkbox"
											className="toggle toggle-xs toggle-primary"
											checked={!useCard}
											onChange={(e) => setUseCard(!e.target.checked)}
										/>
										<span
											className={`text-[10px] cursor-pointer ${!useCard ? "font-semibold" : "text-base-content/40"}`}
											onClick={() => setUseCard(false)}
										>
											Bank
										</span>
										{!useCard && cardFeeSavings > 0 && (
											<span className="text-[10px] text-success">
												({fmt(cardFeeSavings)} saved vs. card)
											</span>
										)}
									</div>
									<strong>{fmt(cardFee)}</strong>
								</div>
							</div>

							{/* Total w/Fees */}
							<div className="flex items-center justify-between pt-2 border-t border-base-content/20">
								<span className="font-bold">Total w/Fees</span>
								<div className="flex items-baseline gap-1">
									<span className="text-xl font-bold">{fmt(sankeyData.totalPayment)}</span>
									<span className="text-base-content/40 text-xs">/mo</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Where Your Money Goes */}
			<div className="mt-10">
				<div className="card bg-base-200/60 shadow-xl p-5 overflow-x-auto">
					<h2 className="text-2xl font-bold mb-2 text-center">Where Your Money Goes</h2>
					<p className="text-sm text-base-content/60 text-center max-w-2xl mx-auto mb-6">
						The split is always the same: 92% to creators, 8% to the Anthers Foundation. Delivery,
						processing, and tax are separate pass-through fees — Anthers keeps none of it.
					</p>

					{/* Section cards */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
						<SectionContent
							section={activeSection}
							onEnter={onSectionEnter}
							onLeave={onSectionLeave}
						/>
					</div>

					{/* ---- Sankey diagram or Foundation explainer ---- */}
					<div className="relative">
						{/* Sankey diagram */}
						<div
							className="transition-all duration-700 ease-in-out"
							style={{
								opacity: showDiagram ? 1 : 0,
								maxHeight: showDiagram ? "900px" : "0px",
								overflow: "hidden",
							}}
						>
							<p className="text-xs text-base-content/30 mb-3">Hover any section to learn more</p>

							<div style={{ minWidth: 1000 }}>
								<ResponsiveContainer width="100%" height={800}>
									<Sankey
										data={sankeyData.data}
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
								92% of your subscription goes directly to creators. 8% funds the Anthers Foundation.
								Delivery, processing, and tax are separate fees.
							</p>
						</div>

						{/* Foundation explainer (when diagram is hidden) */}
						<div
							className="transition-all duration-700 ease-in-out"
							style={{
								opacity: showDiagram ? 0 : 1,
								maxHeight: showDiagram ? "0px" : "400px",
								overflow: "hidden",
							}}
						>
							<div className="flex flex-col items-center justify-center py-16 px-8 max-w-2xl mx-auto text-center">
								<div
									className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
									style={{ backgroundColor: `${COLORS.programs}20` }}
								>
									<div
										className="w-8 h-8 rounded-full"
										style={{ backgroundColor: COLORS.programs }}
									/>
								</div>
								<h3 className="text-lg font-bold mb-2">The Foundation has you covered</h3>
								<p className="text-sm text-base-content/60 leading-relaxed">
									Every Anthers user — including free users — gets a{" "}
									<strong>$1/month delivery credit</strong> funded by the Anthers Foundation. That's
									enough for roughly 15 hours of 1080p video — and significantly more for audio or
									text, which cost a fraction of video to deliver. At your current consumption
									level, the Foundation covers your entire delivery cost.
								</p>
								<p className="text-xs text-base-content/40 mt-4">
									Increase your subscription or streaming above the credit to see the full flow
									diagram.
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Why Non-Profit */}
			<div className="mt-16 max-w-3xl mx-auto text-center pb-4">
				<h2 className="text-xl font-bold mb-3">Why Non-Profit</h2>
				<p className="text-sm text-base-content/60 leading-relaxed max-w-2xl mx-auto">
					Anthers is a non-profit because the only way to guarantee that our platform always serves
					creators is to make it legally impossible for it to act otherwise. Anthers cannot
					distribute profits to insiders, cannot be acquired, and cannot have its mission diluted by
					investors. If it ever ceases to operate, its assets go to another exempt organization, not
					to founders or shareholders.
				</p>
			</div>
		</div>
	);
}

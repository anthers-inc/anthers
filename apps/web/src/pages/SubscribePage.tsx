// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BADGE_THRESHOLDS,
	BANDWIDTH_PER_GIB,
	badgeForSpend,
	badgeLabel,
	CARD_FLAT,
	CARD_RATE,
	FREE_USAGE_GIB,
	SALES_TAX_RATE,
	TIME_POOL_PER_GIB,
	USAGE_AFF_PER_GIB,
	USAGE_PACK_GIB,
	USAGE_PER_GIB,
} from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type { Account, AccountResponse, Badge, BadgeOption } from "@anthers/web-shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Layer,
	Rectangle,
	ResponsiveContainer,
	Sankey,
	type SankeyLinkProps,
	type SankeyNodeProps,
	useChartWidth,
} from "recharts";

/* ------------------------------------------------------------------ */
/*  V3 economics — Anthers keeps $0                                    */
/* ------------------------------------------------------------------ */
/*
 * A user makes two independent, prepaid choices:
 *   • Usage (GiB)  → usageGiB × $0.03 = bandwidth (at cost) + Foundation AFF + Time Pool
 *   • Boost ($)    → whole dollars, 100% to creators
 * Combined spend (usage $ + boost $) sets a rolling Anthers Badge.
 * Card processing + sales tax are added on top; both leave the system.
 */

/** Usage is sold in 100 GiB packs; the interactive selector offers 0–4 packs. */
const USAGE_STEPS = [0, 1, 2, 3, 4].map((packs) => packs * USAGE_PACK_GIB); // 0/100/200/300/400 GiB
const MAX_USAGE_GIB = USAGE_STEPS[USAGE_STEPS.length - 1];

/**
 * 1080p60 AV1 reference throughput (GiB/hr), from the V3 spec (§2/§11). Used only
 * to render a friendly "≈ N watch-hours" helper beside a GiB figure — display-only,
 * never part of the price math.
 */
const GIB_PER_HOUR_1080P60 = 1.7;

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}
function watchHours(gib: number): number {
	return Math.round(gib / GIB_PER_HOUR_1080P60);
}

/** The itemized V3 breakdown for a (usageGiB, boostTotal) pair. */
interface Economics {
	usageGiB: number;
	boostTotal: number;
	/** Usage subtotal = usageGiB × $0.03. */
	usageSpend: number;
	/** Delivery/egress, a pass-through at DigitalOcean cost. */
	bandwidth: number;
	/** Anthers Foundation Fee on usage (AFF). */
	foundation: number;
	/** Time Pool — to creators, distributed by watch-time. */
	timePool: number;
	/** Boost — 100% to creators. */
	boost: number;
	/** Badge basis = usage subtotal + boost. */
	subtotal: number;
	/** Everything creators receive = Time Pool + Boost. */
	toCreators: number;
	cardFee: number;
	salesTax: number;
	/** All-in = subtotal + card + tax. */
	total: number;
	badge: Badge;
}

function computeEconomics(usageGiB: number, boostTotal: number): Economics {
	const bandwidth = r2(usageGiB * BANDWIDTH_PER_GIB);
	const foundation = r2(usageGiB * USAGE_AFF_PER_GIB);
	const timePool = r2(usageGiB * TIME_POOL_PER_GIB);
	const usageSpend = r2(usageGiB * USAGE_PER_GIB);
	const boost = r2(boostTotal);
	const subtotal = r2(usageSpend + boost);
	const toCreators = r2(timePool + boost);
	const cardFee = subtotal > 0 ? r2(subtotal * CARD_RATE + CARD_FLAT) : 0;
	const salesTax = subtotal > 0 ? r2(subtotal * SALES_TAX_RATE) : 0;
	const total = r2(subtotal + cardFee + salesTax);
	return {
		usageGiB,
		boostTotal,
		usageSpend,
		bandwidth,
		foundation,
		timePool,
		boost,
		subtotal,
		toCreators,
		cardFee,
		salesTax,
		total,
		badge: badgeForSpend(subtotal),
	};
}

/* ------------------------------------------------------------------ */
/*  Colors                                                            */
/* ------------------------------------------------------------------ */

const COLORS = {
	usage: "#2563eb", // blue — the Usage source
	boost: "#c026d3", // fuchsia — the Boost source
	timePool: "#7c3aed", // violet — Time Pool
	bandwidth: "#0ea5e9", // sky — bandwidth (at cost)
	foundation: "#0f766e", // teal — Anthers Foundation
	crA: "#4c1d95",
	crB: "#6d28d9",
	crC: "#8b5cf6",
	cardFee: "#d97706", // amber — processing
	salesTax: "#737373", // neutral — tax
	muted: "#a3a3a3",
};

/* ------------------------------------------------------------------ */
/*  Zero-sum split helper (for the illustrative creator sliders)      */
/* ------------------------------------------------------------------ */

/**
 * Zero-sum update for a triple of slider values. When one slider moves, the delta
 * is distributed equally across the other two, spilling to whichever can absorb it.
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

	let toDistribute = -delta;
	const perOther = Math.round(toDistribute / 2);

	for (const i of others) {
		const adjusted = Math.max(0, next[i] + perOther);
		toDistribute -= adjusted - next[i];
		next[i] = adjusted;
	}

	if (toDistribute !== 0) {
		for (const i of others) {
			const adjusted = Math.max(0, next[i] + toDistribute);
			toDistribute -= adjusted - next[i];
			next[i] = adjusted;
			if (toDistribute === 0) break;
		}
	}

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
/*  Sankey builder — V3 flows                                          */
/* ------------------------------------------------------------------ */
/*
 * Usage → { Bandwidth (at cost), Anthers Foundation, Time Pool → creators }
 * Boost → creators
 * Card + Tax → { Processing Fee, Sales Tax }  (added on top, leave the system)
 */

interface SankeyParams {
	eco: Economics;
	timeSplits: [number, number, number];
	boostSplits: [number, number, number];
}

function buildSankey({ eco, timeSplits, boostSplits }: SankeyParams) {
	const { bandwidth, foundation, timePool, boost, cardFee, salesTax } = eco;
	const hasBoost = boost > 0;

	const poolA = r2(timePool * timeSplits[0]);
	const poolB = r2(timePool * timeSplits[1]);
	const poolC = r2(timePool - poolA - poolB);

	const boostA = hasBoost ? r2(boost * boostSplits[0]) : 0;
	const boostB = hasBoost ? r2(boost * boostSplits[1]) : 0;
	const boostC = hasBoost ? r2(boost - boostA - boostB) : 0;

	const crA = r2(poolA + boostA);
	const crB = r2(poolB + boostB);
	const crC = r2(poolC + boostC);

	const N = {
		USAGE: 0,
		BOOST: 1,
		FEES: 2,
		BANDWIDTH: 3,
		FOUNDATION: 4,
		TIMEPOOL: 5,
		CREATOR_A: 6,
		CREATOR_B: 7,
		CREATOR_C: 8,
		CARDFEE: 9,
		SALESTAX: 10,
	} as const;

	const nodes = [
		{ name: "Usage" },
		{ name: "Boost" },
		{ name: "Card + Tax" },
		{ name: "Bandwidth" },
		{ name: "Anthers Foundation" },
		{ name: "Time Pool" },
		{ name: "Creator A" },
		{ name: "Creator B" },
		{ name: "Creator C" },
		{ name: "Processing Fee" },
		{ name: "Sales Tax" },
	];

	const links: { source: number; target: number; value: number }[] = [];

	// Usage → bandwidth (at cost) + Foundation AFF + Time Pool
	if (bandwidth > 0) links.push({ source: N.USAGE, target: N.BANDWIDTH, value: bandwidth });
	if (foundation > 0) links.push({ source: N.USAGE, target: N.FOUNDATION, value: foundation });
	if (timePool > 0) links.push({ source: N.USAGE, target: N.TIMEPOOL, value: timePool });

	// Time Pool → creators (by watch-time)
	if (poolA > 0) links.push({ source: N.TIMEPOOL, target: N.CREATOR_A, value: poolA });
	if (poolB > 0) links.push({ source: N.TIMEPOOL, target: N.CREATOR_B, value: poolB });
	if (poolC > 0) links.push({ source: N.TIMEPOOL, target: N.CREATOR_C, value: poolC });

	// Boost → creators (directed)
	if (boostA > 0) links.push({ source: N.BOOST, target: N.CREATOR_A, value: boostA });
	if (boostB > 0) links.push({ source: N.BOOST, target: N.CREATOR_B, value: boostB });
	if (boostC > 0) links.push({ source: N.BOOST, target: N.CREATOR_C, value: boostC });

	// Card + tax → processing + tax (leave the system)
	if (cardFee > 0) links.push({ source: N.FEES, target: N.CARDFEE, value: cardFee });
	if (salesTax > 0) links.push({ source: N.FEES, target: N.SALESTAX, value: salesTax });

	const meta: { label: string; sub: string; color: string }[] = [
		{ label: "Usage", sub: fmt(eco.usageSpend), color: COLORS.usage },
		{ label: "Boost", sub: fmt(boost), color: COLORS.boost },
		{ label: "Card + Tax", sub: fmt(r2(cardFee + salesTax)), color: COLORS.cardFee },
		{ label: "Bandwidth", sub: fmt(bandwidth), color: COLORS.bandwidth },
		{ label: "Anthers Foundation", sub: fmt(foundation), color: COLORS.foundation },
		{ label: "Time Pool", sub: fmt(timePool), color: COLORS.timePool },
		{ label: "Creator A", sub: fmt(crA), color: COLORS.crA },
		{ label: "Creator B", sub: fmt(crB), color: COLORS.crB },
		{ label: "Creator C", sub: fmt(crC), color: COLORS.crC },
		{ label: "Processing Fee", sub: fmt(cardFee), color: COLORS.cardFee },
		{ label: "Sales Tax", sub: fmt(salesTax), color: COLORS.salesTax },
	];

	const linkColors: Record<number, string> = {};
	links.forEach((link, i) => {
		const { source, target } = link;
		if (source === N.USAGE) {
			if (target === N.BANDWIDTH) linkColors[i] = COLORS.bandwidth;
			else if (target === N.FOUNDATION) linkColors[i] = COLORS.foundation;
			else linkColors[i] = COLORS.timePool;
		} else if (source === N.TIMEPOOL) {
			linkColors[i] = COLORS.timePool;
		} else if (source === N.BOOST) {
			linkColors[i] = COLORS.boost;
		} else if (source === N.FEES) {
			linkColors[i] = target === N.CARDFEE ? COLORS.cardFee : COLORS.salesTax;
		} else {
			linkColors[i] = COLORS.muted;
		}
	});

	return { data: { nodes, links }, meta, linkColors };
}

/* ------------------------------------------------------------------ */
/*  Sankey hover logic                                                */
/* ------------------------------------------------------------------ */

const CREATOR_NODES: Set<number> = new Set([6, 7, 8]);

type SectionKey = "support" | "foundation" | "cost" | null;

function nodeToSection(index: number): SectionKey {
	// Boost (1), Time Pool (5), Creators (6–8) → money to creators
	if (index === 1 || index === 5 || CREATOR_NODES.has(index)) return "support";
	// Anthers Foundation (4)
	if (index === 4) return "foundation";
	// Card + Tax (2), Bandwidth (3), Processing (9), Sales Tax (10)
	if (index === 2 || index === 3 || index === 9 || index === 10) return "cost";
	// Usage (0) feeds every column — neutral
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
/*  Usage selector (100 GiB packs)                                    */
/* ------------------------------------------------------------------ */

function UsageSelector({
	usageGiB,
	onChange,
}: {
	usageGiB: number;
	onChange: (gib: number) => void;
}) {
	return (
		<div className="mb-2">
			<input
				type="range"
				min={0}
				max={MAX_USAGE_GIB}
				step={USAGE_PACK_GIB}
				value={Math.min(usageGiB, MAX_USAGE_GIB)}
				onChange={(e) => onChange(Number(e.target.value))}
				className="range range-primary w-full"
			/>
			<div className="relative w-full h-9 mt-1">
				{USAGE_STEPS.map((gib) => {
					const pct = (gib / MAX_USAGE_GIB) * 100;
					const active = gib === usageGiB;
					return (
						<div
							key={gib}
							className="absolute -translate-x-1/2 flex flex-col items-center"
							style={{ left: `${pct}%` }}
						>
							<div className="w-px h-2 bg-base-content/20" />
							<span
								className={`text-[10px] mt-0.5 whitespace-nowrap ${active ? "text-base-content font-semibold" : "text-base-content/40"}`}
							>
								{gib} GiB
							</span>
							<span
								className={`text-[9px] ${active ? "text-primary font-semibold" : "text-base-content/30"}`}
							>
								{fmt(gib * USAGE_PER_GIB)}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Boost input (whole dollars)                                       */
/* ------------------------------------------------------------------ */

function BoostInput({ boost, onChange }: { boost: number; onChange: (v: number) => void }) {
	const set = (v: number) => onChange(Math.max(0, Math.floor(v)));
	return (
		<div className="flex items-center gap-2">
			<button
				type="button"
				className="btn btn-sm btn-circle btn-ghost"
				onClick={() => set(boost - 1)}
				aria-label="Decrease boost"
			>
				−
			</button>
			<div className="join">
				<span className="join-item btn btn-sm btn-disabled no-animation">$</span>
				<input
					type="number"
					min={0}
					step={1}
					value={boost}
					onChange={(e) => set(Number(e.target.value) || 0)}
					className="join-item input input-sm input-bordered w-20 text-center"
					style={{ color: COLORS.boost }}
				/>
			</div>
			<button
				type="button"
				className="btn btn-sm btn-circle btn-ghost"
				onClick={() => set(boost + 1)}
				aria-label="Increase boost"
			>
				+
			</button>
			<span className="text-xs text-base-content/40">whole dollars · 100% to creators</span>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Badge reference cards                                             */
/* ------------------------------------------------------------------ */

function BadgeCards({ badges, currentBadge }: { badges: BadgeOption[]; currentBadge: Badge }) {
	const isFreeActive = currentBadge === "none";
	return (
		<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
			{/* Free floor */}
			<div
				className={`card bg-base-200/60 shadow border-2 transition-all ${
					isFreeActive ? "ring-2 ring-primary border-primary" : "border-base-300"
				}`}
			>
				<div className="card-body items-center text-center p-3">
					<h3 className="font-semibold text-sm">Free</h3>
					<div className="text-lg font-bold">&lt; {fmt(BADGE_THRESHOLDS.root)}</div>
					<span className="text-[10px] text-base-content/50">3 GiB free · no badge</span>
					{isFreeActive && <span className="badge badge-primary badge-xs mt-1">You</span>}
				</div>
			</div>
			{badges.map((badge) => {
				const active = badge.id === currentBadge;
				return (
					<div
						key={badge.id}
						className={`card bg-base-200/60 shadow border-2 transition-all ${
							active ? "ring-2 ring-primary border-primary" : "border-base-300"
						}`}
					>
						<div className="card-body items-center text-center p-3">
							<h3 className="font-semibold text-sm">{badge.name}</h3>
							<div className="text-lg font-bold">≥ {fmt(badge.threshold)}</div>
							<span className="text-[10px] text-base-content/50">combined spend</span>
							{active && <span className="badge badge-primary badge-xs mt-1">You</span>}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Hover-conditional explainer sections                              */
/* ------------------------------------------------------------------ */

const SECTION_KEYS: { keys: SectionKey[]; id: string }[] = [
	{ keys: ["support"], id: "support" },
	{ keys: ["foundation"], id: "foundation" },
	{ keys: ["cost"], id: "cost" },
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
					{id === "cost" && <CostSection />}
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
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.timePool }} />
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.boost }} />
				</div>
				<h3 className="font-semibold text-sm">To Creators</h3>
			</div>
			<p className="text-xs text-base-content/60 leading-relaxed">
				Creators are paid two ways. The <strong>Time Pool</strong> is funded by your Usage
				($0.015/GiB) and split across the creators you spend time with — a minute is a minute,
				whether you're watching video, listening to music, reading, or playing.{" "}
				<strong>Boost</strong> is whole dollars you direct to specific creators, and it goes to them
				100% — no fee, no payout processing. Boost also unlocks a creator's Boost-gated content.
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
				The Anthers Foundation Fee (AFF) is 50% of your bandwidth — $0.005 of every Usage GiB. It
				funds the shared subsidy pool that keeps the free tier free (50%), charitable programs
				(40%), and lean operations (10%). It's a charity fee, not a platform cut — Anthers itself
				keeps $0.
			</p>
		</div>
	);
}

function CostSection() {
	return (
		<div className="card bg-base-200/60 shadow-xl p-4 h-full">
			<div className="flex items-center gap-2 mb-2">
				<div className="flex gap-1">
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.bandwidth }} />
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.cardFee }} />
					<div className="w-3 h-6 rounded" style={{ backgroundColor: COLORS.salesTax }} />
				</div>
				<h3 className="font-semibold text-sm">Costs &amp; Fees</h3>
			</div>
			<p className="text-xs text-base-content/60 leading-relaxed">
				<strong>Bandwidth:</strong> the DigitalOcean egress cost of delivering your Usage, passed
				through at cost ($0.01/GiB). <strong>Processing:</strong> 2.9% + $0.30 for card payments.{" "}
				<strong>Sales tax:</strong> estimated at the US average (~6.5%); actual tax varies by state
				and locality. Card and tax are added on top of your subtotal and leave the system — the
				processor and the state, never Anthers.
			</p>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Illustrative per-creator split sliders                            */
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
					Time — your watch-time with this creator. Splits the Time Pool automatically.
				</p>
				<p
					className={`text-[10px] leading-tight transition-colors duration-200 ${
						hover === "boost" ? "text-base-content/60" : "text-base-content/20"
					}`}
				>
					Boost — extra dollars you direct to this creator. Unlocks their Boost-gated content.
				</p>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_USAGE_GIB = USAGE_PACK_GIB; // 100 GiB → Root ($3)
const DEFAULT_BOOST = 0;

export default function SubscribePage() {
	const { user } = useAuth();

	const [badges, setBadges] = useState<BadgeOption[]>([]);
	const [account, setAccount] = useState<Account | null>(null);
	const [serverBadge, setServerBadge] = useState<Badge>("none");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [savedNotice, setSavedNotice] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activeSection, setActiveSection] = useState<SectionKey>(null);

	// --- The two prepaid choices ---
	const [usageGiB, setUsageGiB] = useState(DEFAULT_USAGE_GIB);
	const [boostTotal, setBoostTotal] = useState(DEFAULT_BOOST);

	// --- Illustrative per-creator split (zero-sum, sums to 100) ---
	const [timePcts, setTimePcts] = useState<[number, number, number]>([51, 26, 23]);
	const [boostPcts, setBoostPcts] = useState<[number, number, number]>([68, 20, 12]);

	const setTime = useCallback((idx: 0 | 1 | 2, newVal: number) => {
		setTimePcts((prev) => zeroSumUpdate(prev, idx, newVal, 100));
	}, []);
	const setBoost = useCallback((idx: 0 | 1 | 2, newVal: number) => {
		setBoostPcts((prev) => zeroSumUpdate(prev, idx, newVal, 100));
	}, []);

	// --- Derived economics ---
	const eco = useMemo(() => computeEconomics(usageGiB, boostTotal), [usageGiB, boostTotal]);
	const currentBadge = eco.badge;

	const timeSplits: [number, number, number] = [
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
		() => buildSankey({ eco, timeSplits, boostSplits }),
		[eco, timeSplits, boostSplits],
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

	const showDiagram = eco.subtotal > 0;

	useEffect(() => {
		const fetchData = async () => {
			try {
				const [badgeRes, meRes] = await Promise.all([
					client.api.subscriptions.badges.$get(),
					user ? client.api.subscriptions.me.$get() : Promise.resolve(null),
				]);
				const badgeData = await badgeRes.json();
				setBadges(
					badgeData.badges.map((b) => ({ id: b.id, name: b.name, threshold: b.threshold })),
				);
				if (meRes) {
					const meData = (await meRes.json()) as AccountResponse;
					setAccount(meData.account);
					setServerBadge(meData.badge);
					// Prefill the controls from the saved account (clamp usage to the selector range).
					const savedUsage = Math.min(
						MAX_USAGE_GIB,
						Math.round((meData.account.usageGiB ?? 0) / USAGE_PACK_GIB) * USAGE_PACK_GIB,
					);
					setUsageGiB(savedUsage);
					setBoostTotal(Math.max(0, Math.floor(Number(meData.account.boostTotal ?? 0))));
				}
			} catch {
				setError("Failed to load your account info.");
			} finally {
				setLoading(false);
			}
		};
		fetchData();
	}, [user]);

	const handleSave = async () => {
		if (!user) {
			window.location.href = `/login?next=/subscribe`;
			return;
		}
		setSaving(true);
		setError(null);
		setSavedNotice(false);
		try {
			// TODO: Stripe charges the prepaid delta before this applies (API-side stub).
			const res = await client.api.subscriptions.account.$post({
				json: { usageGiB, boostTotal },
			});
			const data = (await res.json()) as AccountResponse;
			setAccount(data.account);
			setServerBadge(data.badge);
			setSavedNotice(true);
		} catch {
			setError("Failed to save your funding levels. Please try again.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	const savedUsageGiB = account?.usageGiB ?? 0;
	const savedBoost = Math.floor(Number(account?.boostTotal ?? 0));
	const isDirty = user != null && (usageGiB !== savedUsageGiB || boostTotal !== savedBoost);

	return (
		<div className="mx-auto px-4 py-8" style={{ maxWidth: "110rem" }}>
			<div className="text-center mb-8">
				<p className="text-xs uppercase tracking-wider text-base-content/40 mb-1">
					501(c)(3) non-profit
				</p>
				<h1 className="text-3xl font-bold mb-2">Fund creators directly</h1>
				<p className="text-base-content/70 max-w-2xl mx-auto">
					Make two prepaid choices — <strong>Usage</strong> (open, per-GiB access) and{" "}
					<strong>Boost</strong> ($1 units sent straight to specific creators). Every dollar is
					bandwidth at cost, money to creators, or the Anthers Foundation fee. Anthers keeps $0, and
					your combined spend earns a rolling Anthers Badge.
				</p>
			</div>

			{error && (
				<div className="alert alert-error mb-6 max-w-lg mx-auto">
					<span>{error}</span>
				</div>
			)}

			{/* Badge reference cards */}
			<div className="mb-12">
				<BadgeCards badges={badges} currentBadge={currentBadge} />
			</div>

			{/* Build Your Plan */}
			<div className="mt-16">
				<div className="card bg-base-200/60 shadow-xl p-5 overflow-x-auto">
					<h2 className="text-2xl font-bold mb-2 text-center">Build your plan</h2>
					<p className="text-sm text-base-content/60 text-center max-w-2xl mx-auto mb-6">
						Choose your Usage and Boost, see the Anthers Badge you'll earn, and watch the full
						itemized breakdown update below.
					</p>

					{/* ---- Usage + Boost ---- */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-4">
						<div>
							<div className="flex items-baseline justify-between mb-1">
								<label className="text-sm font-semibold">Usage</label>
								<span className="text-xs text-base-content/50">
									{usageGiB} GiB + {FREE_USAGE_GIB} GiB free · {fmt(eco.usageSpend)}
								</span>
							</div>
							<UsageSelector usageGiB={usageGiB} onChange={setUsageGiB} />
							<p className="text-[11px] text-base-content/40 leading-tight">
								≈ {watchHours(usageGiB + FREE_USAGE_GIB)} watch-hours of 1080p60 video (much more
								for audio, text, and images). Sold in {USAGE_PACK_GIB} GiB /{" "}
								{fmt(USAGE_PACK_GIB * USAGE_PER_GIB)} packs; the first {FREE_USAGE_GIB} GiB are
								always free.
							</p>
						</div>
						<div>
							<div className="flex items-baseline justify-between mb-1">
								<label className="text-sm font-semibold">Boost</label>
								<span className="text-xs text-base-content/50">
									{fmt(eco.boost)} · 100% to creators
								</span>
							</div>
							<BoostInput boost={boostTotal} onChange={setBoostTotal} />
							<p className="text-[11px] text-base-content/40 leading-tight mt-2">
								Whole dollars sent to the specific creators you choose. Boost carries no fee and no
								payout processing — a creator keeps every boost dollar, and your boost unlocks their
								Boost-gated content.
							</p>
						</div>
					</div>

					{/* ---- Derived badge ---- */}
					<div className="flex flex-wrap items-center justify-center gap-3 my-4">
						<span className="text-sm text-base-content/60">Your Anthers Badge:</span>
						<span
							className={`badge badge-lg ${currentBadge === "none" ? "badge-ghost" : "badge-primary"}`}
						>
							{badgeLabel(currentBadge)}
						</span>
						<span className="text-sm text-base-content/60">
							from {fmt(eco.subtotal)} combined spend
						</span>
					</div>

					{/* ---- Illustrative creator split ---- */}
					<div className="divider text-xs text-base-content/30 my-2">
						Illustrate the split across three creators
					</div>
					<div className="grid grid-cols-1 md:grid-cols-3 divide-x divide-base-content/10 mb-2">
						<CreatorSliders
							label="Creator A"
							timePct={timePcts[0]}
							boostPct={boostPcts[0]}
							boostAmt={fmt(eco.boost * boostSplits[0])}
							boostDisabled={eco.boost <= 0}
							onTimeChange={(v) => setTime(0, v)}
							onBoostChange={(v) => setBoost(0, v)}
							poolColor={COLORS.timePool}
							boostColor={COLORS.boost}
						/>
						<CreatorSliders
							label="Creator B"
							timePct={timePcts[1]}
							boostPct={boostPcts[1]}
							boostAmt={fmt(eco.boost * boostSplits[1])}
							boostDisabled={eco.boost <= 0}
							onTimeChange={(v) => setTime(1, v)}
							onBoostChange={(v) => setBoost(1, v)}
							poolColor={COLORS.timePool}
							boostColor={COLORS.boost}
						/>
						<CreatorSliders
							label="Creator C"
							timePct={timePcts[2]}
							boostPct={boostPcts[2]}
							boostAmt={fmt(eco.boost * boostSplits[2])}
							boostDisabled={eco.boost <= 0}
							onTimeChange={(v) => setTime(2, v)}
							onBoostChange={(v) => setBoost(2, v)}
							poolColor={COLORS.timePool}
							boostColor={COLORS.boost}
						/>
					</div>
					<div className="divider my-2" />

					{/* ---- Cost breakdown ---- */}
					<div className="flex justify-center mb-4">
						<div className="text-sm w-full max-w-lg">
							{/* Itemized subtotal */}
							<div className="py-2 space-y-1.5">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.bandwidth }}
										/>
										<span className="text-base-content/70">
											Bandwidth
											<span className="text-base-content/40 text-xs ml-1">(at cost)</span>
										</span>
									</div>
									<strong>{fmt(eco.bandwidth)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.foundation }}
										/>
										<span className="text-base-content/70">Anthers Foundation fee</span>
									</div>
									<strong>{fmt(eco.foundation)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.timePool }}
										/>
										<span className="text-base-content/70">Time Pool → creators</span>
									</div>
									<strong>{fmt(eco.timePool)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.boost }}
										/>
										<span className="text-base-content/70">Boost → creators</span>
									</div>
									<strong>{fmt(eco.boost)}</strong>
								</div>
							</div>

							{/* Subtotal + to-creators */}
							<div className="flex items-center justify-between py-2 border-t border-base-content/10">
								<span className="font-semibold">Subtotal (badge basis)</span>
								<strong>{fmt(eco.subtotal)}</strong>
							</div>
							<div className="flex items-center justify-between pb-2 text-success">
								<span>of which, to creators (Time Pool + Boost)</span>
								<strong>{fmt(eco.toCreators)}</strong>
							</div>

							{/* Added on top */}
							<div className="py-2 space-y-1.5 border-t border-base-content/10">
								<p className="text-xs text-base-content/40">Added on top (leaves the system):</p>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.salesTax }}
										/>
										<span className="text-base-content/70">Est. sales tax (~6.5%)</span>
									</div>
									<strong>{fmt(eco.salesTax)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: COLORS.cardFee }}
										/>
										<span className="text-base-content/70">Card processing (2.9% + $0.30)</span>
									</div>
									<strong>{fmt(eco.cardFee)}</strong>
								</div>
							</div>

							{/* All-in total */}
							<div className="flex items-center justify-between pt-2 border-t border-base-content/20">
								<span className="font-bold">Total (all-in)</span>
								<div className="flex items-baseline gap-1">
									<span className="text-xl font-bold">{fmt(eco.total)}</span>
									<span className="text-base-content/40 text-xs">/mo</span>
								</div>
							</div>
						</div>
					</div>

					{/* ---- Save ---- */}
					<div className="flex flex-col items-center gap-2">
						<button
							type="button"
							className={`btn btn-primary ${saving ? "btn-disabled" : ""}`}
							onClick={handleSave}
							disabled={saving || (user != null && !isDirty)}
						>
							{saving
								? "Saving..."
								: !user
									? "Sign in to set your levels"
									: isDirty
										? "Save your funding levels"
										: "Your levels are saved"}
						</button>
						{savedNotice && !isDirty && (
							<span className="text-xs text-success">
								Saved — you're at {badgeLabel(serverBadge)}.
							</span>
						)}
						<p className="text-[11px] text-base-content/40 max-w-md text-center">
							Usage and Boost are fully prepaid and can change anytime — increases apply
							immediately, decreases shrink the pools proportionally. You're never locked into a
							tier.
						</p>
					</div>
				</div>
			</div>

			{/* Where Your Money Goes */}
			<div className="mt-10">
				<div className="card bg-base-200/60 shadow-xl p-5 overflow-x-auto">
					<h2 className="text-2xl font-bold mb-2 text-center">Where your money goes</h2>
					<p className="text-sm text-base-content/60 text-center max-w-2xl mx-auto mb-6">
						Usage splits three ways — bandwidth at cost, the Anthers Foundation fee, and the Time
						Pool that pays creators. Boost goes to creators 100%. Card and tax are separate
						pass-throughs. Anthers keeps $0.
					</p>

					{/* Section cards */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
						<SectionContent
							section={activeSection}
							onEnter={onSectionEnter}
							onLeave={onSectionLeave}
						/>
					</div>

					{/* ---- Sankey diagram or free-tier explainer ---- */}
					<div className="relative">
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
										margin={{ top: 16, right: 180, bottom: 16, left: 140 }}
										sort={false}
										iterations={128}
										linkCurvature={0.5}
										align="left"
										verticalAlign="top"
									/>
								</ResponsiveContainer>
							</div>

							<p className="text-xs text-base-content/40 mt-1 text-center">
								{fmt(eco.toCreators)} of your {fmt(eco.subtotal)} subtotal goes to creators.
								Bandwidth is at cost, the Foundation fee is charity, and card + tax leave the
								system. Anthers keeps $0.
							</p>
						</div>

						{/* Free-tier explainer (when nothing is purchased) */}
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
									style={{ backgroundColor: `${COLORS.foundation}20` }}
								>
									<div
										className="w-8 h-8 rounded-full"
										style={{ backgroundColor: COLORS.foundation }}
									/>
								</div>
								<h3 className="text-lg font-bold mb-2">You're on the free tier</h3>
								<p className="text-sm text-base-content/60 leading-relaxed">
									Every Anthers user gets <strong>{FREE_USAGE_GIB} GiB of Usage free</strong>,
									subsidized by the Anthers Foundation — roughly {watchHours(FREE_USAGE_GIB)}{" "}
									watch-hours of 1080p60 video, and much more for audio, text, and images. Add Usage
									or Boost above to fund creators and earn a badge.
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

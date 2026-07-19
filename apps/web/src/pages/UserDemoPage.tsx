// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Lede } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import { useEffect, useRef, useState } from "react";

const serif = { fontFamily: FONTS.fraunces };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreatorGate {
	/** Dollar threshold to unlock this gate */
	threshold: number;
	/** Creator-chosen name for this tier */
	label: string;
	/** What the user gets at this tier (shown on hover) */
	description: string;
}

interface DemoCreatorAllocation {
	username: string;
	displayName: string;
	avatar: string;
	watchHours: number;
	poolAmount: number;
	seedAmount: number;
	/** Gates this creator has configured, sorted ascending by threshold */
	gates: CreatorGate[];
}

interface DemoPurchase {
	creator: string;
	item: string;
	type: "download" | "content" | "experience" | "physical";
	price: number;
	/** Anthers Foundation fee (AFF) on this purchase — digital: 50% of download bandwidth; physical/service: 1% of price. Funds the Anthers Foundation, not platform profit. */
	fee: number;
	date: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All possible gate thresholds—used as the universal scale for every bar */
const ALL_GATE_THRESHOLDS = [2, 4, 8, 16, 32];
const BAR_MAX = ALL_GATE_THRESHOLDS[ALL_GATE_THRESHOLDS.length - 1] * 1.1; // 10% headroom

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

// A user holds Anthers-Seeds ($3 each). This demo user is at Petal rank (3
// Anthers-Seeds, $9/mo). Each Anthers-Seed splits into a $1.50 Time Pool (to
// creators, by watch-time) and $1.50 "Supports Anthers" (their bandwidth at cost +
// the Foundation remainder). Directed Seeds ($3 each, 100% to a creator) are on top.
// Bandwidth is folded in — a free floor plus a per-Seed allowance, no wallet.
const DEMO_PLAN = {
	badge: "Petal",
	anthersSeeds: 3,
	price: 9.0, // 3 Anthers-Seeds × $3
	timePool: 4.5, // to creators, distributed by watch-time ($1.50 × 3)
	seeds: 3, // directed creator-Seeds (count, $3 each)
	seedPool: 9.0, // $ value of the directed Seeds
	supportsAnthers: 4.5, // price − Time Pool = your bandwidth (at cost) + the Foundation remainder
	allowanceGiB: 195, // streaming allowance (15 floor + 60 × 3), folded in — no wallet
	month: "February 2026",
};

const DEMO_ALLOCATIONS: DemoCreatorAllocation[] = [
	{
		username: "bugfishhhh",
		displayName: "bugfishhhh",
		avatar: "BF",
		watchHours: 8.2,
		poolAmount: 2.95,
		seedAmount: 1.71,
		gates: [
			{
				threshold: 2,
				label: "Insider",
				description: "Early devlog access, behind-the-scenes screenshots",
			},
			{
				threshold: 4,
				label: "Playtester",
				description: "Beta build downloads, bug-report channel access",
			},
			{
				threshold: 8,
				label: "Collaborator",
				description: "Monthly Q&A streams, vote on feature priorities",
			},
			{
				threshold: 16,
				label: "Co-Designer",
				description: "Submit feature requests, name an NPC, credits listing",
			},
			{
				threshold: 32,
				label: "Patron",
				description: "Private Discord, signed prints, annual gift box",
			},
		],
	},
	{
		username: "LifeOfRiza",
		displayName: "LifeOfRiza",
		avatar: "LR",
		watchHours: 6.5,
		poolAmount: 2.34,
		seedAmount: 0.6,
		gates: [
			{
				threshold: 2,
				label: "Follow+",
				description: "Bonus episodes and extended interviews",
			},
			{
				threshold: 8,
				label: "Inner Circle",
				description: "Private community, reading-list drops, early drafts",
			},
		],
	},
	{
		username: "RaceDayCafe",
		displayName: "RaceDayCafe",
		avatar: "RC",
		watchHours: 5.1,
		poolAmount: 1.84,
		seedAmount: 0.43,
		gates: [
			{
				threshold: 2,
				label: "Pitstop",
				description: "Ad-free race recaps and highlights",
			},
			{
				threshold: 4,
				label: "Paddock",
				description: "Full on-board camera archives, strategy breakdowns",
			},
			{
				threshold: 16,
				label: "Team Radio",
				description: "Live commentary chat during races, telemetry overlays",
			},
		],
	},
	{
		username: "Amaiguri",
		displayName: "Amaiguri",
		avatar: "AM",
		watchHours: 3.0,
		poolAmount: 1.08,
		seedAmount: 0.19,
		gates: [
			{
				threshold: 4,
				label: "Taste Tester",
				description: "Full recipes with notes and substitutions",
			},
			{
				threshold: 8,
				label: "Kitchen Pass",
				description: "Video walkthroughs, seasonal meal plans",
			},
			{
				threshold: 32,
				label: "Chef's Table",
				description: "Monthly live cook-along, signed cookbook lottery",
			},
		],
	},
	{
		username: "MAPHRA",
		displayName: "MAPHRA",
		avatar: "MA",
		watchHours: 1.5,
		poolAmount: 0.54,
		seedAmount: 0.07,
		gates: [
			{
				threshold: 2,
				label: "Listener",
				description: "Bonus tracks and stems download",
			},
			{
				threshold: 4,
				label: "Studio",
				description: "Sample packs, project files, production breakdowns",
			},
			{
				threshold: 8,
				label: "Backstage",
				description: "Unreleased demos, remix stems, live session recordings",
			},
		],
	},
	{
		username: "others",
		displayName: "4 others",
		avatar: "..",
		watchHours: 0.7,
		poolAmount: 0.25,
		seedAmount: 0.0,
		gates: [],
	},
];

const DEMO_PURCHASES: DemoPurchase[] = [
	{
		creator: "bugfishhhh",
		item: "Moonvale OST (FLAC)",
		type: "download",
		price: 8.0,
		fee: 0.01,
		date: "Feb 4",
	},
	{
		creator: "MAPHRA",
		item: '"Cascade" Stems + Session Files',
		type: "download",
		price: 15.0,
		fee: 0.03,
		date: "Feb 11",
	},
	{
		creator: "LifeOfRiza",
		item: "Portfolio Review (30 min)",
		type: "experience",
		price: 25.0,
		fee: 0.25,
		date: "Feb 18",
	},
	{
		creator: "Amaiguri",
		item: "Seasonal Recipe Zine—Spring 2026",
		type: "physical",
		price: 12.0,
		fee: 0.12,
		date: "Feb 22",
	},
];

const PURCHASE_TYPE_LABELS: Record<DemoPurchase["type"], string> = {
	download: "Download",
	content: "Content",
	experience: "Experience",
	physical: "Physical",
};

// ---------------------------------------------------------------------------
// AccessBar—segmented bar with uniform gate hash lines and hover tooltips
// ---------------------------------------------------------------------------

function AccessBar({ total, gates }: { total: number; gates: CreatorGate[] }) {
	const [tooltip, setTooltip] = useState<{
		gate: CreatorGate;
		x: number;
	} | null>(null);
	const barRef = useRef<HTMLDivElement>(null);

	// Close tooltip on scroll
	useEffect(() => {
		if (!tooltip) return;
		const close = () => setTooltip(null);
		window.addEventListener("scroll", close, true);
		return () => window.removeEventListener("scroll", close, true);
	}, [tooltip]);

	// Build a gate lookup by threshold for this creator
	const gateByThreshold = new Map(gates.map((g) => [g.threshold, g]));

	// If the creator has no gates, show a plain bar
	if (gates.length === 0) {
		return (
			<div className="w-full h-3 bg-base-300 rounded-full overflow-hidden">
				<div
					className="h-full bg-base-content/15 rounded-full transition-all"
					style={{ width: `${Math.min((total / BAR_MAX) * 100, 100)}%` }}
				/>
			</div>
		);
	}

	const fillPct = Math.min((total / BAR_MAX) * 100, 100);

	const handleSectionHover = (gate: CreatorGate, e: React.MouseEvent) => {
		const rect = barRef.current?.getBoundingClientRect();
		if (!rect) return;
		setTooltip({ gate, x: e.clientX - rect.left });
	};

	// Build segments: one per gate this creator has, from prevThreshold to
	// gate.threshold.  We also need a final segment from the last gate to
	// BAR_MAX so it's hoverable too (shows "everything above the last gate").
	const segments: {
		start: number;
		end: number;
		gate: CreatorGate;
	}[] = [];
	for (let i = 0; i < gates.length; i++) {
		const prev = i === 0 ? 0 : gates[i - 1].threshold;
		segments.push({ start: prev, end: gates[i].threshold, gate: gates[i] });
	}
	// Final segment after the last gate
	const lastGate = gates[gates.length - 1];
	segments.push({
		start: lastGate.threshold,
		end: BAR_MAX,
		gate: lastGate,
	});

	return (
		<div className="relative" ref={barRef}>
			<div className="w-full h-3 bg-base-300 rounded-full overflow-hidden relative">
				{/* Fill */}
				<div
					className="absolute inset-y-0 left-0 bg-primary/30 rounded-full transition-all"
					style={{ width: `${fillPct}%` }}
				/>

				{/* Hoverable segments */}
				{segments.map((seg, i) => {
					const segStart = (seg.start / BAR_MAX) * 100;
					const segEnd = (seg.end / BAR_MAX) * 100;
					const isFinalSeg = i === segments.length - 1;
					const unlocked = isFinalSeg ? total >= seg.gate.threshold : total >= seg.gate.threshold;

					return (
						<div
							key={`seg-${i}`}
							className={`absolute inset-y-0 transition-all cursor-pointer ${
								unlocked ? "bg-primary/50 hover:bg-primary/70" : "hover:bg-base-content/10"
							}`}
							style={{
								left: `${segStart}%`,
								width: `${segEnd - segStart}%`,
							}}
							onMouseEnter={(e) => handleSectionHover(seg.gate, e)}
							onMouseLeave={() => setTooltip(null)}
						/>
					);
				})}

				{/* Gate hash lines at ALL possible thresholds, but only render line
            if this creator has a gate at that threshold */}
				{ALL_GATE_THRESHOLDS.map((t) => {
					const pos = (t / BAR_MAX) * 100;
					const gate = gateByThreshold.get(t);
					if (!gate) return null;
					const unlocked = total >= t;
					return (
						<div
							key={`line-${t}`}
							className={`absolute top-0 bottom-0 w-px ${
								unlocked ? "bg-primary" : "bg-base-content/30"
							}`}
							style={{ left: `${pos}%` }}
						/>
					);
				})}
			</div>

			{/* Gate dollar labels below bar—only at thresholds this creator uses */}
			<div className="relative h-4 mt-0.5">
				{gates.map((gate) => {
					const pos = (gate.threshold / BAR_MAX) * 100;
					const unlocked = total >= gate.threshold;
					return (
						<span
							key={`label-${gate.threshold}`}
							className={`absolute text-[10px] leading-tight -translate-x-1/2 ${
								unlocked ? "text-primary" : "text-base-content/30"
							}`}
							style={{ left: `${pos}%` }}
						>
							${gate.threshold}
						</span>
					);
				})}
			</div>

			{/* Tooltip */}
			{tooltip && (
				<div
					className="absolute z-50 bottom-full mb-2 pointer-events-none"
					style={{
						left: `${Math.min(
							Math.max(tooltip.x, 60),
							barRef.current ? barRef.current.offsetWidth - 60 : 200,
						)}px`,
						transform: "translateX(-50%)",
					}}
				>
					<div className="bg-base-300 border border-base-content/10 rounded-lg shadow-lg px-3 py-2 text-xs w-52">
						<p className="font-semibold mb-0.5">
							{tooltip.gate.label}
							<span className="font-normal text-base-content/40 ml-1">
								${tooltip.gate.threshold}/mo
							</span>
						</p>
						<p className="text-base-content/60">{tooltip.gate.description}</p>
						{total >= tooltip.gate.threshold ? (
							<p className="text-primary font-medium mt-1">Unlocked</p>
						) : (
							<p className="text-base-content/40 mt-1">
								Need ${(tooltip.gate.threshold - total).toFixed(2)} more
							</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Subscription Dashboard Demo
// ---------------------------------------------------------------------------

function SubscriptionDashboardDemo() {
	const [seedAllocs, setSeedAllocs] = useState<number[]>(DEMO_ALLOCATIONS.map((a) => a.seedAmount));

	const totalPool = DEMO_ALLOCATIONS.reduce((s, a) => s + a.poolAmount, 0);
	const totalSeeds = seedAllocs.reduce((s, b) => s + b, 0);
	// V4 plan price (pre card/tax): Time Pool + Seeds + Community Share = the chosen
	// Anthers-Seeds + directed Seeds. Bandwidth is folded into the Anthers-Seeds, at cost.
	const monthlyTotal = totalPool + totalSeeds + DEMO_PLAN.supportsAnthers;

	const handleSlider = (idx: number, value: number) => {
		const next = [...seedAllocs];
		const diff = value - next[idx];
		next[idx] = value;

		// Redistribute the difference proportionally among other sliders
		const othersTotal = next.reduce((s, b, i) => (i !== idx ? s + b : s), 0);
		if (othersTotal > 0) {
			for (let i = 0; i < next.length; i++) {
				if (i !== idx) {
					next[i] = Math.max(0, next[i] - diff * (next[i] / othersTotal));
				}
			}
		}

		// Normalize to the Seed pool
		const sum = next.reduce((s, b) => s + b, 0);
		if (sum > 0) {
			const scale = DEMO_PLAN.seedPool / sum;
			for (let i = 0; i < next.length; i++) {
				next[i] = Math.round(next[i] * scale * 100) / 100;
			}
		}

		setSeedAllocs(next);
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h3 style={serif} className="text-xl font-medium">
					Your Anther—{DEMO_PLAN.month}
				</h3>
				<p className="text-sm text-base-content/60">
					{DEMO_PLAN.badge} rank — {DEMO_PLAN.anthersSeeds} Anthers-Seeds ($
					{DEMO_PLAN.price.toFixed(2)}/mo)
				</p>
			</div>

			{/* Breakdown summary cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
				<div className="card bg-base-200">
					<div className="card-body p-4">
						<p className="text-xs text-base-content/50 uppercase tracking-wide">Time Pool</p>
						<p className="text-xl font-bold text-success">${totalPool.toFixed(2)}</p>
						<p className="text-xs text-base-content/40">Auto &middot; watch-time proportional</p>
					</div>
				</div>
				<div className="card bg-base-200">
					<div className="card-body p-4">
						<p className="text-xs text-base-content/50 uppercase tracking-wide">Seed Pool</p>
						<p className="text-xl font-bold text-primary">${totalSeeds.toFixed(2)}</p>
						<p className="text-xs text-base-content/40">
							{DEMO_PLAN.seeds} × $3 &middot; drag to adjust
						</p>
					</div>
				</div>
				<div className="card bg-base-200">
					<div className="card-body p-4">
						<p className="text-xs text-base-content/50 uppercase tracking-wide">Supports Anthers</p>
						<p className="text-xl font-bold">${DEMO_PLAN.supportsAnthers.toFixed(2)}</p>
						<p className="text-xs text-base-content/40">Your bandwidth (at cost) + Foundation</p>
					</div>
				</div>
			</div>

			{/* ── Subscription Allocations ── */}
			<div>
				<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-2">
					Subscription Allocations
				</h4>
				<div className="overflow-x-auto">
					<table className="table table-sm w-full">
						<thead>
							<tr>
								{/* Table column widths*/}
								<th style={serif} className="w-45 font-medium">
									Creator
								</th>
								<th style={serif} className="w-25 font-medium">
									Time
								</th>
								<th style={serif} className="w-25 font-medium">
									Pool
								</th>
								<th style={serif} className="w-60 font-medium">
									Seeds
								</th>
								<th style={serif} className="font-medium">
									Total
								</th>
							</tr>
						</thead>
						<tbody>
							{DEMO_ALLOCATIONS.map((alloc, idx) => {
								const rowTotal = alloc.poolAmount + seedAllocs[idx];
								return (
									<tr key={alloc.username} className="hover">
										<td className="w-36">
											<div className="flex items-center gap-1.5">
												<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-[10px] font-bold text-base-content/60 flex-shrink-0">
													{alloc.avatar}
												</div>
												<span className="font-medium text-sm truncate">@{alloc.displayName}</span>
											</div>
										</td>
										<td className="text-sm">{alloc.watchHours.toFixed(1)} hrs</td>
										<td className="text-sm text-success">${alloc.poolAmount.toFixed(2)}</td>
										<td>
											<div className="flex items-center gap-2">
												<input
													type="range"
													min={0}
													max={DEMO_PLAN.seedPool * 100}
													value={Math.round(seedAllocs[idx] * 100)}
													onChange={(e) => handleSlider(idx, parseInt(e.target.value, 10) / 100)}
													className="range range-xs range-primary flex-1"
												/>
												<span className="text-sm text-primary font-medium w-12 flex-shrink-0">
													${seedAllocs[idx].toFixed(2)}
												</span>
											</div>
										</td>
										<td>
											<div className="flex items-start gap-2">
												<div className="flex-1 pt-0.5">
													{alloc.gates.length > 0 && (
														<AccessBar total={rowTotal} gates={alloc.gates} />
													)}
												</div>
												<span className="text-sm font-medium w-12 flex-shrink-0">
													${rowTotal.toFixed(2)}
												</span>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</div>

			{/* ── Billing Summary ── */}
			<div className="card bg-base-200">
				<div className="card-body p-4 space-y-1">
					<div className="flex justify-between text-sm">
						<span className="text-base-content/70">Seeds</span>
						<span className="text-primary">${totalSeeds.toFixed(2)}</span>
					</div>
					<div className="flex justify-between text-sm">
						<span className="text-base-content/70">Supports Anthers</span>
						<span>${DEMO_PLAN.supportsAnthers.toFixed(2)}</span>
					</div>
					<div className="flex justify-between text-sm">
						<span className="text-base-content/70">Time Pool</span>
						<span className="text-success">${totalPool.toFixed(2)}</span>
					</div>
					<div className="flex justify-between text-sm">
						<span className="text-base-content/70">Streaming (at cost, folded in)</span>
						<span className="text-base-content/50">{DEMO_PLAN.allowanceGiB} GiB / mo</span>
					</div>
					<div className="divider my-1" />
					<div className="flex justify-between text-sm font-bold">
						<span>{DEMO_PLAN.badge} rank total</span>
						<span>${monthlyTotal.toFixed(2)}</span>
					</div>
					<p className="text-xs text-base-content/40 mt-1">
						Prepaid &middot; next charge March 1, 2026
					</p>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Purchases Dashboard Demo
// ---------------------------------------------------------------------------

function PurchasesDashboardDemo() {
	const purchasesTotal = DEMO_PURCHASES.reduce((s, p) => s + p.price, 0);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h3 style={serif} className="text-xl font-medium">
					Purchases—{DEMO_PLAN.month}
				</h3>
				<p className="text-sm text-base-content/60">
					Direct purchases are charged at time of sale, separate from your subscription.
				</p>
			</div>

			{/* Purchases table */}
			<div className="overflow-x-auto">
				<table className="table table-sm w-full">
					<thead>
						<tr>
							<th style={serif} className="font-medium">
								Item
							</th>
							<th style={serif} className="w-28 font-medium">
								Creator
							</th>
							<th style={serif} className="w-24 font-medium">
								Type
							</th>
							<th style={serif} className="w-20 font-medium">
								Date
							</th>
							<th style={serif} className="w-20 font-medium">
								Amount
							</th>
						</tr>
					</thead>
					<tbody>
						{DEMO_PURCHASES.map((purchase, idx) => (
							<tr key={idx} className="hover">
								<td className="text-sm">{purchase.item}</td>
								<td className="text-sm">@{purchase.creator}</td>
								<td>
									<span className="badge badge-sm badge-ghost">
										{PURCHASE_TYPE_LABELS[purchase.type]}
									</span>
								</td>
								<td className="text-sm text-base-content/50">{purchase.date}</td>
								<td className="text-sm font-medium">${purchase.price.toFixed(2)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Billing summary */}
			<div className="card bg-base-200">
				<div className="card-body p-4 space-y-1">
					{DEMO_PURCHASES.map((p, i) => (
						<div key={i} className="flex justify-between text-sm">
							<span className="text-base-content/70 truncate mr-4">{p.item}</span>
							<span className="flex-shrink-0 tabular-nums inline-grid grid-cols-[3.25rem_2.0rem_2.5rem_2.0rem_3.25rem] items-center text-right">
								<span className="text-base-content/50">${(p.price - p.fee).toFixed(2)}</span>
								<span className="text-base-content/30 text-center">+</span>
								<span className="text-base-content/50">${p.fee.toFixed(2)}</span>
								<span className="text-base-content/30 text-center">=</span>
								<span>${p.price.toFixed(2)}</span>
							</span>
						</div>
					))}
					<div className="divider my-1" />
					<div className="flex justify-between text-sm font-bold">
						<span>Total paid this month</span>
						<span>${purchasesTotal.toFixed(2)}</span>
					</div>
					<p className="text-xs text-base-content/40 mt-1">
						All purchases were charged at time of sale.
					</p>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function UserDemoPage() {
	const [activeTab, setActiveTab] = useState<"feed" | "dashboard" | "purchases">("dashboard");

	return (
		<div className="pb-16">
			{/* Hero intro */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							User Experience
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-6xl"
						>
							See where your <em className="font-medium text-primary not-italic">money goes.</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<Lede>
							Anthers gives you full transparency over your subscription. Browse your feed, then
							check your dashboard to see exactly how your money is split across the creators you
							engage with.
						</Lede>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* Tabs + content */}
			<div className="max-w-7xl mx-auto px-4">
				{/* Tab bar */}
				<div className="flex gap-2 mb-6">
					<button
						type="button"
						onClick={() => setActiveTab("feed")}
						className={`btn btn-sm rounded-full ${activeTab === "feed" ? "btn-primary" : "btn-ghost"}`}
					>
						Feed
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("dashboard")}
						className={`btn btn-sm rounded-full ${activeTab === "dashboard" ? "btn-primary" : "btn-ghost"}`}
					>
						Subscription Dashboard
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("purchases")}
						className={`btn btn-sm rounded-full ${activeTab === "purchases" ? "btn-primary" : "btn-ghost"}`}
					>
						Purchases Dashboard
					</button>
				</div>

				{/* Browser chrome frame */}
				<div className="rounded-xl border border-base-300 overflow-hidden bg-base-100 shadow-lg">
					{/* Fake address bar */}
					<div className="flex items-center gap-2 px-4 py-2 bg-base-200 border-b border-base-300">
						<div className="flex gap-1.5">
							<span className="w-3 h-3 rounded-full bg-error/60" />
							<span className="w-3 h-3 rounded-full bg-warning/60" />
							<span className="w-3 h-3 rounded-full bg-success/60" />
						</div>
						<div className="flex-1 mx-3">
							<div className="bg-base-300 rounded-md px-3 py-1 text-xs text-base-content/40 font-mono">
								anthers.org/
								{activeTab === "feed"
									? "feed"
									: activeTab === "purchases"
										? "purchases"
										: "subscription"}
							</div>
						</div>
					</div>

					{/* Page content */}
					<div className="min-h-[600px] p-6">
						{activeTab === "feed" && (
							<div className="flex flex-col items-center justify-center h-96 text-center">
								<div className="text-5xl mb-4 opacity-20">
									<svg
										aria-hidden="true"
										className="w-16 h-16 mx-auto"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={1.5}
											d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
										/>
									</svg>
								</div>
								<h3 style={serif} className="text-lg font-medium text-base-content/40 mb-2">
									Feed Demo
								</h3>
								<p className="text-sm text-base-content/30 max-w-md">
									A personalized feed of posts, videos, audio, and games from the creators you
									follow. Coming soon to this demo.
								</p>
							</div>
						)}

						{activeTab === "dashboard" && <SubscriptionDashboardDemo />}

						{activeTab === "purchases" && <PurchasesDashboardDemo />}
					</div>
				</div>

				{/* CTA */}
				<Reveal className="mt-8 text-center">
					<p className="text-base-content/50 text-sm mb-4">
						Full transparency. No hidden fees. Every dollar accounted for.
					</p>
					<Link to="/subscribe" className="btn btn-primary rounded-full px-7">
						Choose a plan
					</Link>
				</Reveal>
			</div>
		</div>
	);
}

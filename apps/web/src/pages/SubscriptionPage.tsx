import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type {
	Subscription,
	AttentionSummary,
	PoolDistribution,
	BoostAllocation,
	CreatorGate,
} from "../lib/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ALLOC = { creators: 0.92, foundation: 0.08 };
const CREATOR_POOL_FIXED = 2.76;

const DELIVERY_PER_HOUR_VIDEO = 112.5 * 60 / 1024 * 0.01;
const DELIVERY_CREDIT = 1.00;

const TIER_THRESHOLDS: { id: string; name: string; price: number }[] = [
	{ id: "free", name: "Free", price: 0 },
	{ id: "root", name: "Root", price: 3 },
	{ id: "sprout", name: "Sprout", price: 7 },
	{ id: "petal", name: "Petal", price: 15 },
	{ id: "bloom", name: "Bloom", price: 30 },
];

/** Universal scale for AccessBar gate hash lines */
const ALL_GATE_THRESHOLDS = [2, 4, 8, 16, 32];
const BAR_MAX = ALL_GATE_THRESHOLDS[ALL_GATE_THRESHOLDS.length - 1] * 1.1;

function tierFor(id: string) {
	return TIER_THRESHOLDS.find((t) => t.id === id) ?? TIER_THRESHOLDS[0];
}

function nextTierFor(id: string) {
	const idx = TIER_THRESHOLDS.findIndex((t) => t.id === id);
	if (idx < 0 || idx >= TIER_THRESHOLDS.length - 1) return null;
	return TIER_THRESHOLDS[idx + 1];
}

function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}

function formatHours(seconds: number): string {
	const hrs = seconds / 3600;
	if (hrs >= 1) return `${hrs.toFixed(1)} hrs`;
	const mins = Math.round(seconds / 60);
	return mins > 0 ? `${mins}m` : "0m";
}

/* ------------------------------------------------------------------ */
/*  Cycle helpers                                                      */
/* ------------------------------------------------------------------ */

function getCurrentCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function offsetCycle(cycle: string, offset: number): string {
	const d = new Date(cycle + "T00:00:00");
	d.setMonth(d.getMonth() + offset);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function cycleLabel(cycle: string): string {
	return new Date(cycle + "T00:00:00").toLocaleString("default", {
		month: "long",
		year: "numeric",
	});
}

type ViewMode = "past" | "current" | "next";

function viewModeFor(cycle: string): ViewMode {
	const current = getCurrentCycle();
	if (cycle === current) return "current";
	if (cycle > current) return "next";
	return "past";
}

/* ------------------------------------------------------------------ */
/*  AccessBar — segmented bar with gate hash lines and hover tooltips  */
/* ------------------------------------------------------------------ */

function AccessBar({ total, gates }: { total: number; gates: CreatorGate[] }) {
	const [tooltip, setTooltip] = useState<{ gate: CreatorGate; x: number } | null>(null);
	const barRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!tooltip) return;
		const close = () => setTooltip(null);
		window.addEventListener("scroll", close, true);
		return () => window.removeEventListener("scroll", close, true);
	}, [tooltip]);

	// Only show boost gates in the access bar
	const boostGates = gates.filter((g) => g.gateType === "boost");
	const gateByThreshold = new Map(boostGates.map((g) => [Number(g.threshold), g]));

	if (boostGates.length === 0) {
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

	// Build hoverable segments between gates
	const segments: { start: number; end: number; gate: CreatorGate }[] = [];
	for (let i = 0; i < boostGates.length; i++) {
		const prev = i === 0 ? 0 : Number(boostGates[i - 1].threshold);
		segments.push({ start: prev, end: Number(boostGates[i].threshold), gate: boostGates[i] });
	}
	const lastGate = boostGates[boostGates.length - 1];
	segments.push({ start: Number(lastGate.threshold), end: BAR_MAX, gate: lastGate });

	return (
		<div className="relative" ref={barRef}>
			<div className="w-full h-3 bg-base-300 rounded-full overflow-hidden relative">
				<div
					className="absolute inset-y-0 left-0 bg-primary/30 rounded-full transition-all"
					style={{ width: `${fillPct}%` }}
				/>

				{segments.map((seg, i) => {
					const segStart = (seg.start / BAR_MAX) * 100;
					const segEnd = (seg.end / BAR_MAX) * 100;
					const unlocked = total >= Number(seg.gate.threshold);
					return (
						<div
							key={`seg-${i}`}
							className={`absolute inset-y-0 transition-all cursor-pointer ${
								unlocked ? "bg-primary/50 hover:bg-primary/70" : "hover:bg-base-content/10"
							}`}
							style={{ left: `${segStart}%`, width: `${segEnd - segStart}%` }}
							onMouseEnter={(e) => handleSectionHover(seg.gate, e)}
							onMouseLeave={() => setTooltip(null)}
						/>
					);
				})}

				{ALL_GATE_THRESHOLDS.map((t) => {
					const pos = (t / BAR_MAX) * 100;
					const gate = gateByThreshold.get(t);
					if (!gate) return null;
					const unlocked = total >= t;
					return (
						<div
							key={`line-${t}`}
							className={`absolute top-0 bottom-0 w-px ${unlocked ? "bg-primary" : "bg-base-content/30"}`}
							style={{ left: `${pos}%` }}
						/>
					);
				})}
			</div>

			{/* Gate dollar labels */}
			<div className="relative h-4 mt-0.5">
				{boostGates.map((gate) => {
					const pos = (Number(gate.threshold) / BAR_MAX) * 100;
					const unlocked = total >= Number(gate.threshold);
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
						{total >= Number(tooltip.gate.threshold) ? (
							<p className="text-primary font-medium mt-1">Unlocked</p>
						) : (
							<p className="text-base-content/40 mt-1">
								Need ${(Number(tooltip.gate.threshold) - total).toFixed(2)} more
							</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Month Selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({
	cycle, onChange,
}: {
	cycle: string;
	onChange: (cycle: string) => void;
}) {
	const current = getCurrentCycle();
	const nextCycle = offsetCycle(current, 1);
	const mode = viewModeFor(cycle);

	return (
		<div className="flex items-center gap-3">
			<button className="btn btn-ghost btn-xs" onClick={() => onChange(offsetCycle(cycle, -1))}>
				&larr;
			</button>
			<span className="text-sm font-medium min-w-[140px] text-center">
				{cycleLabel(cycle)}
				{mode === "current" && (
					<span className="text-xs text-base-content/40 ml-1">(current)</span>
				)}
				{mode === "next" && (
					<span className="text-xs text-primary ml-1">(preview)</span>
				)}
			</span>
			{cycle < nextCycle ? (
				<button className="btn btn-ghost btn-xs" onClick={() => onChange(offsetCycle(cycle, 1))}>
					&rarr;
				</button>
			) : (
				<div className="btn btn-ghost btn-xs invisible">&rarr;</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Combined row data (distribution + boost + gates per creator)       */
/* ------------------------------------------------------------------ */

interface CreatorRow {
	creatorId: number;
	username: string;
	displayName: string | null;
	avatar: string | null;
	timeSeconds: number;
	poolAmount: number;
	boostAmount: number;
	gates: CreatorGate[];
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function SubscriptionPage() {
	const [searchParams] = useSearchParams();
	const [sub, setSub] = useState<Subscription | null>(null);
	const [attention, setAttention] = useState<AttentionSummary | null>(null);
	const [distributions, setDistributions] = useState<PoolDistribution[]>([]);
	const [boosts, setBoosts] = useState<BoostAllocation[]>([]);
	const [boostBudget, setBoostBudget] = useState(0);
	const [creatorGatesMap, setCreatorGatesMap] = useState<Map<string, CreatorGate[]>>(new Map());
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());

	const sessionId = searchParams.get("session_id");
	const viewMode = viewModeFor(selectedCycle);

	// ── Fetch functions ──

	const fetchSubscription = useCallback(async () => {
		try {
			const res = await client.api.subscriptions.me.$get();
			const data = (await res.json()) as { subscription: Subscription };
			setSub(data.subscription);
		} catch {
			setError("Failed to load subscription.");
		} finally {
			setLoading(false);
		}
	}, []);

	const fetchCycleData = useCallback(async (cycle: string) => {
		const [attRes, distRes, boostRes] = await Promise.allSettled([
			client.api.subscriptions.attention.summary.$get({ query: { cycle } }),
			client.api.subscriptions.distributions.$get({ query: { cycle } }),
			client.api.subscriptions.boosts.$get({ query: { cycle } }),
		]);

		if (attRes.status === "fulfilled") {
			setAttention((await attRes.value.json()) as AttentionSummary);
		}
		if (distRes.status === "fulfilled") {
			const data = (await distRes.value.json()) as { distributions: PoolDistribution[] };
			setDistributions(data.distributions);

			// Fetch gates for each creator in the distribution list
			const usernames = data.distributions
				.map((d) => d.creator?.username)
				.filter(Boolean) as string[];
			const gatesMap = new Map<string, CreatorGate[]>();
			const gateResults = await Promise.allSettled(
				usernames.map(async (u) => {
					const res = await client.api.subscriptions.gates.$get({
						query: { creator: u },
					});
					const gateData = (await res.json()) as { gates: CreatorGate[] };
					return { username: u, gates: gateData.gates };
				}),
			);
			for (const r of gateResults) {
				if (r.status === "fulfilled") {
					gatesMap.set(r.value.username, r.value.gates);
				}
			}
			setCreatorGatesMap(gatesMap);
		}
		if (boostRes.status === "fulfilled") {
			const data = (await boostRes.value.json()) as {
				boosts: BoostAllocation[];
				budget: string;
				allocated: string;
				remaining: string;
			};
			setBoosts(data.boosts);
			setBoostBudget(parseFloat(data.budget));
		}
	}, []);

	useEffect(() => { fetchSubscription(); }, [fetchSubscription]);
	useEffect(() => { fetchCycleData(selectedCycle); }, [selectedCycle, fetchCycleData]);

	useEffect(() => {
		if (sessionId) {
			setSuccess("Subscription activated! Welcome aboard. It may take a moment for your plan to update.");
			const timer = setTimeout(fetchSubscription, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId, fetchSubscription]);

	// ── Boost slider handling ──

	const handleBoostSlider = async (creatorId: number, newAmount: number) => {
		// Optimistic update
		setBoosts((prev) =>
			prev.map((b) =>
				b.creatorId === creatorId ? { ...b, amount: newAmount.toFixed(2) } : b,
			),
		);

		try {
			const res = await client.api.subscriptions.boosts.$post({
				json: {
					creatorId,
					amount: newAmount.toFixed(2),
					cycle: selectedCycle,
				},
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				setError(data.error ?? "Failed to update boost.");
				// Revert on error
				fetchCycleData(selectedCycle);
			}
		} catch {
			setError("Failed to update boost.");
			fetchCycleData(selectedCycle);
		}
	};

	// ── Actions ──

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

	/* ---- Derived values ---- */

	const tier = sub ? tierFor(sub.tier) : TIER_THRESHOLDS[0];
	const isPaid = tier.price > 0;
	const isCanceling = sub ? !!sub.canceledAt : false;
	const fundingLevel = sub?.fundingLevel ?? tier.price;

	const financials = useMemo(() => {
		const price = fundingLevel;
		const foundationFee = Math.round(price * ALLOC.foundation * 100) / 100;
		const creatorShare = Math.round(price * ALLOC.creators * 100) / 100;
		const poolAmount = Math.min(CREATOR_POOL_FIXED, creatorShare);
		const boostPool = Math.max(0, Math.round((creatorShare - poolAmount) * 100) / 100);
		return { price, foundationFee, creatorShare, poolAmount, boostPool };
	}, [fundingLevel]);

	const nextTier = sub ? nextTierFor(sub.tier) : null;

	// Build combined rows: distribution + boost + gates per creator
	const boostByCreator = useMemo(() => {
		const map = new Map<number, number>();
		for (const b of boosts) map.set(b.creatorId, parseFloat(b.amount));
		return map;
	}, [boosts]);

	const rows: CreatorRow[] = useMemo(() => {
		return distributions.map((d) => {
			const boostAmt = boostByCreator.get(d.creatorId) ?? parseFloat(d.boostAmount);
			const username = d.creator?.username ?? "";
			return {
				creatorId: d.creatorId,
				username,
				displayName: d.creator?.displayName ?? null,
				avatar: d.creator?.avatar ?? null,
				timeSeconds: d.attentionSeconds ?? 0,
				poolAmount: parseFloat(d.poolAmount),
				boostAmount: boostAmt,
				gates: creatorGatesMap.get(username) ?? [],
			};
		});
	}, [distributions, boostByCreator, creatorGatesMap]);

	const totalTime = rows.reduce((s, r) => s + r.timeSeconds, 0);
	const totalPool = rows.reduce((s, r) => s + r.poolAmount, 0);
	const totalBoost = rows.reduce((s, r) => s + r.boostAmount, 0);

	const deliveryEstimate = useMemo(() => {
		const hrs = attention?.hoursUsed ?? 0;
		const gross = Math.round(hrs * DELIVERY_PER_HOUR_VIDEO * 100) / 100;
		const net = isPaid ? Math.max(0, Math.round((gross - DELIVERY_CREDIT) * 100) / 100) : gross;
		return { hours: hrs, gross, net, creditApplied: isPaid };
	}, [attention, isPaid]);

	const canEditBoosts = (viewMode === "current" || viewMode === "next") && financials.boostPool > 0;
	const allocatedBoost = rows.reduce((s, r) => s + r.boostAmount, 0);
	const unallocatedBoost = Math.max(0, Math.round((boostBudget - allocatedBoost) * 100) / 100);

	/* ---- Render ---- */

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
				<Link to="/subscribe" className="btn btn-primary">Choose a Plan</Link>
			</div>
		);
	}

	/* ---- Free user view ---- */
	if (!isPaid) {
		return (
			<div className="max-w-2xl mx-auto px-4 py-8">
				<div className="flex items-baseline justify-between mb-6">
					<h1 className="text-2xl font-bold">Your Anthers</h1>
					<span className="text-sm text-base-content/60">Free Plan</span>
				</div>

				{error && <div className="alert alert-error mb-4"><span>{error}</span></div>}
				{success && <div className="alert alert-success mb-4"><span>{success}</span></div>}

				<div className="card bg-base-200">
					<div className="card-body">
						<div className="flex items-center justify-between">
							<div>
								<h2 className="card-title">Free Plan</h2>
								<div className="badge badge-success badge-sm mt-1">Active</div>
							</div>
							<Link to="/subscribe" className="btn btn-primary btn-sm">Upgrade</Link>
						</div>

						<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />

						{attention && (
							<div className="mt-4">
								<div className="flex items-center justify-between text-sm mb-1">
									<span className="text-base-content/60">Time with Creators</span>
									<span className="font-medium">{attention.hoursUsed} hrs</span>
								</div>
								<p className="text-xs text-base-content/40">
									All media types count equally — a minute of video, audio,
									reading, or gameplay is the same when funding your creators.
								</p>
							</div>
						)}

						<div className="mt-4 text-sm text-base-content/60">
							Delivery covered by the Anthers Foundation (up to 10 hrs/mo).
						</div>

						{nextTier && (
							<div className="mt-4 pt-3 border-t border-base-content/10">
								<Link to="/subscribe" className="text-sm text-primary hover:underline">
									Subscribe at {nextTier.name} (${nextTier.price}/mo) to
									start funding your creators directly &rarr;
								</Link>
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	/* ──────────────────────────────────────────────────────────────────── */
	/*  Paid user view — matches the interactive demo dashboard style      */
	/* ──────────────────────────────────────────────────────────────────── */

	return (
		<div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
			{error && <div className="alert alert-error mb-4"><span>{error}</span></div>}
			{success && <div className="alert alert-success mb-4"><span>{success}</span></div>}

			{/* Header + month selector */}
			<div>
				<div className="flex items-baseline justify-between">
					<h1 className="text-lg font-bold">
						Your Anthers—{cycleLabel(selectedCycle)}
					</h1>
					<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />
				</div>
				<p className="text-sm text-base-content/60">
					{tier.name} tier — {fmt(financials.price)}/mo
				</p>
			</div>

			{/* Banners */}
			{viewMode === "next" && (
				<div className="alert alert-info text-sm">
					<span>
						Preview for {cycleLabel(selectedCycle)}. Boost changes here take
						effect at the start of this billing cycle. You can increase or
						decrease boosts freely.
					</span>
				</div>
			)}
			{viewMode === "past" && (
				<div className="alert text-sm bg-base-200">
					<span>Historical view — read-only summary for {cycleLabel(selectedCycle)}.</span>
				</div>
			)}

			{/* ── Summary cards ── */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
				<div className="card bg-base-200">
					<div className="card-body p-4">
						<p className="text-xs text-base-content/50 uppercase tracking-wide">
							Anthers Foundation Fee
						</p>
						<p className="text-xl font-bold">{fmt(financials.foundationFee)}</p>
						<p className="text-xs text-base-content/40">8% of subscription</p>
					</div>
				</div>
				<div className="card bg-base-200">
					<div className="card-body p-4">
						<p className="text-xs text-base-content/50 uppercase tracking-wide">
							Creator Pool
						</p>
						<p className="text-xl font-bold text-success">
							{fmt(totalPool > 0 ? totalPool : financials.poolAmount)}
						</p>
						<p className="text-xs text-base-content/40">Auto · time-proportional</p>
					</div>
				</div>
				<div className="card bg-base-200">
					<div className="card-body p-4">
						<p className="text-xs text-base-content/50 uppercase tracking-wide">
							Boost Pool
						</p>
						<p className="text-xl font-bold text-primary">
							{fmt(totalBoost > 0 ? totalBoost : financials.boostPool)}
						</p>
						<p className="text-xs text-base-content/40">
							{canEditBoosts ? "Drag sliders to adjust" : "Auto allocation"}
						</p>
						{unallocatedBoost > 0 && canEditBoosts && (
							<p className="text-xs text-warning mt-1">
								{fmt(unallocatedBoost)} unallocated
							</p>
						)}
					</div>
				</div>
			</div>

			{/* Unallocated boost callout */}
			{unallocatedBoost > 0 && canEditBoosts && (
				<div className="alert alert-warning text-sm">
					<span>
						You have <strong>{fmt(unallocatedBoost)}</strong> of unallocated
						boost available. Use the sliders below to direct it to creators
						you want to support.
					</span>
				</div>
			)}

			{/* ── Creator Allocations table ── */}
			{rows.length > 0 ? (
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-2">
						Creator Allocations
					</h4>
					<div className="overflow-x-auto">
						<table className="table table-sm w-full">
							<thead>
								<tr>
									<th className="w-45">Creator</th>
									<th className="w-25">Time</th>
									<th className="w-25">Pool</th>
									<th className="w-60">Boost</th>
									<th>Total</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => {
									const rowTotal = row.poolAmount + row.boostAmount;
									const initials = (row.displayName || row.username)
										.split(/\s+/)
										.map((w) => w[0])
										.join("")
										.slice(0, 2)
										.toUpperCase();

									return (
										<tr key={row.creatorId} className="hover">
											<td>
												<div className="flex items-center gap-1.5">
													{row.avatar ? (
														<img
															src={row.avatar}
															alt=""
															className="w-6 h-6 rounded-full object-cover flex-shrink-0"
														/>
													) : (
														<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-[10px] font-bold text-base-content/60 flex-shrink-0">
															{initials}
														</div>
													)}
													<Link to={`/${row.username}`} className="font-medium text-sm truncate link link-hover">
														@{row.displayName || row.username}
													</Link>
												</div>
											</td>
											<td className="text-sm">
												{formatHours(row.timeSeconds)}
											</td>
											<td className="text-sm text-success">
												{fmt(row.poolAmount)}
											</td>
											<td>
												{canEditBoosts ? (
													<div className="flex items-center gap-2">
														<input
															type="range"
															min={viewMode === "current" ? Math.round(row.boostAmount * 100) : 0}
															max={Math.round(boostBudget * 100)}
															value={Math.round(row.boostAmount * 100)}
															onChange={(e) => handleBoostSlider(row.creatorId, parseInt(e.target.value, 10) / 100)}
															className="range range-xs range-primary flex-1"
														/>
														<span className="text-sm text-primary font-medium w-14 flex-shrink-0 text-right">
															{fmt(row.boostAmount)}
														</span>
													</div>
												) : (
													<span className="text-sm text-primary">
														{fmt(row.boostAmount)}
													</span>
												)}
											</td>
											<td>
												<div className="flex items-start gap-2">
													<div className="flex-1 pt-0.5">
														{row.gates.length > 0 && (
															<AccessBar total={rowTotal} gates={row.gates} />
														)}
													</div>
													<span className="text-sm font-medium w-14 flex-shrink-0 text-right">
														{fmt(rowTotal)}
													</span>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					{canEditBoosts && viewMode === "current" && (
						<p className="text-[11px] text-base-content/30 mt-2">
							Boosts can only be increased in the current month. Switch to next
							month's preview to decrease or remove boosts.
						</p>
					)}
				</div>
			) : (
				<div className="py-6 text-center text-sm text-base-content/40">
					{viewMode === "next" ? (
						<p>Next month's distributions will be calculated based on your time with creators during {cycleLabel(selectedCycle)}.</p>
					) : (
						<>
							<p>No distributions yet this cycle.</p>
							<p className="mt-1">
								Your creator pool is distributed proportionally based on your
								time with creators — video, audio, text, and gameplay all count equally.
							</p>
						</>
					)}
				</div>
			)}

			{/* ── Billing Summary ── */}
			<div className="card bg-base-200">
				<div className="card-body p-4 space-y-1">
					<div className="flex justify-between text-sm">
						<span className="text-base-content/70">Anthers Foundation Fee</span>
						<span>{fmt(financials.foundationFee)}</span>
					</div>
					<div className="flex justify-between text-sm">
						<span className="text-base-content/70">Creator Pool</span>
						<span className="text-success">
							{fmt(totalPool > 0 ? totalPool : financials.poolAmount)}
						</span>
					</div>
					{financials.boostPool > 0 && (
						<div className="flex justify-between text-sm">
							<span className="text-base-content/70">Boost Pool</span>
							<span className="text-primary">
								{fmt(totalBoost > 0 ? totalBoost : financials.boostPool)}
							</span>
						</div>
					)}
					<div className="divider my-1" />
					<div className="flex justify-between text-sm font-bold">
						<span>Monthly total</span>
						<span>{fmt(financials.price)}</span>
					</div>

					{viewMode !== "next" && deliveryEstimate.hours > 0 && (
						<>
							<div className="flex justify-between text-sm text-base-content/50">
								<span>
									Delivery ({deliveryEstimate.hours} hrs)
								</span>
								<span>
									{deliveryEstimate.net > 0
										? `approx. ${fmt(deliveryEstimate.net)}`
										: <span className="text-success">covered by $1 credit</span>
									}
								</span>
							</div>
							<p className="text-[11px] text-base-content/30">
								Delivery estimate assumes 1080p video. Audio and text cost far less.
							</p>
						</>
					)}

					{sub.currentPeriodEnd && viewMode === "current" && (
						<p className="text-xs text-base-content/40 mt-1">
							Next charge: {new Date(sub.currentPeriodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
						</p>
					)}
				</div>
			</div>

			{/* ── Actions ── */}
			{viewMode === "current" && (
				<div className="flex flex-wrap items-center gap-3">
					<Link to="/subscribe" className="btn btn-outline btn-sm">Change Plan</Link>
					{isCanceling ? (
						<button
							className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`}
							onClick={handleResume} disabled={!!actionLoading}
						>
							{actionLoading === "resume" ? "Resuming..." : "Resume Subscription"}
						</button>
					) : (
						<button
							className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
							onClick={handleCancel} disabled={!!actionLoading}
						>
							{actionLoading === "cancel" ? "Canceling..." : "Cancel Subscription"}
						</button>
					)}
					<button
						className={`btn btn-ghost btn-sm ${actionLoading === "portal" ? "btn-disabled" : ""}`}
						onClick={handleBillingPortal} disabled={!!actionLoading}
					>
						{actionLoading === "portal" ? "Opening..." : "Manage Billing"}
					</button>
				</div>
			)}

			{viewMode === "current" && nextTier && (
				<Link to="/subscribe" className="text-sm text-primary hover:underline">
					Adjust your support level anytime &rarr;{" "}
					<span className="text-base-content/40">
						You're ${nextTier.price - tier.price} from {nextTier.name} perks
					</span>
				</Link>
			)}
		</div>
	);
}

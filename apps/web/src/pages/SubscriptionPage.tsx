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
/*  Constants & V2 economics                                           */
/* ------------------------------------------------------------------ */

const ALLOC = { creators: 0.92, foundation: 0.08 };

function computePools(fundingLevel: number) {
	const creatorShare = Number((fundingLevel * 0.92).toFixed(2));
	const boostPool = fundingLevel >= 3 ? Math.ceil(fundingLevel * 0.5) : 0;
	const timePool = Math.max(0, Number((creatorShare - boostPool).toFixed(2)));
	return { creatorShare, boostPool, timePool };
}

const DELIVERY_PER_HOUR_VIDEO = 112.5 * 60 / 1024 * 0.01;
const DELIVERY_CREDIT = 1.00;

const TIER_THRESHOLDS: { id: string; name: string; price: number }[] = [
	{ id: "free", name: "Free", price: 0 },
	{ id: "root", name: "Root", price: 3 },
	{ id: "sprout", name: "Sprout", price: 7 },
	{ id: "petal", name: "Petal", price: 15 },
	{ id: "bloom", name: "Bloom", price: 30 },
];

const SLIDER_MAX = 50;

function tierFor(id: string) {
	return TIER_THRESHOLDS.find((t) => t.id === id) ?? TIER_THRESHOLDS[0];
}

function tierForAmount(amount: number) {
	for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
		if (amount >= TIER_THRESHOLDS[i].price) return TIER_THRESHOLDS[i];
	}
	return TIER_THRESHOLDS[0];
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
/*  InfoTip — hover (i) icon with tooltip                              */
/* ------------------------------------------------------------------ */

function InfoTip({ text }: { text: string }) {
	const [show, setShow] = useState(false);
	return (
		<span
			className="relative inline-flex ml-1 cursor-help"
			onMouseEnter={() => setShow(true)}
			onMouseLeave={() => setShow(false)}
		>
			<span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-base-content/20 text-[9px] font-semibold text-base-content/40 leading-none">
				i
			</span>
			{show && (
				<div className="absolute z-50 left-1/2 top-full mt-1 pointer-events-none">
					<div className="bg-base-300 border border-base-content/10 rounded-lg shadow-lg px-3 py-2 text-xs text-base-content/70 w-56 font-normal normal-case tracking-normal leading-relaxed">
						{text}
					</div>
				</div>
			)}
		</span>
	);
}

/* ------------------------------------------------------------------ */
/*  BoostBar — slider + gate hash marks in one column                  */
/* ------------------------------------------------------------------ */

/** Maximum dollar value shown on the bar. Covers most boost gate ranges. */
const BAR_MAX = 35.2;
const GATE_THRESHOLDS_VISUAL = [2, 4, 8, 16, 32];

function BoostBar({
	value, committedValue, boostPool, gates, onChange, disabled,
}: {
	value: number;
	/** The committed (saved) boost value — used to show pending fill in yellow */
	committedValue: number;
	boostPool: number;
	gates: CreatorGate[];
	onChange: (v: number) => void;
	disabled: boolean;
}) {
	const [tooltip, setTooltip] = useState<{ gate: CreatorGate } | null>(null);
	const [dragging, setDragging] = useState(false);
	const trackRef = useRef<HTMLDivElement>(null);

	const boostGates = gates.filter((g) => g.gateType === "boost");

	const highestGate = boostGates.length > 0
		? Math.max(...boostGates.map((g) => Number(g.threshold)))
		: boostPool;
	const sliderMax = Math.max(highestGate, 1);
	const barMax = sliderMax * 1.1;
	const committedPct = Math.min((committedValue / barMax) * 100, 100);
	const pendingPct = Math.min((value / barMax) * 100, 100);
	const thumbPct = pendingPct;
	const hasPending = value !== committedValue;

	const xToValue = useCallback((clientX: number) => {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect) return value;
		const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		return Math.round(pct * barMax);
	}, [barMax, value]);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (disabled) return;
		e.preventDefault();
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		setDragging(true);
		setTooltip(null);
		onChange(xToValue(e.clientX));
	}, [disabled, onChange, xToValue]);

	const handlePointerMove = useCallback((e: React.PointerEvent) => {
		if (!dragging) return;
		onChange(xToValue(e.clientX));
	}, [dragging, onChange, xToValue]);

	const handlePointerUp = useCallback(() => { setDragging(false); }, []);

	return (
		<div className={disabled ? "opacity-50" : ""}>
			{/* Tier name labels above the track */}
			{boostGates.length > 0 && (
				<div className="relative h-4 mb-0.5" style={{ marginRight: "calc(2rem + 6px + 0.375rem)" }}>
					{boostGates.map((gate) => {
						const pos = (Number(gate.threshold) / barMax) * 100;
						const unlocked = value >= Number(gate.threshold);
						return (
							<span
								key={`name-${gate.threshold}`}
								className={`absolute text-[9px] leading-tight -translate-x-1/2 cursor-help ${
									unlocked ? "text-primary font-semibold" : "text-base-content/40"
								}`}
								style={{ left: `${pos}%` }}
								onMouseEnter={() => setTooltip({ gate })}
								onMouseLeave={() => setTooltip(null)}
							>
								{gate.label}
							</span>
						);
					})}
				</div>
			)}

			{/* Interactive track + value */}
			<div className="flex items-center gap-2">
				<div
					ref={trackRef}
					className={`relative flex-1 h-5 select-none ${disabled ? "pointer-events-none" : "cursor-pointer"}`}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
				>
					<div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-2.5 bg-base-300 rounded-full overflow-hidden">
						{/* Committed fill (primary) */}
						<div
							className="absolute inset-y-0 left-0 bg-primary/60 rounded-full"
							style={{ width: `${committedPct}%` }}
						/>
						{/* Pending fill (yellow, only the delta above committed) */}
						{hasPending && value > committedValue && (
							<div
								className="absolute inset-y-0 bg-error/60 rounded-r-full"
								style={{
									left: `${committedPct}%`,
									width: `${pendingPct - committedPct}%`,
								}}
							/>
						)}

						{/* Gate hash lines */}
						{boostGates.map((gate) => {
							const pos = (Number(gate.threshold) / barMax) * 100;
							return (
								<div
									key={`line-${gate.threshold}`}
									className={`absolute top-0 bottom-0 w-px pointer-events-none ${
										value >= Number(gate.threshold) ? "bg-primary" : "bg-base-content/30"
									}`}
									style={{ left: `${pos}%` }}
								/>
							);
						})}
					</div>

					{/* Thumb */}
					<div
						className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 shadow-md pointer-events-none ${
							hasPending ? "bg-error border-error" : "bg-primary border-primary"
						}`}
						style={{ left: `${thumbPct}%` }}
					/>
				</div>

				{/* Value display */}
				<div className="flex items-center flex-shrink-0">
					<span className={`text-sm font-medium w-8 text-right ${hasPending ? "text-error" : "text-primary"}`}>${value}</span>
				</div>
			</div>

			{/* Gate dollar labels below track */}
			{boostGates.length > 0 && (
				<div className="relative h-3 mt-0.5" style={{ marginRight: "calc(2rem + 6px + 0.375rem)" }}>
					{boostGates.map((gate) => {
						const pos = (Number(gate.threshold) / barMax) * 100;
						return (
							<span
								key={`label-${gate.threshold}`}
								className={`absolute text-[9px] leading-tight -translate-x-1/2 ${
									value >= Number(gate.threshold) ? "text-primary" : "text-base-content/30"
								}`}
								style={{ left: `${pos}%` }}
							>
								${gate.threshold}
							</span>
						);
					})}
				</div>
			)}

			{/* Tooltip (shown when hovering tier names above the track) */}
			{tooltip && trackRef.current && (
				<div className="relative">
					<div
						className="absolute z-50 top-0 mt-1 pointer-events-none"
						style={{
							left: `${(Number(tooltip.gate.threshold) / barMax) * 100}%`,
						}}
					>
						<div className="bg-base-300 border border-base-content/10 rounded-lg shadow-lg px-3 py-2 text-xs w-52">
							<p className="font-semibold mb-0.5">
								{tooltip.gate.label}
								<span className="font-normal text-base-content/40 ml-1">${tooltip.gate.threshold}/mo</span>
							</p>
							<p className="text-base-content/60">{tooltip.gate.description}</p>
							{value >= Number(tooltip.gate.threshold) ? (
								<p className="text-primary font-medium mt-1">Unlocked</p>
							) : (
								<p className="text-base-content/40 mt-1">Need ${Number(tooltip.gate.threshold) - value} more</p>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Month Selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({ cycle, onChange }: { cycle: string; onChange: (c: string) => void }) {
	const current = getCurrentCycle();
	const nextCycle = offsetCycle(current, 1);
	const mode = viewModeFor(cycle);
	return (
		<div className="flex items-center gap-3">
			<button className="btn btn-ghost btn-xs" onClick={() => onChange(offsetCycle(cycle, -1))}>&larr;</button>
			<span className="text-sm font-medium min-w-[140px] text-center">
				{cycleLabel(cycle)}
				{mode === "current" && <span className="text-xs text-base-content/40 ml-1">(current)</span>}
				{mode === "next" && <span className="text-xs text-primary ml-1">(preview)</span>}
			</span>
			{cycle < nextCycle ? (
				<button className="btn btn-ghost btn-xs" onClick={() => onChange(offsetCycle(cycle, 1))}>&rarr;</button>
			) : (
				<div className="btn btn-ghost btn-xs invisible">&rarr;</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Confirmation Dialog                                                */
/* ------------------------------------------------------------------ */

function ConfirmDialog({
	open, title, children, onConfirm, onCancel, confirmLabel, confirmClass,
}: {
	open: boolean;
	title: string;
	children: React.ReactNode;
	onConfirm: () => void;
	onCancel: () => void;
	confirmLabel?: string;
	confirmClass?: string;
}) {
	if (!open) return null;
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div className="card bg-base-100 shadow-2xl max-w-md w-full mx-4">
				<div className="card-body">
					<h3 className="card-title text-lg">{title}</h3>
					<div className="text-sm space-y-2">{children}</div>
					<div className="card-actions justify-end mt-4">
						<button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
						<button className={`btn btn-sm ${confirmClass ?? "btn-primary"}`} onClick={onConfirm}>
							{confirmLabel ?? "Confirm"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Combined row data                                                  */
/* ------------------------------------------------------------------ */

interface CreatorRow {
	creatorId: number;
	username: string;
	displayName: string | null;
	avatar: string | null;
	timeSeconds: number;
	poolAmount: number;
	committedBoost: number;
	pendingBoost: number;
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
	const [committedBoosts, setCommittedBoosts] = useState<BoostAllocation[]>([]);
	const [boostBudget, setBoostBudget] = useState(0);
	const [creatorGatesMap, setCreatorGatesMap] = useState<Map<string, CreatorGate[]>>(new Map());
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());

	// ── Pending changes (local, not saved) ──
	const [pendingFunding, setPendingFunding] = useState<number | null>(null);
	const [pendingBoosts, setPendingBoosts] = useState<Map<number, number>>(new Map());
	const [showConfirm, setShowConfirm] = useState(false);
	const [showRevertConfirm, setShowRevertConfirm] = useState(false);

	const sessionId = searchParams.get("session_id");
	const viewMode = viewModeFor(selectedCycle);

	// ── Data fetching ──

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
			// Fetch gates for each creator
			const usernames = data.distributions.map((d) => d.creator?.username).filter(Boolean) as string[];
			const gatesMap = new Map<string, CreatorGate[]>();
			const gateResults = await Promise.allSettled(
				usernames.map(async (u) => {
					const res = await client.api.subscriptions.gates.$get({ query: { creator: u } });
					return { username: u, gates: ((await res.json()) as { gates: CreatorGate[] }).gates };
				}),
			);
			for (const r of gateResults) {
				if (r.status === "fulfilled") gatesMap.set(r.value.username, r.value.gates);
			}
			setCreatorGatesMap(gatesMap);
		}
		if (boostRes.status === "fulfilled") {
			const data = (await boostRes.value.json()) as {
				boosts: BoostAllocation[]; budget: string; allocated: string; remaining: string;
			};
			setCommittedBoosts(data.boosts);
			setBoostBudget(parseFloat(data.budget));
		}
		// Clear pending state when switching months
		setPendingFunding(null);
		setPendingBoosts(new Map());
	}, []);

	useEffect(() => { fetchSubscription(); }, [fetchSubscription]);
	useEffect(() => { fetchCycleData(selectedCycle); }, [selectedCycle, fetchCycleData]);

	useEffect(() => {
		if (sessionId) {
			setSuccess("Subscription activated! Welcome aboard.");
			const timer = setTimeout(fetchSubscription, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId, fetchSubscription]);

	// ── Derived values ──

	const committedFunding = sub?.fundingLevel ?? tierFor(sub?.tier ?? "free").price;
	const effectiveFunding = pendingFunding ?? committedFunding;
	const tier = tierForAmount(effectiveFunding);
	const isPaid = committedFunding >= 3;
	const isCanceling = sub ? !!sub.canceledAt : false;

	const financials = useMemo(() => computePools(effectiveFunding), [effectiveFunding]);
	const committedFinancials = useMemo(() => computePools(committedFunding), [committedFunding]);
	const foundationFee = Math.round(effectiveFunding * ALLOC.foundation * 100) / 100;

	// Committed boost map
	const committedBoostMap = useMemo(() => {
		const map = new Map<number, number>();
		for (const b of committedBoosts) map.set(b.creatorId, Math.round(parseFloat(b.amount)));
		return map;
	}, [committedBoosts]);

	// Build rows with pending boost values
	const rows: CreatorRow[] = useMemo(() => {
		return distributions.map((d) => {
			const committed = committedBoostMap.get(d.creatorId) ?? Math.round(parseFloat(d.boostAmount));
			const pending = pendingBoosts.get(d.creatorId) ?? committed;
			return {
				creatorId: d.creatorId,
				username: d.creator?.username ?? "",
				displayName: d.creator?.displayName ?? null,
				avatar: d.creator?.avatar ?? null,
				timeSeconds: d.attentionSeconds ?? 0,
				poolAmount: parseFloat(d.poolAmount),
				committedBoost: committed,
				pendingBoost: pending,
				gates: creatorGatesMap.get(d.creator?.username ?? "") ?? [],
			};
		});
	}, [distributions, committedBoostMap, pendingBoosts, creatorGatesMap]);

	const totalTime = rows.reduce((s, r) => s + r.timeSeconds, 0);
	const totalPool = rows.reduce((s, r) => s + r.poolAmount, 0);
	const totalPendingBoost = rows.reduce((s, r) => s + r.pendingBoost, 0);
	const allocatedBoost = totalPendingBoost;
	const unallocatedBoost = Math.max(0, financials.boostPool - allocatedBoost);

	// Detect if there are any pending changes
	const hasPendingChanges = useMemo(() => {
		if (pendingFunding !== null && pendingFunding !== committedFunding) return true;
		for (const [cid, val] of pendingBoosts) {
			const committed = committedBoostMap.get(cid) ?? 0;
			if (val !== committed) return true;
		}
		return false;
	}, [pendingFunding, committedFunding, pendingBoosts, committedBoostMap]);

	const deliveryEstimate = useMemo(() => {
		const hrs = attention?.hoursUsed ?? 0;
		const gross = Math.round(hrs * DELIVERY_PER_HOUR_VIDEO * 100) / 100;
		const net = isPaid ? Math.max(0, Math.round((gross - DELIVERY_CREDIT) * 100) / 100) : gross;
		return { hours: hrs, gross, net };
	}, [attention, isPaid]);

	// ── Pending change handlers ──

	const handleFundingChange = (newVal: number) => {
		if (viewMode === "current" && newVal < committedFunding) return; // increase only
		setPendingFunding(newVal === committedFunding ? null : newVal);

		// If funding decreased, clamp boosts to fit the new budget
		const newBudget = computePools(newVal).boostPool;
		const currentBoosts: { creatorId: number; amount: number }[] = rows.map((r) => ({
			creatorId: r.creatorId,
			amount: pendingBoosts.get(r.creatorId) ?? r.committedBoost,
		}));
		const totalAllocated = currentBoosts.reduce((s, b) => s + b.amount, 0);

		if (totalAllocated > newBudget) {
			// Trim from smallest boosts first
			const sorted = [...currentBoosts].sort((a, b) => a.amount - b.amount);
			let excess = totalAllocated - newBudget;
			const newBoostMap = new Map(pendingBoosts);

			for (const entry of sorted) {
				if (excess <= 0) break;
				const committed = committedBoostMap.get(entry.creatorId) ?? 0;
				// In current month, can't go below committed
				const floor = viewMode === "current" ? committed : 0;
				const reducible = entry.amount - floor;
				const reduction = Math.min(reducible, excess);
				if (reduction > 0) {
					const newAmount = entry.amount - reduction;
					if (newAmount === committed) {
						newBoostMap.delete(entry.creatorId);
					} else {
						newBoostMap.set(entry.creatorId, newAmount);
					}
					excess -= reduction;
				}
			}

			setPendingBoosts(newBoostMap);
		}
	};

	const handleBoostChange = (creatorId: number, newVal: number) => {
		const committed = committedBoostMap.get(creatorId) ?? 0;
		if (viewMode === "current" && newVal < committed) return; // increase only

		// Cap at available budget (boost pool minus other allocations)
		const otherBoosts = Array.from(pendingBoosts.entries())
			.filter(([cid]) => cid !== creatorId)
			.reduce((s, [, v]) => s + v, 0)
			+ rows.filter((r) => r.creatorId !== creatorId && !pendingBoosts.has(r.creatorId))
				.reduce((s, r) => s + r.committedBoost, 0);
		const available = Math.max(0, financials.boostPool - otherBoosts);
		const clamped = Math.min(newVal, available);

		setPendingBoosts((prev) => {
			const next = new Map(prev);
			if (clamped === committed) next.delete(creatorId);
			else next.set(creatorId, clamped);
			return next;
		});
	};

	// ── Save changes ──

	const handleSave = async () => {
		setShowConfirm(false);
		setActionLoading("save");
		setError(null);

		try {
			// Save funding level change if applicable
			// TODO: In production, this would trigger a Stripe subscription update
			// For now, update the subscription record directly
			if (pendingFunding !== null && pendingFunding !== committedFunding) {
				// The subscribe endpoint would handle this; for now we note the intent
			}

			// Save boost changes
			for (const [creatorId, amount] of pendingBoosts) {
				const res = await client.api.subscriptions.boosts.$post({
					json: { creatorId, amount: amount.toFixed(2), cycle: selectedCycle },
				});
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					setError(data.error ?? "Failed to save boost.");
					break;
				}

				// Current month changes auto-propagate to next month
				if (viewMode === "current") {
					const nextCycle = offsetCycle(getCurrentCycle(), 1);
					await client.api.subscriptions.boosts.$post({
						json: { creatorId, amount: amount.toFixed(2), cycle: nextCycle },
					});
				}
			}

			setSuccess("Changes saved.");
			setPendingFunding(null);
			setPendingBoosts(new Map());
			await fetchCycleData(selectedCycle);
		} catch {
			setError("Failed to save changes.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleRevert = () => {
		setShowRevertConfirm(false);
		setPendingFunding(null);
		setPendingBoosts(new Map());
		// Reload committed data from current month
		fetchCycleData(selectedCycle);
	};

	// ── Subscription actions ──

	const handleCancel = async () => {
		setActionLoading("cancel"); setError(null);
		try {
			const res = await client.api.subscriptions.cancel.$post();
			setSub((await res.json() as { subscription: Subscription }).subscription);
			setSuccess("Your subscription will cancel at the end of the current billing period.");
		} catch { setError("Failed to cancel."); }
		finally { setActionLoading(null); }
	};

	const handleResume = async () => {
		setActionLoading("resume"); setError(null);
		try {
			const res = await client.api.subscriptions.resume.$post();
			setSub((await res.json() as { subscription: Subscription }).subscription);
			setSuccess("Subscription resumed.");
		} catch { setError("Failed to resume."); }
		finally { setActionLoading(null); }
	};

	const handleBillingPortal = async () => {
		setActionLoading("portal");
		try {
			const res = await client.api.subscriptions["billing-portal"].$post();
			window.location.href = ((await res.json()) as { portalUrl: string }).portalUrl;
		} catch { setError("Failed to open billing portal."); setActionLoading(null); }
	};

	/* ---- Render ---- */

	if (loading) return <div className="flex justify-center py-16"><span className="loading loading-spinner loading-lg" /></div>;

	if (!sub) return (
		<div className="max-w-2xl mx-auto px-4 py-8 text-center">
			<h1 className="text-2xl font-bold mb-4">No Subscription</h1>
			<p className="mb-4">You don't have an active subscription yet.</p>
			<Link to="/subscribe" className="btn btn-primary">Choose a Plan</Link>
		</div>
	);

	/* ---- Free user view ---- */
	if (!isPaid) return (
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
				</div>
			</div>
		</div>
	);

	/* ──────────────────────────────────────────────────────────────────── */
	/*  Paid user view                                                     */
	/* ──────────────────────────────────────────────────────────────────── */

	const canEdit = viewMode === "current" || viewMode === "next";
	const hasPendingSub = pendingFunding !== null && pendingFunding !== committedFunding;

	// Colors for the cost breakdown dots (matching SubscribePage)
	const DOT_COLORS = {
		timePool:   "#2563eb",
		boost:      "#c026d3",
		foundation: "#0f766e",
		delivery:   "#db2777",
		salesTax:   "#737373",
		cardFee:    "#d97706",
	};

	// Delivery + fees for cost breakdown
	const grossDelivery = Math.round(deliveryEstimate.hours * DELIVERY_PER_HOUR_VIDEO * 100) / 100;
	const deliveryAmt = isPaid ? Math.max(0, Math.round((grossDelivery - DELIVERY_CREDIT) * 100) / 100) : grossDelivery;
	const AVG_SALES_TAX_RATE = 0.0663;
	const subtotalForFees = effectiveFunding + deliveryAmt;
	const salesTax = Math.round(subtotalForFees * AVG_SALES_TAX_RATE * 100) / 100;
	// TODO: Add card/bank fee toggle when payment processing is wired up
	const cardFee = Math.round((subtotalForFees * 0.029 + 0.30) * 100) / 100;
	const totalWithFees = Math.round((effectiveFunding + deliveryAmt + salesTax + cardFee) * 100) / 100;

	return (
		<div className="mx-auto px-4 py-8 space-y-6" style={{ maxWidth: "110rem" }}>
			{error && <div className="alert alert-error"><span>{error}</span></div>}
			{success && <div className="alert alert-success"><span>{success}</span></div>}

			{/* Header + month selector */}
			<div>
				<div className="flex items-baseline justify-between">
					<h1 className="text-lg font-bold">Your Anthers—{cycleLabel(selectedCycle)}</h1>
					<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />
				</div>
				<p className="text-sm text-base-content/60">
					{tier.name} tier
					{hasPendingSub && (
						<span className="text-error ml-1">(pending change)</span>
					)}
				</p>
			</div>

			{/* Banners */}
			{viewMode === "next" && (
				<div className="alert alert-info text-sm">
					<span>Preview for {cycleLabel(selectedCycle)}. You can increase or decrease boosts freely. Changes take effect at the start of the billing cycle.</span>
				</div>
			)}
			{viewMode === "past" && (
				<div className="alert text-sm bg-base-200">
					<span>Historical view — read-only summary for {cycleLabel(selectedCycle)}.</span>
				</div>
			)}

			{/* ── SUBSCRIPTION AMOUNT ── */}
			{canEdit && (
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-2">
						Subscription Amount
						<InfoTip text={viewMode === "current"
							? "Your monthly funding level. Can only be increased in the current month. Determines your Anthers Tier, Time Pool, and Boost Pool budget."
							: "Your monthly funding level for the upcoming billing cycle. You can increase or decrease freely before the cycle starts."
						} />
					</h4>
					<div className="card bg-base-200 p-4">
						{/* Tier threshold marks above slider */}
						<div className="relative w-full h-6 mb-1">
							{TIER_THRESHOLDS.filter((t) => t.price > 0).map((t) => {
								const pct = (t.price / SLIDER_MAX) * 100;
								const isActive = effectiveFunding >= t.price;
								return (
									<div key={t.id} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${pct}%`, bottom: 0 }}>
										<span className={`text-[10px] mb-0.5 ${isActive ? "text-base-content font-semibold" : "text-base-content/40"}`}>{t.name}</span>
										<div className="w-px h-3 bg-base-content/20" />
									</div>
								);
							})}
						</div>
						{/* Custom track */}
						{(() => {
							const committedPct = (committedFunding / SLIDER_MAX) * 100;
							const pendingPct = (effectiveFunding / SLIDER_MAX) * 100;
							return (
								<div
									className="relative h-5 select-none cursor-pointer"
									onPointerDown={(e) => {
										const rect = e.currentTarget.getBoundingClientRect();
										const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
										handleFundingChange(Math.round(pct * SLIDER_MAX));
										e.preventDefault();
										(e.target as HTMLElement).setPointerCapture(e.pointerId);
									}}
									onPointerMove={(e) => {
										if (!(e.buttons & 1)) return;
										const rect = e.currentTarget.getBoundingClientRect();
										const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
										handleFundingChange(Math.round(pct * SLIDER_MAX));
									}}
								>
									<div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-2.5 bg-base-300 rounded-full overflow-hidden">
										<div className="absolute inset-y-0 left-0 bg-success/60 rounded-full" style={{ width: `${committedPct}%` }} />
										{hasPendingSub && effectiveFunding > committedFunding && (
											<div className="absolute inset-y-0 bg-error/60 rounded-r-full" style={{ left: `${committedPct}%`, width: `${pendingPct - committedPct}%` }} />
										)}
									</div>
									<div className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 shadow-md pointer-events-none ${hasPendingSub ? "bg-error border-error" : "bg-success border-success"}`} style={{ left: `${pendingPct}%` }} />
								</div>
							);
						})()}
						{/* Tick marks below slider */}
						<div className="relative w-full h-6 mt-1">
							{Array.from({ length: SLIDER_MAX + 1 }, (_, i) => i).map((tick) => {
								const pct = (tick / SLIDER_MAX) * 100;
								const isLabeled = tick % 5 === 0;
								return (
									<div key={tick} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${pct}%` }}>
										<div className={`bg-base-content/20 ${isLabeled ? "w-px h-3" : "w-px h-1.5"}`} />
										{isLabeled && <span className="text-[10px] text-base-content/40 mt-0.5">${tick}</span>}
									</div>
								);
							})}
						</div>
					</div>
				</div>
			)}

			{/* ── CREATOR ALLOCATIONS ── */}
			{rows.length > 0 ? (
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-2">
						Creator Allocations
						<InfoTip text="Your subscription is split between the Time Pool (automatic, based on time spent) and Boost allocations (manual, in $1 increments). Boost determines which gated content you can access. Unallocated boost returns to the Time Pool." />
					</h4>
					<div className="overflow-x-auto">
						<table className="table table-sm w-full">
							<thead>
								<tr>
									<th className="w-40">Creator</th>
									<th className="w-20">Time</th>
									<th className="w-6"></th>
									<th className="w-20">Pool</th>
									<th className="w-72">Boost</th>
									<th className="w-20 text-right">Total</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => {
									const timePct = totalTime > 0 ? (row.timeSeconds / totalTime) * 100 : 0;
									const pendingTimePoolTotal = financials.timePool + unallocatedBoost;
									const pendingPoolAmt = totalTime > 0
										? Math.round(pendingTimePoolTotal * (row.timeSeconds / totalTime) * 100) / 100
										: 0;
									const poolChanged = pendingFunding !== null && pendingFunding !== committedFunding;
									const displayPool = poolChanged ? pendingPoolAmt : row.poolAmount;
									const rowTotal = displayPool + row.pendingBoost;
									const initials = (row.displayName || row.username).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
									const boostChanged = row.pendingBoost !== row.committedBoost;

									return (
										<tr key={row.creatorId} className="hover">
											<td>
												<div className="flex items-center gap-1.5">
													{row.avatar ? (
														<img src={row.avatar} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
													) : (
														<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-[10px] font-bold text-base-content/60 flex-shrink-0">{initials}</div>
													)}
													<Link to={`/${row.username}`} className="font-medium text-sm truncate link link-hover">
														@{row.displayName || row.username}
													</Link>
												</div>
											</td>
											<td className="text-sm">{formatHours(row.timeSeconds)}</td>
											<td className="text-[10px] text-base-content/40 text-right">
												{timePct > 0 ? `${Math.round(timePct)}%` : ""}
											</td>
											<td className={`text-sm ${poolChanged ? "text-error" : "text-success"}`}>
												{fmt(displayPool)}
											</td>
											<td className="align-top pt-2">
												{canEdit ? (
													<BoostBar
														value={row.pendingBoost}
														committedValue={row.committedBoost}
														boostPool={financials.boostPool}
														gates={row.gates}
														onChange={(v) => handleBoostChange(row.creatorId, v)}
														disabled={viewMode === "current" && unallocatedBoost <= 0 && !hasPendingChanges}
													/>
												) : (
													<span className="text-sm text-primary">{fmt(row.pendingBoost)}</span>
												)}
											</td>
											<td className="text-right text-sm font-medium align-top pt-2">
												{fmt(rowTotal)}
												{boostChanged && (
													<div className="text-[10px] text-error">(pending)</div>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>
			) : (
				<div className="py-6 text-center text-sm text-base-content/40">
					{viewMode === "next" ? (
						<p>Next month's distributions will be calculated based on your time with creators.</p>
					) : (
						<>
							<p>No distributions yet this cycle.</p>
							<p className="mt-1">Your time pool is distributed proportionally — video, audio, text, and gameplay all count equally.</p>
						</>
					)}
				</div>
			)}

			{/* ── Cost Breakdown + Actions ── */}
			<div className="flex items-end gap-6">
				{/* Left: subscription actions */}
				{viewMode === "current" && (
					<div className="flex flex-col gap-2 flex-shrink-0">
						{isCanceling ? (
							<button className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`} onClick={handleResume} disabled={!!actionLoading}>
								{actionLoading === "resume" ? "Resuming..." : "Resume Subscription"}
							</button>
						) : (
							<button className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`} onClick={handleCancel} disabled={!!actionLoading}>
								{actionLoading === "cancel" ? "Canceling..." : "Cancel Subscription"}
							</button>
						)}
						<button className={`btn btn-ghost btn-sm ${actionLoading === "portal" ? "btn-disabled" : ""}`} onClick={handleBillingPortal} disabled={!!actionLoading}>
							{actionLoading === "portal" ? "Opening..." : "Manage Billing"}
						</button>
					</div>
				)}

				{/* Center: cost breakdown */}
				<div className="flex-1 text-sm max-w-lg mx-auto">
					{/* Subscription header */}
					<div className="flex items-center justify-between py-2 border-b border-base-content/10">
						<span className="text-base-content/60">Subscription</span>
						<div className="flex items-baseline gap-1">
							<span className={`text-xl font-bold ${hasPendingSub ? "text-error" : ""}`}>
								${effectiveFunding}
							</span>
							<span className="text-base-content/40 text-xs">/mo</span>
						</div>
					</div>

					{/* Line items */}
					<div className="py-2 space-y-1.5">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOT_COLORS.timePool }} />
								<span className="text-base-content/70">
									Time Pool
									<InfoTip text="Distributed automatically to creators based on the time you spend with their content. A minute of video, audio, reading, or gameplay all count equally." />
								</span>
								{unallocatedBoost > 0 && (
									<span className="text-base-content/40 text-xs">
										(incl. {fmt(unallocatedBoost)} unallocated boost)
									</span>
								)}
							</div>
							<strong className="text-success">
								{fmt((totalPool > 0 ? totalPool : financials.timePool) + unallocatedBoost)}
							</strong>
						</div>
						{financials.boostPool > 0 && (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOT_COLORS.boost }} />
									<span className="text-base-content/70">
										Boost Pool
										<InfoTip text="Funds you direct to specific creators in $1 increments. Your boost determines which gated content you can access. Unallocated boost returns to the Time Pool." />
									</span>
								</div>
								<strong className="text-primary">{fmt(allocatedBoost)}</strong>
							</div>
						)}
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOT_COLORS.foundation }} />
								<span className="text-base-content/70">
									Anthers Foundation
									<InfoTip text="8% of your subscription funds the Anthers Foundation, which allocates between charitable programs (min 50%) and organizational operations. Quarterly reports show exactly how the fee is spent." />
								</span>
							</div>
							<strong>{fmt(foundationFee)}</strong>
						</div>
						{viewMode !== "next" && (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOT_COLORS.delivery }} />
									<span className="text-base-content/70">
										Delivery
										<InfoTip text="Bandwidth cost of content you consume. Estimate assumes 1080p video — audio and text cost far less. Your $1/mo delivery credit is applied first." />
										{deliveryAmt > 0 && (
											<span className="text-base-content/40 text-xs ml-1">
												({fmt(grossDelivery)} − $1.00 credit)
											</span>
										)}
										{deliveryAmt === 0 && deliveryEstimate.hours > 0 && (
											<span className="text-success text-xs ml-1">($1 credit covers this)</span>
										)}
									</span>
								</div>
								<strong>{fmt(deliveryAmt)}</strong>
							</div>
						)}
						{viewMode !== "next" && (
							<>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOT_COLORS.salesTax }} />
										<span className="text-base-content/70">Est. sales tax</span>
									</div>
									<strong>{fmt(salesTax)}</strong>
								</div>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOT_COLORS.cardFee }} />
										<span className="text-base-content/70">Card fee</span>
									</div>
									<strong>{fmt(cardFee)}</strong>
								</div>
							</>
						)}
					</div>

					{/* Total */}
					<div className="flex items-center justify-between pt-2 border-t border-base-content/20">
						<span className="font-bold">{viewMode === "next" ? "Monthly total" : "Total w/Fees"}</span>
						<div className="flex items-baseline gap-1">
							<span className={`text-xl font-bold ${hasPendingSub ? "text-error" : ""}`}>
								{fmt(viewMode === "next" ? effectiveFunding : totalWithFees)}
							</span>
							<span className="text-base-content/40 text-xs">/mo</span>
						</div>
					</div>

					{sub.currentPeriodEnd && viewMode === "current" && (
						<p className="text-xs text-base-content/40 mt-1">
							Next charge: {new Date(sub.currentPeriodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
						</p>
					)}
				</div>

				{/* Right: save/discard */}
				{canEdit && (
					<div className="flex flex-col gap-2 flex-shrink-0 items-end">
						<button
							className={`btn btn-primary btn-sm ${actionLoading === "save" ? "btn-disabled" : ""}`}
							onClick={() => setShowConfirm(true)}
							disabled={!hasPendingChanges || !!actionLoading}
						>
							{actionLoading === "save" ? "Saving..." : "Save Changes"}
						</button>
						<button
							className="btn btn-outline btn-warning btn-sm"
							disabled={!hasPendingChanges}
							onClick={() => { setPendingFunding(null); setPendingBoosts(new Map()); }}
						>
							Discard Changes
						</button>
						{viewMode === "next" && (
							<button className="btn btn-ghost btn-xs" onClick={() => setShowRevertConfirm(true)}>
								Revert to Current Month
							</button>
						)}
					</div>
				)}
			</div>

			{/* ── Confirmation dialogs ── */}
			<ConfirmDialog
				open={showConfirm}
				title="Save Changes"
				onConfirm={handleSave}
				onCancel={() => setShowConfirm(false)}
				confirmLabel="Confirm & Save"
			>
				{pendingFunding !== null && pendingFunding !== committedFunding && (
					<div className="flex justify-between py-1">
						<span>Subscription level</span>
						<span>{fmt(committedFunding)} &rarr; <strong>{fmt(pendingFunding)}</strong></span>
					</div>
				)}
				{Array.from(pendingBoosts.entries()).map(([cid, amount]) => {
					const row = rows.find((r) => r.creatorId === cid);
					const committed = committedBoostMap.get(cid) ?? 0;
					if (amount === committed) return null;
					return (
						<div key={cid} className="flex justify-between py-1">
							<span>Boost to @{row?.displayName || row?.username}</span>
							<span>${committed} &rarr; <strong>${amount}</strong></span>
						</div>
					);
				})}
				{viewMode === "current" && pendingBoosts.size > 0 && (
					<p className="text-xs text-base-content/40 mt-2 border-t border-base-content/10 pt-2">
						These boost changes will also be applied to next month's allocations.
					</p>
				)}
			</ConfirmDialog>

			<ConfirmDialog
				open={showRevertConfirm}
				title="Revert to Current Month"
				onConfirm={handleRevert}
				onCancel={() => setShowRevertConfirm(false)}
				confirmLabel="Revert"
				confirmClass="btn-error"
			>
				<p>This will reset all next-month boosts to match your current month's committed values. Any changes you've made here will be lost.</p>
			</ConfirmDialog>
		</div>
	);
}

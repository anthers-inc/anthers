// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Account dashboard — the support model.
 *
 * The user holds a count of Anthers-Seeds (their rank, free/root/sprout/petal/
 * blossom = 0…4+). This page surfaces:
 *   1. The rank (each Anthers-Seed: Time Pool + Supports Anthers; streaming allowance).
 *   2. The creator-Seed budget + per-creator Seed allocations (directed, $3 units).
 *   3. Pool distributions (poolAmount + seedAmount) and, for creators, earnings.
 *
 * Rank changes happen on /subscribe; here we direct Seeds. Bandwidth is folded into
 * the Anthers-Seeds (no wallet).
 */

import { SeedStepper } from "@anthers/web-shared/economics/SeedStepper";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type {
	Account,
	AccountResponse,
	AttentionSummary,
	Badge,
	BadgeView,
	CreatorEarnings,
	CreatorGate,
	PoolDistribution,
	SeedListResponse,
} from "@anthers/web-shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function fmt(n: number | string): string {
	return `$${Number(n).toFixed(2)}`;
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
	const d = new Date(`${cycle}T00:00:00`);
	d.setMonth(d.getMonth() + offset);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function cycleLabel(cycle: string): string {
	return new Date(`${cycle}T00:00:00`).toLocaleString("default", {
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

/** Fetch a subscriptions GET endpoint that carries query params (raw, credentialed). */
async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(`${apiBaseUrl()}/api/subscriptions/${path}`, { credentials: "include" });
	if (!res.ok) throw new Error(`Request failed: ${path}`);
	return (await res.json()) as T;
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
/*  Month Selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({ cycle, onChange }: { cycle: string; onChange: (c: string) => void }) {
	const current = getCurrentCycle();
	const nextCycle = offsetCycle(current, 1);
	const mode = viewModeFor(cycle);
	return (
		<div className="flex items-center justify-center gap-3">
			<button
				type="button"
				className="btn btn-ghost btn-xs"
				onClick={() => onChange(offsetCycle(cycle, -1))}
			>
				&larr;
			</button>
			<span className="text-sm font-medium min-w-[140px] text-center">
				{cycleLabel(cycle)}
				{mode === "current" && <span className="text-xs text-base-content/40 ml-1">(current)</span>}
				{mode === "next" && <span className="text-xs text-primary ml-1">(preview)</span>}
			</span>
			{cycle < nextCycle ? (
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={() => onChange(offsetCycle(cycle, 1))}
				>
					&rarr;
				</button>
			) : (
				<div className="btn btn-ghost btn-xs invisible">&rarr;</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Pie chart of time distribution                                     */
/* ------------------------------------------------------------------ */

const PIE_COLORS = [
	"#6d28d9",
	"#2563eb",
	"#0891b2",
	"#059669",
	"#d97706",
	"#dc2626",
	"#c026d3",
	"#4f46e5",
];

function TimePoolPie({ rows, totalTime }: { rows: CreatorRow[]; totalTime: number }) {
	const size = 200;
	const cx = size / 2;
	const cy = size / 2;
	const radius = 75;
	const strokeWidth = 30;

	if (totalTime === 0 || rows.length === 0) {
		return (
			<div className="flex items-center justify-center h-[200px]">
				<div className="text-sm text-base-content/30 text-center">
					<p>No time data yet</p>
				</div>
			</div>
		);
	}

	const arcPath = (startAngle: number, endAngle: number, r: number) => {
		const start = { x: cx + r * Math.cos(startAngle), y: cy + r * Math.sin(startAngle) };
		const end = { x: cx + r * Math.cos(endAngle), y: cy + r * Math.sin(endAngle) };
		const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
		return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
	};

	let angleOffset = -Math.PI / 2;
	const slices = rows.map((row, i) => {
		const pct = row.timeSeconds / totalTime;
		const sliceAngle = pct * 2 * Math.PI;
		const startAngle = angleOffset;
		const endAngle = angleOffset + Math.min(sliceAngle, 2 * Math.PI - 0.001);
		angleOffset += sliceAngle;
		if (pct === 0) return null;
		return (
			<path
				key={row.creatorId}
				d={arcPath(startAngle, endAngle, radius)}
				fill="none"
				stroke={PIE_COLORS[i % PIE_COLORS.length]}
				strokeWidth={strokeWidth}
				strokeLinecap="butt"
			/>
		);
	});

	return (
		<div className="flex items-center justify-center">
			<svg role="img" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
				<title>Time distribution by creator</title>
				{slices}
				<text x={cx} y={cy - 6} textAnchor="middle" className="fill-base-content text-lg font-bold">
					{formatHours(totalTime)}
				</text>
				<text x={cx} y={cy + 12} textAnchor="middle" className="fill-base-content/50 text-[10px]">
					total time
				</text>
			</svg>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Row model                                                          */
/* ------------------------------------------------------------------ */

interface CreatorRow {
	creatorId: number;
	username: string;
	displayName: string | null;
	avatar: string | null;
	timeSeconds: number;
	poolAmount: number;
	/** Settled Seeds to this creator this cycle (from the distribution row). */
	settledSeed: number;
	/** Committed (saved) Seed allocation, whole dollars. */
	committedSeed: number;
	/** Effective Seed allocation including local pending edits. */
	pendingSeed: number;
	gates: CreatorGate[];
}

function initials(row: CreatorRow): string {
	return (row.displayName || row.username)
		.split(/\s+/)
		.map((w) => w[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function SubscriptionPage() {
	const [searchParams] = useSearchParams();

	// Account + Badge + earnings
	const [account, setAccount] = useState<Account | null>(null);
	const [badge, setBadge] = useState<Badge>("free");
	const [badgeView, setBadgeView] = useState<BadgeView | null>(null);
	const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);

	// Per-cycle data
	const [attention, setAttention] = useState<AttentionSummary | null>(null);
	const [distributions, setDistributions] = useState<PoolDistribution[]>([]);
	const [seedList, setSeedList] = useState<SeedListResponse | null>(null);
	const [creatorGatesMap, setCreatorGatesMap] = useState<Map<string, CreatorGate[]>>(new Map());

	// UI state
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());

	// Pending Seed edits (creatorId → whole dollars)
	const [pendingSeeds, setPendingSeeds] = useState<Map<number, number>>(new Map());

	const sessionId = searchParams.get("session_id");
	const viewMode = viewModeFor(selectedCycle);
	const canEdit = viewMode === "current" || viewMode === "next";

	// ── Data fetching ──

	const fetchAccount = useCallback(async () => {
		try {
			const meRes = await client.api.subscriptions.me.$get();
			const me = (await meRes.json()) as AccountResponse;
			setAccount(me.account);
			setBadge(me.badge);
			setBadgeView(me.badgeView);
		} catch {
			setError("Failed to load your account.");
		} finally {
			setLoading(false);
		}

		// Earnings (non-blocking — only meaningful for creators)
		client.api.subscriptions.earnings
			.$get()
			.then((res) => res.json())
			.then((data) => setEarnings(data as CreatorEarnings))
			.catch(() => {});
	}, []);

	const fetchCycleData = useCallback(async (cycle: string) => {
		const [att, dist, seeds] = await Promise.allSettled([
			getJson<AttentionSummary>(`attention/summary?cycle=${cycle}`),
			getJson<{ distributions: PoolDistribution[] }>(`distributions?cycle=${cycle}`),
			getJson<SeedListResponse>(`seeds?cycle=${cycle}`),
		]);

		if (att.status === "fulfilled") setAttention(att.value);
		if (seeds.status === "fulfilled") setSeedList(seeds.value);

		if (dist.status === "fulfilled") {
			const rows = dist.value.distributions;
			setDistributions(rows);

			// Fetch each creator's gates for the Seed-gate hints.
			const usernames = rows.map((d) => d.creator?.username).filter(Boolean) as string[];
			const gatesMap = new Map<string, CreatorGate[]>();
			const gateResults = await Promise.allSettled(
				usernames.map(async (u) => ({
					username: u,
					gates: (await getJson<{ gates: CreatorGate[] }>(`gates?creator=${u}`)).gates,
				})),
			);
			for (const r of gateResults) {
				if (r.status === "fulfilled") gatesMap.set(r.value.username, r.value.gates);
			}
			setCreatorGatesMap(gatesMap);
		}

		setPendingSeeds(new Map());
	}, []);

	useEffect(() => {
		fetchAccount();
	}, [fetchAccount]);
	useEffect(() => {
		fetchCycleData(selectedCycle);
	}, [selectedCycle, fetchCycleData]);

	useEffect(() => {
		if (sessionId) {
			setSuccess("Payment received! Your account is updated.");
			const timer = setTimeout(fetchAccount, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId, fetchAccount]);

	// ── Derived rows ──

	const committedSeedMap = useMemo(() => {
		const map = new Map<number, number>();
		for (const s of seedList?.seeds ?? []) map.set(s.creatorId, Math.round(Number(s.amount)));
		return map;
	}, [seedList]);

	const rows: CreatorRow[] = useMemo(() => {
		const map = new Map<number, CreatorRow>();
		for (const d of distributions) {
			map.set(d.creatorId, {
				creatorId: d.creatorId,
				username: d.creator?.username ?? "",
				displayName: d.creator?.displayName ?? null,
				avatar: d.creator?.avatar ?? null,
				timeSeconds: d.attentionSeconds ?? 0,
				poolAmount: Number(d.poolAmount),
				settledSeed: Number(d.seedAmount),
				committedSeed: 0,
				pendingSeed: 0,
				gates: [],
			});
		}
		for (const s of seedList?.seeds ?? []) {
			const committed = Math.round(Number(s.amount));
			const existing = map.get(s.creatorId);
			if (existing) {
				existing.committedSeed = committed;
			} else {
				map.set(s.creatorId, {
					creatorId: s.creatorId,
					username: s.creator?.username ?? "",
					displayName: s.creator?.displayName ?? null,
					avatar: null,
					timeSeconds: 0,
					poolAmount: 0,
					settledSeed: 0,
					committedSeed: committed,
					pendingSeed: 0,
					gates: [],
				});
			}
		}
		for (const row of map.values()) {
			row.pendingSeed = pendingSeeds.get(row.creatorId) ?? row.committedSeed;
			row.gates = creatorGatesMap.get(row.username) ?? [];
		}
		return Array.from(map.values()).sort(
			(a, b) => b.poolAmount + b.pendingSeed - (a.poolAmount + a.pendingSeed),
		);
	}, [distributions, seedList, pendingSeeds, creatorGatesMap]);

	const totalTime = rows.reduce((s, r) => s + r.timeSeconds, 0);
	const totalPool = rows.reduce((s, r) => s + r.poolAmount, 0);

	const seedBudget = Number(seedList?.budget ?? 0);
	const allocatedSeed = rows.reduce((s, r) => s + r.pendingSeed, 0);
	const remainingSeed = Math.max(0, seedBudget - allocatedSeed);

	const hasPendingSeeds = useMemo(() => {
		for (const [cid, val] of pendingSeeds) {
			if (val !== (committedSeedMap.get(cid) ?? 0)) return true;
		}
		return false;
	}, [pendingSeeds, committedSeedMap]);

	const isPaid = badge !== "free";
	const isCanceling = account ? !!account.canceledAt : false;

	// ── Seed allocation handlers ──

	const handleSeedChange = (creatorId: number, newVal: number) => {
		const committed = committedSeedMap.get(creatorId) ?? 0;
		const floor = viewMode === "current" ? committed : 0;
		const otherAllocated = rows
			.filter((r) => r.creatorId !== creatorId)
			.reduce((s, r) => s + r.pendingSeed, 0);
		const maxForThis = Math.max(floor, seedBudget - otherAllocated);
		const clamped = Math.max(floor, Math.min(Math.floor(newVal), maxForThis));
		setPendingSeeds((prev) => {
			const next = new Map(prev);
			if (clamped === committed) next.delete(creatorId);
			else next.set(creatorId, clamped);
			return next;
		});
	};

	const handleSaveSeeds = async () => {
		setActionLoading("seeds");
		setError(null);
		try {
			for (const row of rows) {
				if (row.pendingSeed === row.committedSeed) continue;
				const res = await client.api.subscriptions.seeds.$post({
					json: {
						creatorId: row.creatorId,
						amount: row.pendingSeed.toFixed(2),
						cycle: selectedCycle,
					},
				});
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					setError(data.error ?? "Failed to give Seeds.");
					break;
				}
			}
			setSuccess("Your Seeds are given.");
			setPendingSeeds(new Map());
			await fetchCycleData(selectedCycle);
		} catch {
			setError("Failed to give Seeds.");
		} finally {
			setActionLoading(null);
		}
	};

	// ── Account actions ──

	const handleCancel = async () => {
		setActionLoading("cancel");
		setError(null);
		try {
			const res = await client.api.subscriptions.cancel.$post();
			setAccount(((await res.json()) as unknown as { account: Account }).account);
			setSuccess(
				"The Seeds you give Anthers will revert to Free at the end of the current billing period.",
			);
		} catch {
			setError("Failed to cancel.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleResume = async () => {
		setActionLoading("resume");
		setError(null);
		try {
			const res = await client.api.subscriptions.resume.$post();
			setAccount(((await res.json()) as unknown as { account: Account }).account);
			setSuccess("Subscription renewal resumed.");
		} catch {
			setError("Failed to resume.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleBillingPortal = async () => {
		setActionLoading("portal");
		try {
			const res = await client.api.subscriptions["billing-portal"].$post();
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				setError(data.error ?? "Failed to open billing portal.");
				setActionLoading(null);
				return;
			}
			window.location.href = ((await res.json()) as { portalUrl: string }).portalUrl;
		} catch {
			setError("Failed to open billing portal.");
			setActionLoading(null);
		}
	};

	/* ---- Render ---- */

	if (loading)
		return (
			<div className="flex justify-center py-16">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);

	if (!account || !badgeView)
		return (
			<div className="max-w-2xl mx-auto px-4 py-8 text-center">
				<h1 className="text-2xl font-bold mb-4">Account unavailable</h1>
				<p className="mb-4">{error ?? "We couldn't load your account. Please try again."}</p>
				<Link to="/subscribe" className="btn btn-primary">
					Give Seeds
				</Link>
			</div>
		);

	return (
		// `min-w-0 w-full max-w-full` breaks the flex-column min-content cascade
		// so this wrapper can shrink below its inner content's min-content
		// width on mobile (the same fix the other top-level pages carry).
		// Without `w-full`, `mx-auto` on a flex item disables the default
		// `align-self: stretch`, so the wrapper falls back to its content's
		// intrinsic width (up to the cap), which can push past the mobile
		// viewport. The wide-screen cap is `max-w-[72rem]` (was an inline
		// style, which wins over `max-w-full` and so defeated the cap below the
		// cap).
		<div className="mx-auto min-w-0 w-full max-w-full max-w-[72rem] px-4 py-8">
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

			{/* ── Header ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
					<div className="flex flex-col gap-2 md:w-40 order-2 md:order-1">
						{viewMode === "current" && (
							<>
								<button
									type="button"
									className={`btn btn-sm ${actionLoading === "portal" ? "btn-disabled" : "btn-neutral"}`}
									onClick={handleBillingPortal}
									disabled={!!actionLoading}
								>
									{actionLoading === "portal" ? "Opening…" : "Manage Billing"}
								</button>
								{isPaid &&
									(isCanceling ? (
										<button
											type="button"
											className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`}
											onClick={handleResume}
											disabled={!!actionLoading}
										>
											{actionLoading === "resume" ? "Resuming…" : "Resume giving Seeds"}
										</button>
									) : (
										<button
											type="button"
											className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
											onClick={handleCancel}
											disabled={!!actionLoading}
										>
											{actionLoading === "cancel" ? "Stopping…" : "Stop giving Seeds"}
										</button>
									))}
							</>
						)}
					</div>

					<div className="text-center flex-1 order-1 md:order-2">
						<h1 className="text-2xl font-bold mb-1">Your Anthers — {cycleLabel(selectedCycle)}</h1>
						<p className="text-sm text-base-content/60 mb-2">
							<strong>{badgeView.name}</strong>
							<span className="text-base-content/40"> · {fmt(badgeView.price)}/mo</span>
							{isCanceling && (
								<span className="text-error ml-1">(reverts to Free at period end)</span>
							)}
						</p>
						<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />
						{/* Fixed-height so switching months changes the text without shifting the layout. */}
						<p className="text-xs text-base-content/50 mt-1.5 min-h-[1rem]">
							{viewMode === "past"
								? "Read-only view of a closed cycle."
								: viewMode === "next"
									? "Preview — you can direct next month's Seeds now."
									: ""}
						</p>
					</div>

					<div className="md:w-40 flex md:justify-end order-3">
						<Link to="/subscribe" className="btn btn-primary btn-sm">
							Adjust Seeds
						</Link>
					</div>
				</div>

				{/* Where the month's Seeds go */}
				<div className="divider text-sm text-base-content/50 my-3">
					What your Seeds to Anthers fund
					<InfoTip text="Each Seed given to Anthers ($3) funds the Time Pool ($1.50, to creators by watch-time) and Supports Anthers (your bandwidth at cost + the remainder that funds free access and the charitable programs). The card fee is inside the price; there's no wallet." />
				</div>
				<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
					<div>
						<div className="text-xs text-base-content/50 uppercase">Time Pool</div>
						<div className="text-lg font-bold text-success">{fmt(badgeView.timePool)}</div>
						<div className="text-[11px] text-base-content/40">to creators, by watch-time</div>
					</div>
					<div>
						<div className="text-xs text-base-content/50 uppercase">Supports Anthers</div>
						<div className="text-lg font-bold">{fmt(badgeView.supportsAnthers)}</div>
						<div className="text-[11px] text-base-content/40">
							your bandwidth (at cost) + free access &amp; programs
						</div>
					</div>
					<div>
						<div className="text-xs text-base-content/50 uppercase">Streaming allowance</div>
						<div className="text-lg font-bold">{badgeView.allowanceGiB} GiB</div>
						<div className="text-[11px] text-base-content/40">per month, folded in</div>
					</div>
				</div>
			</div>

			{/* ── Time Pool + Seeds ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="divider text-sm text-base-content/50 mt-0 mb-1">
					Creators You Support
					<InfoTip text="Two ways money reaches creators: the Time Pool (automatic, split by your watch-time — video, audio, reading, and gameplay all count equally) and Seeds (whole dollars you direct to specific creators, 100% to them)." />
				</div>
				{attention && (
					<p className="text-xs text-base-content/40 text-center mb-3">
						{attention.hoursUsed} hrs of time with creators this cycle
					</p>
				)}

				{rows.length > 0 ? (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						{/* Time Pool */}
						<div className="flex flex-col">
							<p className="text-xs text-base-content/40 uppercase tracking-wider mb-2 text-center">
								Time Pool
							</p>
							<TimePoolPie rows={rows} totalTime={totalTime} />
							<div className="mt-3 space-y-1">
								{rows.map((row, i) => {
									const pct = totalTime > 0 ? Math.round((row.timeSeconds / totalTime) * 100) : 0;
									return (
										<div
											key={row.creatorId}
											className="flex items-center gap-2 text-xs px-1 py-0.5"
										>
											<div
												className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
												style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
											/>
											<Link
												to={`/${row.username}`}
												className="text-base-content/70 truncate flex-1 link-hover"
											>
												{row.displayName || row.username}
											</Link>
											<span className="text-base-content/40 tabular-nums">{pct}%</span>
											<span className="tabular-nums text-success">{fmt(row.poolAmount)}</span>
										</div>
									);
								})}
							</div>
							<div className="flex items-center justify-between text-sm border-t border-base-content/10 mt-2 pt-2">
								<span className="text-base-content/60">Time Pool total</span>
								<strong className="text-success">{fmt(totalPool)}</strong>
							</div>
						</div>

						{/* Seeds */}
						<div className="flex flex-col">
							<p className="text-xs text-base-content/40 uppercase tracking-wider mb-2 text-center">
								Seeds
							</p>

							{/* Budget summary */}
							<div className="mb-3">
								<div className="flex items-center justify-between text-xs text-base-content/60 mb-1">
									<span>{fmt(seedBudget)} total</span>
									<span>
										{fmt(allocatedSeed)} given · {fmt(remainingSeed)} left
									</span>
								</div>
								<div className="relative h-2 bg-base-300 rounded-full overflow-hidden">
									<div
										className="absolute inset-y-0 left-0 bg-success/80 rounded-full"
										style={{
											width: `${seedBudget > 0 ? Math.min(100, (allocatedSeed / seedBudget) * 100) : 0}%`,
										}}
									/>
								</div>
							</div>

							{seedBudget <= 0 ? (
								<div className="text-sm text-base-content/50 text-center py-4">
									<p>You've given no Seeds this cycle.</p>
									<Link to="/subscribe" className="link link-primary text-sm">
										Upgrade to give Seeds
									</Link>
								</div>
							) : (
								<div className="space-y-2">
									{rows.map((row, i) => {
										const committed = row.committedSeed;
										const floor = viewMode === "current" ? committed : 0;
										const otherAllocated = allocatedSeed - row.pendingSeed;
										const maxForThis = Math.max(floor, seedBudget - otherAllocated);
										const changed = row.pendingSeed !== committed;
										const seedGates = row.gates.filter((g) => g.gateType === "seed");
										return (
											<div key={row.creatorId} className="rounded-lg p-2 bg-base-100/40">
												<div className="flex items-center gap-2">
													<div
														className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
														style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
													>
														{row.avatar ? (
															<img
																src={row.avatar}
																alt=""
																className="w-5 h-5 rounded-full object-cover"
															/>
														) : (
															initials(row)
														)}
													</div>
													<Link
														to={`/${row.username}`}
														className="text-xs text-base-content/70 truncate flex-1 link-hover"
													>
														{row.displayName || row.username}
													</Link>
													{canEdit ? (
														<SeedStepper
															value={row.pendingSeed}
															min={floor}
															max={maxForThis}
															onChange={(v) => handleSeedChange(row.creatorId, v)}
															disabled={!!actionLoading}
														/>
													) : (
														<span className="text-sm text-success tabular-nums">
															{fmt(row.settledSeed || committed)}
														</span>
													)}
													{changed && <span className="text-[9px] text-primary">(pending)</span>}
												</div>
												{seedGates.length > 0 && (
													<div className="mt-1 pl-7 flex flex-wrap gap-1">
														{seedGates.map((gate) => {
															const unlocked = row.pendingSeed >= Number(gate.threshold);
															return (
																<span
																	key={gate.id}
																	className={`badge badge-xs ${unlocked ? "badge-success" : "badge-ghost"}`}
																	title={gate.description ?? undefined}
																>
																	{unlocked ? "✓" : "○"} {gate.label} (${gate.threshold})
																</span>
															);
														})}
													</div>
												)}
											</div>
										);
									})}

									{canEdit && (
										<div className="flex gap-2 pt-1">
											<button
												type="button"
												className={`btn btn-primary btn-sm ${actionLoading === "seeds" ? "btn-disabled" : ""}`}
												onClick={handleSaveSeeds}
												disabled={!hasPendingSeeds || !!actionLoading}
											>
												{actionLoading === "seeds" ? "Giving…" : "Give Seeds"}
											</button>
											<button
												type="button"
												className="btn btn-ghost btn-sm"
												onClick={() => setPendingSeeds(new Map())}
												disabled={!hasPendingSeeds}
											>
												Discard
											</button>
										</div>
									)}
								</div>
							)}
						</div>
					</div>
				) : (
					<div className="py-6 text-center text-sm text-base-content/40">
						<p>No time with creators yet this cycle.</p>
						<p className="mt-1">
							Your Time Pool is distributed by watch-time — video, audio, text, and gameplay all
							count equally.
						</p>
					</div>
				)}
			</div>

			{/* ── Creator earnings ── */}
			{earnings && parseFloat(earnings.total) > 0 && (
				<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
					<div className="divider text-sm text-base-content/50 mt-0 mb-3">
						Your Creator Earnings
					</div>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<div>
							<div className="text-xs text-base-content/50 uppercase">Pool income</div>
							<div className="text-xl font-bold text-success">{fmt(earnings.poolTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Seed income</div>
							<div className="text-xl font-bold text-success">{fmt(earnings.seedTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Total</div>
							<div className="text-xl font-bold">{fmt(earnings.total)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Supporters</div>
							<div className="text-xl font-bold">{earnings.subscriberCount}</div>
						</div>
					</div>
					{earnings.cycle && (
						<p className="text-xs text-base-content/50 mt-2">
							Cycle:{" "}
							{new Date(earnings.cycle).toLocaleDateString("en-US", {
								month: "long",
								year: "numeric",
							})}
						</p>
					)}
				</div>
			)}

			{account.currentPeriodEnd && viewMode === "current" && (
				<p className="text-xs text-base-content/40 text-center">
					{isCanceling ? "Seeds end" : "Next renewal"}:{" "}
					{new Date(account.currentPeriodEnd).toLocaleDateString("en-US", {
						month: "long",
						day: "numeric",
						year: "numeric",
					})}
				</p>
			)}
		</div>
	);
}

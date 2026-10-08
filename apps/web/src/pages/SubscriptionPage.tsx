// SPDX-License-Identifier: Apache-2.0

/*
 * Account dashboard — the support model.
 *
 * The user gives Anthers a monthly amount, which names their Badge (free/root/
 * sprout/petal/blossom at $0/$3/$6/$9/$12). This page surfaces:
 *   1. That Badge, and where the amount goes (Time Pool + Supports Anthers).
 *   2. The budget for creators + the Badges held from them (GET /my-badges).
 *   3. Pool distributions (poolAmount + badgeAmount) and, for creators, earnings.
 *
 * The amount to Anthers is changed on /signup; here it is directed at creators.
 * There is no bandwidth line — streaming and downloads are unlimited and free.
 */

import { timePoolFor } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { EarningsBasis } from "@anthers/web-shared/economics/EarningsBasis";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type {
	Account,
	AccountResponse,
	AttentionSummary,
	Badge,
	BadgeHoldingsResponse,
	BadgeView,
	CreatorBadge,
	CreatorBadgeListResponse,
	CreatorEarnings,
	PoolDistribution,
} from "@anthers/web-shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import InfoTip from "../components/payments/InfoTip";
import { useAnthersLadder } from "../lib/anthers-ladder";

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
/*  InfoTip lives in components/payments — shared with /basket.        */
/* ------------------------------------------------------------------ */

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
	handle: string;
	displayName: string | null;
	avatar: string | null;
	timeSeconds: number;
	poolAmount: number;
	/** Settled Badge share for this creator this cycle (from the distribution row). */
	settledBadge: number;
	/** The threshold of the Badge held from this creator this cycle, or 0. */
	committedBadge: number;
	/** The rung held or picked, including local pending edits. */
	pendingBadge: CreatorBadge | null;
	/** The creator's ladder, for the pick UI and the rung chips. */
	rungs: CreatorBadge[];
}

function initials(row: CreatorRow): string {
	return (row.displayName || row.handle)
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

	// The seeded ladder, for what this page quotes: the InfoTip's claim about what a
	// fan's support funds, and the comparison that names the price lifting the Public
	// Access limit. The constants stand in until the fetch lands.
	const { publicAccessPrice } = useAnthersLadder();

	// Account + Badge + earnings
	const [account, setAccount] = useState<Account | null>(null);
	const [badge, setBadge] = useState<Badge>("free");
	const [badgeView, setBadgeView] = useState<BadgeView | null>(null);
	const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);

	// Per-cycle data
	const [attention, setAttention] = useState<AttentionSummary | null>(null);
	const [distributions, setDistributions] = useState<PoolDistribution[]>([]);
	const [holdings, setHoldings] = useState<BadgeHoldingsResponse | null>(null);
	const [laddersMap, setLaddersMap] = useState<Map<string, CreatorBadge[]>>(new Map());

	// UI state
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());

	// Pending Badge picks (creatorId → the rung picked), applied on *Give*.
	const [pendingPicks, setPendingPicks] = useState<Map<number, number>>(new Map());

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
		const [att, dist, held] = await Promise.allSettled([
			getJson<AttentionSummary>(`attention/summary?cycle=${cycle}`),
			getJson<{ distributions: PoolDistribution[] }>(`distributions?cycle=${cycle}`),
			getJson<BadgeHoldingsResponse>(`my-badges?cycle=${cycle}`),
		]);

		if (att.status === "fulfilled") setAttention(att.value);
		if (held.status === "fulfilled") setHoldings(held.value);

		if (dist.status === "fulfilled") {
			const rows = dist.value.distributions;
			setDistributions(rows);

			// Fetch each creator's ladder for the rung chips and the pick UI.
			const handles = rows.map((d) => d.creator?.handle).filter(Boolean) as string[];
			const ladders = new Map<string, CreatorBadge[]>();
			const ladderResults = await Promise.allSettled(
				handles.map(async (u) => ({
					handle: u,
					badges: (await getJson<CreatorBadgeListResponse>(`badges?creator=${u}`)).badges,
				})),
			);
			for (const r of ladderResults) {
				if (r.status === "fulfilled") ladders.set(r.value.handle, r.value.badges);
			}
			setLaddersMap(ladders);
		}

		setPendingPicks(new Map());
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

	const rows: CreatorRow[] = useMemo(() => {
		const map = new Map<number, CreatorRow>();
		for (const d of distributions) {
			// `creatorId` is null once that creator deletes their account — the payment
			// record survives them (Privacy Policy), so this list has to render the money without a
			// creator to attach it to. Keyed on a negative synthetic id so several deleted
			// creators stay separate rows rather than collapsing into one, and labeled
			// rather than blanked: the person is gone, what you paid is not.
			const key = d.creatorId ?? -d.id;
			map.set(key, {
				creatorId: d.creatorId ?? 0,
				handle: d.creator?.handle ?? "",
				displayName: d.creator?.displayName ?? (d.creatorId === null ? "Deleted creator" : null),
				avatar: d.creator?.avatar ?? null,
				timeSeconds: d.attentionSeconds ?? 0,
				poolAmount: Number(d.poolAmount),
				settledBadge: Number(d.badgeAmount),
				committedBadge: 0,
				pendingBadge: null,
				rungs: [],
			});
		}
		// A holding's dollars are its Badge's threshold by construction, so the holding
		// row carries no amount — the rung it names is the amount. The API keys a
		// holding by its Badge id only, so rows merge on HANDLE: a distribution or a
		// holding may arrive without the other, and both name the same creator.
		for (const h of holdings?.badges ?? []) {
			const existing = [...map.values()].find((row) => row.handle === h.creator.handle);
			const committed = Math.round(Number(h.threshold));
			const heldRung: CreatorBadge = {
				id: h.id,
				creatorId: existing?.creatorId ?? 0,
				threshold: h.threshold,
				label: h.label,
				description: h.description,
				hasArt: h.hasArt,
				artShape: h.artShape,
				artColor: h.artColor,
				sortOrder: 0,
				createdAt: h.createdAt,
				updatedAt: h.createdAt,
			};
			if (existing) {
				existing.committedBadge = committed;
				existing.pendingBadge = heldRung;
			} else {
				map.set(-h.id, {
					creatorId: -h.id,
					handle: h.creator.handle,
					displayName: h.creator.displayName ?? null,
					avatar: null,
					timeSeconds: 0,
					poolAmount: 0,
					settledBadge: 0,
					committedBadge: committed,
					pendingBadge: heldRung,
					rungs: [],
				});
			}
		}
		for (const row of map.values()) {
			const rungs = laddersMap.get(row.handle) ?? [];
			const picked = pendingPicks.get(row.creatorId);
			row.pendingBadge =
				picked === undefined
					? row.pendingBadge
					: (rungs.find((r) => Number(r.threshold) === picked) ?? null);
			row.rungs = rungs;
		}
		return Array.from(map.values()).sort(
			(a, b) => b.poolAmount + b.committedBadge - (a.poolAmount + a.committedBadge),
		);
	}, [distributions, holdings, pendingPicks, laddersMap]);

	const totalTime = rows.reduce((s, r) => s + r.timeSeconds, 0);
	const totalPool = rows.reduce((s, r) => s + r.poolAmount, 0);

	const badgeBudget = Number(holdings?.budget ?? 0);
	const allocatedBadges = rows.reduce(
		(s, r) => s + (r.pendingBadge ? Number(r.pendingBadge.threshold) : 0),
		0,
	);
	const remainingBudget = Math.max(0, badgeBudget - allocatedBadges);

	const hasPendingPicks = useMemo(() => pendingPicks.size > 0, [pendingPicks]);

	const isPaid = badge !== "free";
	const isCanceling = account ? !!account.canceledAt : false;

	// ── Badge pick handlers ──
	// A pick is a RUNG, never a typed amount: holding a creator's Badge is what a
	// subscription is, and the ladder's thresholds are the whole of what can be held.

	/** Record a pending rung pick for one creator. The committed rung clears the pick. */
	const handleBadgeChange = (creatorId: number, threshold: number) => {
		const committed = rows.find((r) => r.creatorId === creatorId)?.committedBadge ?? 0;
		setPendingPicks((prev) => {
			const next = new Map(prev);
			if (threshold === committed) next.delete(creatorId);
			else next.set(creatorId, threshold);
			return next;
		});
	};

	const handleSaveBadges = async () => {
		setActionLoading("badges");
		setError(null);
		try {
			for (const [creatorId, threshold] of pendingPicks) {
				const row = rows.find((r) => r.creatorId === creatorId);
				const rung = row?.rungs.find((r) => Number(r.threshold) === threshold);
				if (!rung) continue;
				const res = await client.api.subscriptions["my-badges"].$post({
					json: {
						badgeId: rung.id,
						...(selectedCycle !== getCurrentCycle() ? { cycle: selectedCycle } : {}),
					},
				});
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					setError(data.error ?? "Failed to save.");
					break;
				}
			}
			setSuccess("Your Badges are saved.");
			setPendingPicks(new Map());
			await fetchCycleData(selectedCycle);
		} catch {
			setError("Failed to save.");
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
				"Your support for Anthers will revert to Free at the end of the current billing period.",
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
				<Link to="/signup" className="btn btn-primary">
					Support Anthers
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
											{actionLoading === "resume" ? "Resuming…" : "Resume supporting"}
										</button>
									) : (
										<button
											type="button"
											className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
											onClick={handleCancel}
											disabled={!!actionLoading}
										>
											{actionLoading === "cancel" ? "Stopping…" : "Stop supporting"}
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
									? "Preview — you can direct next month's support now."
									: ""}
						</p>
					</div>

					<div className="md:w-40 flex md:justify-end order-3">
						<Link to="/signup" className="btn btn-primary btn-sm">
							Adjust support
						</Link>
					</div>
				</div>

				{/* Where the month's support goes */}
				<div className="divider text-sm text-base-content/50 my-3">
					What your support for Anthers funds
					<InfoTip
						text={`What you give Anthers funds the Time Pool ($${timePoolFor(publicAccessPrice).toFixed(2)}, to creators by time) and Supports Anthers (the remainder, which funds free access and the charitable programs). The card fee is inside the price. Downloads are unlimited and cost nothing, and $${publicAccessPrice} a month lifts the ${FREE_PUBLIC_ACCESS_HOURS}-hour monthly limit on Public Access.`}
					/>
				</div>
				<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
					<div>
						<div className="text-xs text-base-content/50 uppercase">Time Pool</div>
						<div className="text-lg font-bold text-success">{fmt(badgeView.timePool)}</div>
						<div className="text-[11px] text-base-content/40">to creators, by time</div>
					</div>
					<div>
						<div className="text-xs text-base-content/50 uppercase">Supports Anthers</div>
						<div className="text-lg font-bold">{fmt(badgeView.supportsAnthers)}</div>
						<div className="text-[11px] text-base-content/40">free access &amp; programs</div>
					</div>
					{/*
					 * 🚨 Reads the amount, because this card is rendered for the $0 rung
					 * too and used to tell that user their streaming was "Unlimited" — the one
					 * person on the page for whom it is false. Public Access is capped monthly
					 * until the Public Access price to Anthers lifts it; downloads are unlimited either
					 * way, which is why the sub-label sits under both branches.
					 *
					 * 🚨 The comparison reads the SEEDED ladder — the price lifting the limit is a
					 * ladder claim, the same one every other surface quotes. The card is rendered
					 * for the $0 rung too and must not read as "unlimited" until the fetched
					 * value agrees.
					 */}
					<div>
						<div className="text-xs text-base-content/50 uppercase">Public Access</div>
						<div className="text-lg font-bold">
							{badgeView.price >= publicAccessPrice
								? "Unlimited"
								: `${FREE_PUBLIC_ACCESS_HOURS} hrs/mo`}
						</div>
						{/* econ:allow — this states the ABSENCE of the retired mechanism, which is the
						    one place naming it is correct. */}
						<div className="text-[11px] text-base-content/40">
							downloads always free — no allowance, no per-GiB charge
						</div>
					</div>
				</div>
			</div>

			{/* ── Time Pool + the Badges you hold ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="divider text-sm text-base-content/50 mt-0 mb-1">
					Creators You Back
					<InfoTip text="Two ways money reaches creators: the Time Pool (automatic, split by your time — video, audio, reading, and gameplay all count equally) and the Badges you hold from specific creators, at the rung each one names, with no platform cut — only the at-cost card processing comes out)." />
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
												to={profileUrl(row.handle)}
												className="text-base-content/70 truncate flex-1 link-hover"
											>
												{row.displayName || row.handle}
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

						{/* Directed support */}
						<div className="flex flex-col">
							<p className="text-xs text-base-content/40 uppercase tracking-wider mb-2 text-center">
								To creators
							</p>

							{/* Budget summary */}
							<div className="mb-3">
								<div className="flex items-center justify-between text-xs text-base-content/60 mb-1">
									<span>{fmt(badgeBudget)} total</span>
									<span>
										{fmt(allocatedBadges)} held · {fmt(remainingBudget)} left
									</span>
								</div>
								<div className="relative h-2 bg-base-300 rounded-full overflow-hidden">
									<div
										className="absolute inset-y-0 left-0 bg-success/80 rounded-full"
										style={{
											width: `${badgeBudget > 0 ? Math.min(100, (allocatedBadges / badgeBudget) * 100) : 0}%`,
										}}
									/>
								</div>
							</div>

							{badgeBudget <= 0 ? (
								<div className="text-sm text-base-content/50 text-center py-4">
									<p>You hold no Badges from creators this cycle.</p>
									<Link to="/signup" className="link link-primary text-sm">
										Upgrade to back creators
									</Link>
								</div>
							) : (
								<div className="space-y-2">
									{rows.map((row, i) => {
										const committed = row.committedBadge;
										// The ratchet: within the current cycle a holding never goes
										// down, so a lower rung is not offered. Next month's is free to
										// pick, and affordability is what the rung chips below say.
										const floor = viewMode === "current" ? committed : 0;
										const othersHeld =
											allocatedBadges - (row.pendingBadge ? Number(row.pendingBadge.threshold) : 0);
										const pickOptions = row.rungs.filter(
											(r) =>
												Number(r.threshold) >= floor &&
												Number(r.threshold) <= othersHeld + remainingBudget,
										);
										const pickedThreshold = row.pendingBadge
											? Number(row.pendingBadge.threshold)
											: null;
										const changed = pickedThreshold !== null && pickedThreshold !== committed;
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
														to={profileUrl(row.handle)}
														className="text-xs text-base-content/70 truncate flex-1 link-hover"
													>
														{row.displayName || row.handle}
													</Link>
													{canEdit && pickOptions.length > 0 ? (
														<select
															className="select select-bordered select-xs"
															value={pickedThreshold ?? ""}
															aria-label={`Badge held from ${row.displayName || row.handle}`}
															onChange={(e) =>
																handleBadgeChange(row.creatorId, Number(e.target.value))
															}
															disabled={!!actionLoading}
														>
															{/* A held rung can never be un-picked within the cycle
															    (the API refuses a decrease), so the placeholder is
															    disabled once there is a holding to keep. */}
															<option value="" disabled={committed > 0}>
																{committed > 0 ? fmt(committed) : "Choose a Badge"}
															</option>
															{pickOptions.map((rung) => (
																<option key={rung.id} value={Number(rung.threshold)}>
																	{rung.label} · {fmt(rung.threshold)}/mo
																</option>
															))}
														</select>
													) : (
														<span className="text-sm text-success tabular-nums">
															{fmt(row.settledBadge || committed)}
														</span>
													)}
													{changed && <span className="text-[9px] text-primary">(pending)</span>}
												</div>
												{row.rungs.length > 0 && (
													<div className="mt-1 pl-7 flex flex-wrap gap-1">
														{row.rungs.map((rung) => {
															const held = row.pendingBadge?.id === rung.id;
															return (
																<span
																	key={rung.id}
																	className={`badge badge-xs ${held ? "badge-success" : "badge-ghost"}`}
																	title={rung.description ?? undefined}
																>
																	{held ? "✓" : "○"} {rung.label} (${rung.threshold})
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
												className={`btn btn-primary btn-sm ${actionLoading === "badges" ? "btn-disabled" : ""}`}
												onClick={handleSaveBadges}
												disabled={!hasPendingPicks || !!actionLoading}
											>
												{actionLoading === "badges" ? "Holding…" : "Hold"}
											</button>
											<button
												type="button"
												className="btn btn-ghost btn-sm"
												onClick={() => setPendingPicks(new Map())}
												disabled={!hasPendingPicks}
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
							Your Time Pool is distributed by time — video, audio, text, and gameplay all count
							equally.
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
							<div className="text-xs text-base-content/50 uppercase">Badge income</div>
							<div className="text-xl font-bold text-success">{fmt(earnings.badgeTotal)}</div>
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
					{/* The transfer split — settled money still waiting out its hold, beside
							what has already moved into the connected account. */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
						<div>
							<div className="text-xs text-base-content/50 uppercase">Held</div>
							<div className="text-xl font-bold">{fmt(earnings.heldTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Transferred</div>
							<div className="text-xl font-bold">{fmt(earnings.transferredTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Recovered</div>
							<div className="text-xl font-bold">{fmt(earnings.nettedTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Still Recovering</div>
							<div className="text-xl font-bold">{fmt(earnings.nettingOpenTotal)}</div>
						</div>
					</div>
					{earnings.cycle && (
						<p className="text-xs text-base-content/50 mt-2">
							<EarningsBasis earnings={earnings} />
						</p>
					)}
				</div>
			)}

			{account.currentPeriodEnd && viewMode === "current" && (
				<p className="text-xs text-base-content/40 text-center">
					{isCanceling ? "Support ends" : "Next renewal"}:{" "}
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

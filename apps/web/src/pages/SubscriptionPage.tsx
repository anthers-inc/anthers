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
	USAGE_PER_GIB,
} from "@anthers/shared/constants";
import { client } from "@anthers/web-shared/rpc";
import type {
	Account,
	AttentionSummary,
	Badge,
	BoostAllocation,
	CreatorGate,
	PoolDistribution,
} from "@anthers/web-shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

/* ------------------------------------------------------------------ */
/*  Constants & V3 economics                                           */
/*                                                                     */
/*  Anthers keeps $0. A user holds an account with two independent,    */
/*  prepaid choices per cycle: a Usage level (GiB) and a total Boost   */
/*  ($). Usage is $0.03/GiB = bandwidth ($0.01, at cost) + Anthers     */
/*  Foundation fee ($0.005) + Time Pool ($0.015, to creators by watch- */
/*  time). Boost is whole dollars, 100% to creators. The user's        */
/*  Anthers Badge is derived from combined spend (usage + boost).      */
/* ------------------------------------------------------------------ */

/** Color used for pending (unsaved) changes across the UI. */
const PENDING_COLOR = "#C04475";

/** Usage slider bounds (GiB). Badge personas span 100–400 GiB; give headroom. */
const USAGE_SLIDER_MAX = 500;
const USAGE_SLIDER_STEP = 10;
/** Boost slider bounds ($, whole dollars). */
const BOOST_SLIDER_MAX = 30;

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * V3 usage/boost breakdown. Every field is a real destination of the user's
 * money — none of it is platform margin.
 */
function computeEconomics(usageGiB: number, boostTotal: number) {
	const timePool = round2(usageGiB * TIME_POOL_PER_GIB); // to creators, by watch-time
	const bandwidth = round2(usageGiB * BANDWIDTH_PER_GIB); // egress, at cost
	const foundation = round2(usageGiB * USAGE_AFF_PER_GIB); // Anthers Foundation fee
	const usageSpend = round2(usageGiB * USAGE_PER_GIB); // all-in usage price
	const boostPool = round2(boostTotal); // whole dollars, 100% to creators
	const subtotal = round2(usageSpend + boostPool); // combined spend = badge basis
	const toCreators = round2(timePool + boostPool); // Time Pool + Boost
	return { timePool, bandwidth, foundation, usageSpend, boostPool, subtotal, toCreators };
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
/*  BadgeBar — read-only combined-spend progress with badge marks      */
/* ------------------------------------------------------------------ */

const BADGE_MARKS = [
	{ id: "root", name: "Root", spend: BADGE_THRESHOLDS.root },
	{ id: "sprout", name: "Sprout", spend: BADGE_THRESHOLDS.sprout },
	{ id: "petal", name: "Petal", spend: BADGE_THRESHOLDS.petal },
	{ id: "blossom", name: "Blossom", spend: BADGE_THRESHOLDS.blossom },
] as const;

function BadgeBar({ spend, pending }: { spend: number; pending: boolean }) {
	const max = BADGE_THRESHOLDS.blossom;
	const pct = Math.min((spend / max) * 100, 100);
	return (
		<div>
			{/* Badge name marks */}
			<div className="relative w-full h-4 mb-1">
				{BADGE_MARKS.map((m) => {
					const pos = (m.spend / max) * 100;
					const active = spend >= m.spend;
					return (
						<span
							key={m.id}
							className={`absolute -translate-x-1/2 text-[10px] ${active ? "text-base-content font-semibold" : "text-base-content/50"}`}
							style={{ left: `${pos}%`, bottom: 0 }}
						>
							{m.name}
						</span>
					);
				})}
			</div>
			{/* Track */}
			<div className="relative h-2.5 bg-base-300 rounded-full overflow-hidden">
				<div
					className={`absolute inset-y-0 left-0 rounded-full ${pending ? "" : "bg-success/80"}`}
					style={{
						width: `${pct}%`,
						...(pending ? { backgroundColor: PENDING_COLOR } : {}),
					}}
				/>
				{BADGE_MARKS.map((m) => {
					const pos = (m.spend / max) * 100;
					return (
						<div
							key={m.id}
							className={`absolute top-0 bottom-0 w-px ${spend >= m.spend ? "bg-base-content" : "bg-base-content/40"}`}
							style={{ left: `${pos}%` }}
						/>
					);
				})}
			</div>
			{/* Dollar marks */}
			<div className="relative w-full h-4 mt-0.5">
				{BADGE_MARKS.map((m) => {
					const pos = (m.spend / max) * 100;
					return (
						<span
							key={m.id}
							className="absolute -translate-x-1/2 text-[9px] text-base-content/40"
							style={{ left: `${pos}%` }}
						>
							${m.spend}
						</span>
					);
				})}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  BoostBar — slider + gate hash marks in one column                  */
/* ------------------------------------------------------------------ */

function BoostBar({
	value,
	committedValue,
	boostPool,
	gates,
	onChange,
	disabled,
}: {
	value: number;
	/** The committed (saved) boost value — used to show pending fill. */
	committedValue: number;
	boostPool: number;
	gates: CreatorGate[];
	onChange: (v: number) => void;
	disabled: boolean;
}) {
	const [dragging, setDragging] = useState(false);
	const trackRef = useRef<HTMLDivElement>(null);

	const boostGates = gates.filter((g) => g.gateType === "boost");

	const highestGate =
		boostGates.length > 0 ? Math.max(...boostGates.map((g) => Number(g.threshold))) : boostPool;
	const sliderMax = Math.max(highestGate, 1);
	const barMax = sliderMax * 1.1;
	const committedPct = Math.min((committedValue / barMax) * 100, 100);
	const pendingPct = Math.min((value / barMax) * 100, 100);
	const thumbPct = pendingPct;
	const hasPending = value !== committedValue;

	const xToValue = useCallback(
		(clientX: number) => {
			const rect = trackRef.current?.getBoundingClientRect();
			if (!rect) return value;
			const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
			return Math.round(pct * barMax);
		},
		[barMax, value],
	);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (disabled) return;
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			setDragging(true);
			onChange(xToValue(e.clientX));
		},
		[disabled, onChange, xToValue],
	);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!dragging) return;
			onChange(xToValue(e.clientX));
		},
		[dragging, onChange, xToValue],
	);

	const handlePointerUp = useCallback(() => {
		setDragging(false);
	}, []);

	return (
		<div className={disabled ? "opacity-60" : ""}>
			{/* Gate name labels above the track */}
			{boostGates.length > 0 && (
				<div className="relative h-4 mb-0.5">
					{boostGates.map((gate) => {
						const pos = (Number(gate.threshold) / barMax) * 100;
						const unlocked = value >= Number(gate.threshold);
						return (
							<span
								key={`name-${gate.threshold}`}
								className={`absolute text-[9px] leading-tight -translate-x-1/2 ${
									unlocked ? "text-base-content font-semibold" : "text-base-content/50"
								}`}
								style={{ left: `${pos}%` }}
							>
								{gate.label}
							</span>
						);
					})}
				</div>
			)}

			{/* Interactive track */}
			<div>
				<div
					ref={trackRef}
					className={`relative h-5 select-none ${disabled ? "pointer-events-none" : "cursor-pointer"}`}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
				>
					<div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-2.5 bg-base-300 rounded-full overflow-hidden">
						{/* Committed fill (primary) */}
						<div
							className="absolute inset-y-0 left-0 bg-primary/80 rounded-full"
							style={{ width: `${committedPct}%` }}
						/>
						{/* Pending fill */}
						{hasPending && value > committedValue && (
							<div
								className="absolute inset-y-0 rounded-r-full"
								style={{
									left: `${committedPct}%`,
									width: `${pendingPct - committedPct}%`,
									backgroundColor: `${PENDING_COLOR}CC`,
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
										value >= Number(gate.threshold) ? "bg-base-content" : "bg-base-content/40"
									}`}
									style={{ left: `${pos}%` }}
								/>
							);
						})}
					</div>

					{/* Thumb */}
					<div
						className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 shadow-md pointer-events-none ${hasPending ? "" : "bg-primary border-primary"}`}
						style={{
							left: `${thumbPct}%`,
							...(hasPending ? { backgroundColor: PENDING_COLOR, borderColor: PENDING_COLOR } : {}),
						}}
					/>
				</div>
			</div>

			{/* Gate dollar labels below track */}
			{boostGates.length > 0 && (
				<div className="relative h-3 mt-0.5">
					{boostGates.map((gate) => {
						const pos = (Number(gate.threshold) / barMax) * 100;
						return (
							<span
								key={`label-${gate.threshold}`}
								className={`absolute text-[9px] leading-tight -translate-x-1/2 ${
									value >= Number(gate.threshold) ? "text-base-content" : "text-base-content/40"
								}`}
								style={{ left: `${pos}%` }}
							>
								${gate.threshold}
							</span>
						);
					})}
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
/*  Confirmation Dialog                                                */
/* ------------------------------------------------------------------ */

function ConfirmDialog({
	open,
	title,
	children,
	onConfirm,
	onCancel,
	confirmLabel,
	confirmClass,
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
						<button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
							Cancel
						</button>
						<button
							type="button"
							className={`btn btn-sm ${confirmClass ?? "btn-primary"}`}
							onClick={onConfirm}
						>
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
/*  Pie chart colors (per-creator, cycling)                            */
/* ------------------------------------------------------------------ */

const PIE_COLORS = [
	"#6d28d9", // violet
	"#2563eb", // blue
	"#0891b2", // cyan
	"#059669", // emerald
	"#d97706", // amber
	"#dc2626", // red
	"#c026d3", // fuchsia
	"#4f46e5", // indigo
];

/* ------------------------------------------------------------------ */
/*  TimePoolPie — SVG donut chart of time distribution                 */
/* ------------------------------------------------------------------ */

function TimePoolPie({
	rows,
	totalTime,
	focusedCreatorId,
	onHover,
	onLeave,
}: {
	rows: CreatorRow[];
	totalTime: number;
	focusedCreatorId: number | null;
	onHover: (creatorId: number) => void;
	onLeave: () => void;
}) {
	const size = 200;
	const cx = size / 2;
	const cy = size / 2;
	const radius = 75;
	const strokeWidth = 30;

	if (totalTime === 0 || rows.length === 0) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="text-sm text-base-content/30 text-center">
					<p>No time data yet</p>
				</div>
			</div>
		);
	}

	// Build arc paths for each slice (no overlapping circles)
	const arcPath = (startAngle: number, endAngle: number, r: number) => {
		const start = {
			x: cx + r * Math.cos(startAngle),
			y: cy + r * Math.sin(startAngle),
		};
		const end = {
			x: cx + r * Math.cos(endAngle),
			y: cy + r * Math.sin(endAngle),
		};
		const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
		return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
	};

	let angleOffset = -Math.PI / 2; // start at 12 o'clock
	const slices = rows.map((row, i) => {
		const pct = row.timeSeconds / totalTime;
		const sliceAngle = pct * 2 * Math.PI;
		// Clamp to avoid full-circle arc (which SVG can't draw as a single arc)
		const startAngle = angleOffset;
		const endAngle = angleOffset + Math.min(sliceAngle, 2 * Math.PI - 0.001);
		angleOffset += sliceAngle;

		const isFocused = focusedCreatorId === row.creatorId;
		const isDimmed = focusedCreatorId !== null && !isFocused;

		return (
			<path
				key={row.creatorId}
				d={arcPath(startAngle, endAngle, radius)}
				fill="none"
				stroke={PIE_COLORS[i % PIE_COLORS.length]}
				strokeWidth={strokeWidth}
				strokeLinecap="butt"
				opacity={isDimmed ? 0.4 : 1}
				className="transition-opacity duration-1000 cursor-pointer"
				onMouseEnter={() => onHover(row.creatorId)}
				onMouseLeave={onLeave}
			/>
		);
	});

	return (
		<div className="flex items-center justify-center">
			<svg role="img" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
				<title>Time distribution by creator</title>
				{slices}
				{/* Center label */}
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
/*  CreatorInfoCard — shows details about focused creator              */
/* ------------------------------------------------------------------ */

function CreatorInfoCard({
	row,
	colorIndex,
	totalTime,
	poolAmount,
	hoverSource,
}: {
	row: CreatorRow | null;
	colorIndex: number;
	totalTime: number;
	poolAmount: number;
	hoverSource: "pie" | "boost";
}) {
	if (!row) return null;

	const initials = (row.displayName || row.username)
		.split(/\s+/)
		.map((w) => w[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
	const timePct = totalTime > 0 ? (row.timeSeconds / totalTime) * 100 : 0;
	const boostGates = row.gates.filter((g) => g.gateType === "boost");

	return (
		<div className="card bg-base-300/50 h-full">
			<div className="card-body p-4 flex flex-col">
				{/* Creator identity (always shown) */}
				<div className="flex items-center gap-3 mb-3">
					{row.avatar ? (
						<img
							src={row.avatar}
							alt=""
							className="w-10 h-10 rounded-full object-cover flex-shrink-0"
						/>
					) : (
						<div
							className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
							style={{ backgroundColor: PIE_COLORS[colorIndex % PIE_COLORS.length] }}
						>
							{initials}
						</div>
					)}
					<div className="min-w-0">
						<Link
							to={`/${row.username}`}
							className="font-semibold text-sm link link-hover block truncate"
						>
							{row.displayName || row.username}
						</Link>
						<span className="text-xs text-base-content/50">@{row.username}</span>
					</div>
				</div>

				<div className="divider my-1" />

				{/* Time Pool section — highlighted when source is pie */}
				<div
					className={`transition-opacity duration-1000 ${hoverSource === "pie" ? "opacity-100" : "opacity-50"}`}
				>
					<p className="text-[10px] text-base-content/40 uppercase tracking-wider mb-1">
						Time Pool
					</p>
					<div className="space-y-1 text-sm">
						<div className="flex justify-between">
							<span className="text-base-content/60">Time</span>
							<span className="font-medium">{formatHours(row.timeSeconds)}</span>
						</div>
						<div className="flex justify-between">
							<span className="text-base-content/60">Share</span>
							<span className="font-medium">{Math.round(timePct)}%</span>
						</div>
						<div className="flex justify-between">
							<span className="text-base-content/60">Pool amount</span>
							<span className="font-medium text-success">{fmt(poolAmount)}</span>
						</div>
					</div>
				</div>

				<div className="divider my-1" />

				{/* Boost section — highlighted when source is boost */}
				<div
					className={`transition-opacity duration-1000 ${hoverSource === "boost" ? "opacity-100" : "opacity-50"}`}
				>
					<p className="text-[10px] text-base-content/40 uppercase tracking-wider mb-1">Boost</p>
					<div className="space-y-1 text-sm">
						<div className="flex justify-between">
							<span className="text-base-content/60">Current boost</span>
							<span className="font-medium text-primary">${row.pendingBoost}.00</span>
						</div>
						{boostGates.length > 0 && (
							<div className="mt-1 space-y-1.5">
								{boostGates.map((gate) => {
									const unlocked = row.pendingBoost >= Number(gate.threshold);
									return (
										<div key={gate.id} className="flex items-start gap-2">
											<span
												className={`text-xs mt-0.5 ${unlocked ? "text-primary" : "text-base-content/30"}`}
											>
												{unlocked ? "✓" : "○"}
											</span>
											<div className="flex-1 min-w-0">
												<div className="flex justify-between">
													<span className={`text-xs font-medium ${unlocked ? "text-primary" : ""}`}>
														{gate.label}
													</span>
													<span className="text-xs text-base-content/40">${gate.threshold}</span>
												</div>
												{gate.description && (
													<p className="text-[10px] text-base-content/40 leading-snug">
														{gate.description}
													</p>
												)}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function SubscriptionPage() {
	const [searchParams] = useSearchParams();
	const [account, setAccount] = useState<Account | null>(null);
	const [badge, setBadge] = useState<Badge>("none");
	const [badgeSpend, setBadgeSpend] = useState(0);
	const [attention, setAttention] = useState<AttentionSummary | null>(null);
	const [distributions, setDistributions] = useState<PoolDistribution[]>([]);
	const [committedBoosts, setCommittedBoosts] = useState<BoostAllocation[]>([]);
	const [creatorGatesMap, setCreatorGatesMap] = useState<Map<string, CreatorGate[]>>(new Map());
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());

	// ── Pending changes (local, not saved) ──
	const [pendingUsageGiB, setPendingUsageGiB] = useState<number | null>(null);
	const [pendingBoostTotal, setPendingBoostTotal] = useState<number | null>(null);
	const [pendingBoosts, setPendingBoosts] = useState<Map<number, number>>(new Map());
	const [showConfirm, setShowConfirm] = useState(false);
	const [showRevertConfirm, setShowRevertConfirm] = useState(false);
	const [focusedCreatorId, setFocusedCreatorId] = useState<number | null>(null);
	const [hoverSource, setHoverSource] = useState<"pie" | "boost">("pie");
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Debounced focus change — waits before switching creator. */
	const debouncedFocus = useCallback((creatorId: number, source: "pie" | "boost") => {
		if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		hoverTimerRef.current = setTimeout(() => {
			setFocusedCreatorId(creatorId);
			setHoverSource(source);
		}, 250);
	}, []);

	const cancelDebouncedFocus = useCallback(() => {
		if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
	}, []);

	// Cleanup timer on unmount
	useEffect(
		() => () => {
			if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		},
		[],
	);

	const sessionId = searchParams.get("session_id");
	const viewMode = viewModeFor(selectedCycle);

	// ── Data fetching ──

	const fetchAccount = useCallback(async () => {
		try {
			const res = await client.api.subscriptions.me.$get();
			const data = (await res.json()) as {
				account: Account;
				badge: Badge;
				badgeSpend: number;
			};
			setAccount(data.account);
			setBadge(data.badge);
			setBadgeSpend(data.badgeSpend);
		} catch {
			setError("Failed to load your account.");
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
			const usernames = data.distributions
				.map((d) => d.creator?.username)
				.filter(Boolean) as string[];
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
				boosts: BoostAllocation[];
				budget: string;
				allocated: string;
				remaining: string;
			};
			setCommittedBoosts(data.boosts);
		}
		// Clear pending state when switching months
		setPendingUsageGiB(null);
		setPendingBoostTotal(null);
		setPendingBoosts(new Map());
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

	// ── Derived values ──

	const committedUsageGiB = account?.usageGiB ?? 0;
	const committedBoostTotal = Number(account?.boostTotal ?? 0);
	const effectiveUsageGiB = pendingUsageGiB ?? committedUsageGiB;
	const effectiveBoostTotal = pendingBoostTotal ?? committedBoostTotal;

	const financials = useMemo(
		() => computeEconomics(effectiveUsageGiB, effectiveBoostTotal),
		[effectiveUsageGiB, effectiveBoostTotal],
	);
	const committed = useMemo(
		() => computeEconomics(committedUsageGiB, committedBoostTotal),
		[committedUsageGiB, committedBoostTotal],
	);

	const committedSpend = committed.subtotal;
	const effectiveSpend = financials.subtotal;
	const effectiveBadge = badgeForSpend(effectiveSpend);
	const isPaid = committedSpend >= BADGE_THRESHOLDS.root; // has cleared the Root floor
	const isCanceling = account ? !!account.canceledAt : false;

	const usageChanged = pendingUsageGiB !== null && pendingUsageGiB !== committedUsageGiB;
	const boostTotalChanged = pendingBoostTotal !== null && pendingBoostTotal !== committedBoostTotal;
	const hasPendingLevels = usageChanged || boostTotalChanged;

	// Committed boost map
	const committedBoostMap = useMemo(() => {
		const map = new Map<number, number>();
		for (const b of committedBoosts) map.set(b.creatorId, Math.round(parseFloat(b.amount)));
		return map;
	}, [committedBoosts]);

	// Build rows with pending boost values
	const rows: CreatorRow[] = useMemo(() => {
		return distributions.map((d) => {
			const committedBoost =
				committedBoostMap.get(d.creatorId) ?? Math.round(parseFloat(d.boostAmount));
			const pending = pendingBoosts.get(d.creatorId) ?? committedBoost;
			return {
				creatorId: d.creatorId,
				username: d.creator?.username ?? "",
				displayName: d.creator?.displayName ?? null,
				avatar: d.creator?.avatar ?? null,
				timeSeconds: d.attentionSeconds ?? 0,
				poolAmount: parseFloat(d.poolAmount),
				committedBoost,
				pendingBoost: pending,
				gates: creatorGatesMap.get(d.creator?.username ?? "") ?? [],
			};
		});
	}, [distributions, committedBoostMap, pendingBoosts, creatorGatesMap]);

	const totalTime = rows.reduce((s, r) => s + r.timeSeconds, 0);
	const totalPool = rows.reduce((s, r) => s + r.poolAmount, 0);
	const totalPendingBoost = rows.reduce((s, r) => s + r.pendingBoost, 0);
	const allocatedBoost = totalPendingBoost;
	// Unallocated (undirected) boost flows to creators by watch-time, like the Time Pool.
	const unallocatedBoost = Math.max(0, financials.boostPool - allocatedBoost);

	// Default focus to top creator (most time) when rows load
	useEffect(() => {
		if (rows.length > 0 && focusedCreatorId === null) {
			const top = [...rows].sort((a, b) => b.timeSeconds - a.timeSeconds)[0];
			if (top) setFocusedCreatorId(top.creatorId);
		}
	}, [rows, focusedCreatorId]);

	// Detect if there are any pending changes
	const hasPendingChanges = useMemo(() => {
		if (hasPendingLevels) return true;
		for (const [cid, val] of pendingBoosts) {
			const committedVal = committedBoostMap.get(cid) ?? 0;
			if (val !== committedVal) return true;
		}
		return false;
	}, [hasPendingLevels, pendingBoosts, committedBoostMap]);

	// ── Pending change handlers ──

	const handleUsageChange = (newGiB: number) => {
		if (viewMode === "current" && newGiB < committedUsageGiB) return; // increase only
		setPendingUsageGiB(newGiB === committedUsageGiB ? null : newGiB);
	};

	const handleBoostTotalChange = (newTotal: number) => {
		if (viewMode === "current" && newTotal < committedBoostTotal) return; // increase only
		setPendingBoostTotal(newTotal === committedBoostTotal ? null : newTotal);

		// If the boost budget shrank, trim per-creator allocations to fit.
		const currentBoosts = rows.map((r) => ({
			creatorId: r.creatorId,
			amount: pendingBoosts.get(r.creatorId) ?? r.committedBoost,
		}));
		const totalAllocated = currentBoosts.reduce((s, b) => s + b.amount, 0);

		if (totalAllocated > newTotal) {
			// Trim from smallest boosts first
			const sorted = [...currentBoosts].sort((a, b) => a.amount - b.amount);
			let excess = totalAllocated - newTotal;
			const newBoostMap = new Map(pendingBoosts);

			for (const entry of sorted) {
				if (excess <= 0) break;
				const committedVal = committedBoostMap.get(entry.creatorId) ?? 0;
				// In current month, can't go below the committed allocation.
				const floor = viewMode === "current" ? committedVal : 0;
				const reducible = entry.amount - floor;
				const reduction = Math.min(reducible, excess);
				if (reduction > 0) {
					const newAmount = entry.amount - reduction;
					if (newAmount === committedVal) {
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
		const committedVal = committedBoostMap.get(creatorId) ?? 0;
		if (viewMode === "current" && newVal < committedVal) return; // increase only

		// Cap at available budget (total boost minus other allocations)
		const otherBoosts =
			Array.from(pendingBoosts.entries())
				.filter(([cid]) => cid !== creatorId)
				.reduce((s, [, v]) => s + v, 0) +
			rows
				.filter((r) => r.creatorId !== creatorId && !pendingBoosts.has(r.creatorId))
				.reduce((s, r) => s + r.committedBoost, 0);
		const available = Math.max(0, financials.boostPool - otherBoosts);
		const clamped = Math.min(newVal, available);

		setPendingBoosts((prev) => {
			const next = new Map(prev);
			if (clamped === committedVal) next.delete(creatorId);
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
			// Persist Usage / Boost level changes first (raises the budget before allocations).
			// TODO: In production this charges the prepaid delta (usage + boost) via Stripe.
			if (hasPendingLevels) {
				const res = await client.api.subscriptions.account.$post({
					json: {
						usageGiB: effectiveUsageGiB,
						boostTotal: effectiveBoostTotal,
					},
				});
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					setError(data.error ?? "Failed to update your account levels.");
					setActionLoading(null);
					return;
				}
			}

			// Save per-creator boost allocations.
			for (const [creatorId, amount] of pendingBoosts) {
				const res = await client.api.subscriptions.boosts.$post({
					json: { creatorId, amount: amount.toFixed(2), cycle: selectedCycle },
				});
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					setError(data.error ?? "Failed to save boost.");
					break;
				}

				// Current month changes auto-propagate to next month.
				if (viewMode === "current") {
					const nextCycle = offsetCycle(getCurrentCycle(), 1);
					await client.api.subscriptions.boosts.$post({
						json: { creatorId, amount: amount.toFixed(2), cycle: nextCycle },
					});
				}
			}

			setSuccess("Changes saved.");
			setPendingUsageGiB(null);
			setPendingBoostTotal(null);
			setPendingBoosts(new Map());
			await fetchAccount();
			await fetchCycleData(selectedCycle);
		} catch {
			setError("Failed to save changes.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleRevert = () => {
		setShowRevertConfirm(false);
		setPendingUsageGiB(null);
		setPendingBoostTotal(null);
		setPendingBoosts(new Map());
		// Reload committed data
		fetchCycleData(selectedCycle);
	};

	// ── Account actions ──

	const handleCancel = async () => {
		setActionLoading("cancel");
		setError(null);
		try {
			const res = await client.api.subscriptions.cancel.$post();
			setAccount(((await res.json()) as { account: Account }).account);
			setSuccess("Your prepaid renewal will stop at the end of the current billing period.");
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
			setAccount(((await res.json()) as { account: Account }).account);
			setSuccess("Renewal resumed.");
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

	if (!account)
		return (
			<div className="max-w-2xl mx-auto px-4 py-8 text-center">
				<h1 className="text-2xl font-bold mb-4">Account unavailable</h1>
				<p className="mb-4">{error ?? "We couldn't load your account. Please try again."}</p>
				<Link to="/subscribe" className="btn btn-primary">
					Explore Usage & Boost
				</Link>
			</div>
		);

	/* ---- Free user view (below the Root badge floor) ---- */
	if (!isPaid)
		return (
			<div className="max-w-2xl mx-auto px-4 py-8">
				<div className="flex items-baseline justify-between mb-6">
					<h1 className="text-2xl font-bold">Your Anthers</h1>
					<span className="text-sm text-base-content/60">Free · no badge yet</span>
				</div>
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
				<div className="card bg-base-200">
					<div className="card-body">
						<div className="flex items-center justify-between">
							<div>
								<h2 className="card-title">Free</h2>
								<div className="badge badge-success badge-sm mt-1">Active</div>
							</div>
							<Link to="/subscribe" className="btn btn-primary btn-sm">
								Add Usage or Boost
							</Link>
						</div>
						<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />
						{attention && (
							<div className="mt-4">
								<div className="flex items-center justify-between text-sm mb-1">
									<span className="text-base-content/60">Time with Creators</span>
									<span className="font-medium">{attention.hoursUsed} hrs</span>
								</div>
								<p className="text-xs text-base-content/40">
									All media types count equally — a minute of video, audio, reading, or gameplay is
									the same when funding your creators.
								</p>
							</div>
						)}
						<div className="mt-4">
							<p className="text-xs text-base-content/50 uppercase tracking-wider mb-2">
								Progress to your first badge
							</p>
							<BadgeBar spend={effectiveSpend} pending={false} />
							<p className="text-xs text-base-content/40 mt-3">
								Spend {fmt(BADGE_THRESHOLDS.root)}+ combined (Usage + Boost) to earn your first
								Anthers Badge (Root).
							</p>
						</div>
						<div className="mt-4 text-sm text-base-content/60">
							Your first {FREE_USAGE_GIB} GiB of usage each month is free, subsidized by the Anthers
							Foundation.
						</div>
					</div>
				</div>
			</div>
		);

	/* ──────────────────────────────────────────────────────────────────── */
	/*  Paid user view                                                     */
	/* ──────────────────────────────────────────────────────────────────── */

	const canEdit = viewMode === "current" || viewMode === "next";

	// Colors for the cost breakdown dots
	const DOT_COLORS = {
		timePool: "#2563eb",
		boost: "#c026d3",
		bandwidth: "#db2777",
		foundation: "#0f766e",
		salesTax: "#737373",
		cardFee: "#d97706",
	};

	// Card + tax are added on top of the (usage + boost) subtotal; both leave the system.
	const subtotalForFees = financials.subtotal;
	const salesTax = round2(subtotalForFees * SALES_TAX_RATE);
	const cardFee = round2(subtotalForFees * CARD_RATE + CARD_FLAT);
	const totalWithFees = round2(subtotalForFees + salesTax + cardFee);

	return (
		<div className="mx-auto px-4 py-8" style={{ maxWidth: "110rem" }}>
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

			{/* Banners */}
			{viewMode === "next" && (
				<div className="alert alert-info text-sm mb-4">
					<span>
						Preview for {cycleLabel(selectedCycle)}. You can increase or decrease your levels and
						boosts freely.
					</span>
				</div>
			)}
			{viewMode === "past" && (
				<div className="alert text-sm bg-base-200 mb-4">
					<span>Historical view — read-only summary for {cycleLabel(selectedCycle)}.</span>
				</div>
			)}

			{/* ── Main panel ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 overflow-x-auto space-y-6">
				{/* Panel header with action buttons in corners */}
				<div className="flex items-start justify-between">
					{/* Left: account management */}
					{viewMode === "current" ? (
						<div className="flex flex-col gap-2 flex-shrink-0">
							<button
								type="button"
								className={`btn btn-sm ${actionLoading === "portal" ? "btn-disabled" : "btn-neutral"}`}
								onClick={handleBillingPortal}
								disabled={!!actionLoading}
							>
								{actionLoading === "portal" ? "Opening..." : "Manage Billing"}
							</button>
							{isCanceling ? (
								<button
									type="button"
									className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`}
									onClick={handleResume}
									disabled={!!actionLoading}
								>
									{actionLoading === "resume" ? "Resuming..." : "Resume Renewal"}
								</button>
							) : (
								<button
									type="button"
									className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
									onClick={handleCancel}
									disabled={!!actionLoading}
								>
									{actionLoading === "cancel" ? "Canceling..." : "Cancel Renewal"}
								</button>
							)}
						</div>
					) : (
						<div className="w-36 flex-shrink-0" />
					)}

					{/* Center: title + badge + month selector */}
					<div className="text-center flex-1">
						<h2 className="text-2xl font-bold mb-1">Your Anthers — {cycleLabel(selectedCycle)}</h2>
						<p className="text-sm text-base-content/60 mb-1">
							<strong style={hasPendingLevels ? { color: PENDING_COLOR } : undefined}>
								{badgeLabel(effectiveBadge)}
							</strong>{" "}
							badge
							<span className="text-base-content/40"> · {fmt(effectiveSpend)} combined spend</span>
							{hasPendingLevels && (
								<span className="ml-1" style={{ color: PENDING_COLOR }}>
									(pending change)
								</span>
							)}
						</p>
						<p className="text-xs text-base-content/40 mb-3">
							Rolling standing: {badgeLabel(badge)} · {fmt(badgeSpend)}
							<InfoTip text="Your canonical badge is the highest threshold you've cleared in any of the trailing 3 months — a good month keeps its perks for a while rather than evaporating instantly." />
						</p>
						<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />
					</div>

					{/* Right: save/discard */}
					{canEdit ? (
						<div className="flex flex-col gap-2 items-end flex-shrink-0">
							<button
								type="button"
								className={`btn btn-primary btn-sm ${actionLoading === "save" ? "btn-disabled" : ""}`}
								onClick={() => setShowConfirm(true)}
								disabled={!hasPendingChanges || !!actionLoading}
							>
								{actionLoading === "save" ? "Saving..." : "Save Changes"}
							</button>
							<button
								type="button"
								className="btn btn-outline btn-warning btn-sm"
								disabled={!hasPendingChanges}
								onClick={() => {
									setPendingUsageGiB(null);
									setPendingBoostTotal(null);
									setPendingBoosts(new Map());
								}}
							>
								Discard Changes
							</button>
							{viewMode === "next" && (
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => setShowRevertConfirm(true)}
								>
									Revert to Current Month
								</button>
							)}
						</div>
					) : (
						<div className="w-36 flex-shrink-0" />
					)}
				</div>

				{/* ── ACCOUNT LEVELS (Usage + Boost) ── */}
				{canEdit && (
					<div>
						<div className="divider text-sm text-base-content/50 my-2">
							Account Levels
							<InfoTip text="Two independent, prepaid choices: Usage (open, YouTube-style bandwidth, bought per GiB) and Boost (per-creator, Patreon-style support in whole dollars — 100% to creators). Your Anthers Badge is derived from the combined spend." />
						</div>

						{/* Badge progress (combined spend) */}
						<div className="mb-5">
							<BadgeBar spend={effectiveSpend} pending={hasPendingLevels} />
						</div>

						{/* Usage slider */}
						<div className="mb-4">
							<div className="flex items-baseline justify-between mb-1">
								<span className="text-sm text-base-content/70">
									Usage
									<InfoTip text="Open, YouTube-style bandwidth. $0.03/GiB = bandwidth ($0.01, at cost) + Anthers Foundation ($0.005) + Time Pool ($0.015, to creators by watch-time). Your first 3 GiB each month are free." />
								</span>
								<span className="text-sm">
									<strong style={usageChanged ? { color: PENDING_COLOR } : undefined}>
										{effectiveUsageGiB} GiB
									</strong>
									<span className="text-base-content/40 ml-1">
										· {fmt(financials.usageSpend)} · +{FREE_USAGE_GIB} GiB free
									</span>
								</span>
							</div>
							<input
								type="range"
								min={0}
								max={USAGE_SLIDER_MAX}
								step={USAGE_SLIDER_STEP}
								value={effectiveUsageGiB}
								onChange={(e) => handleUsageChange(Number(e.target.value))}
								className="range range-sm range-success"
							/>
						</div>

						{/* Boost slider */}
						<div>
							<div className="flex items-baseline justify-between mb-1">
								<span className="text-sm text-base-content/70">
									Boost
									<InfoTip text="Per-creator, Patreon-style support in whole dollars — 100% goes to creators, no Foundation fee. Allocate it to specific creators below; unallocated boost flows to creators by your watch-time." />
								</span>
								<span className="text-sm">
									<strong style={boostTotalChanged ? { color: PENDING_COLOR } : undefined}>
										{fmt(effectiveBoostTotal)}
									</strong>
									<span className="text-base-content/40 ml-1">· 100% to creators</span>
								</span>
							</div>
							<input
								type="range"
								min={0}
								max={BOOST_SLIDER_MAX}
								step={1}
								value={effectiveBoostTotal}
								onChange={(e) => handleBoostTotalChange(Number(e.target.value))}
								className="range range-sm range-primary"
							/>
						</div>

						{Number(account.redownloadBalance) > 0 && (
							<div className="mt-3 text-xs text-base-content/40">
								Re-download balance: {fmt(Number(account.redownloadBalance))}
								<InfoTip text="A small prepaid balance for re-downloading purchases. Kept separate from streaming Usage so a big download never distorts Time-Pool distribution." />
							</div>
						)}
					</div>
				)}

				{/* ── CREATOR ALLOCATIONS ── */}
				<div>
					<div className="divider text-sm text-base-content/50 my-2">
						Creator Allocations
						<InfoTip text="Money reaches creators two ways: the Time Pool (automatic, from your Usage, distributed by watch-time) and Boost (manual, whole dollars you direct to specific creators). Boost determines which gated content you can access. Unallocated boost flows to creators by watch-time." />
					</div>
					{rows.length > 0 ? (
						<div className="grid grid-cols-3 divide-x divide-base-content/10">
							{/* ── Left: Time Pool pie chart ── */}
							<div className="flex flex-col pr-4">
								<p className="text-xs text-base-content/40 uppercase tracking-wider mb-2 text-center">
									Time Pool
								</p>
								<TimePoolPie
									rows={rows}
									totalTime={totalTime}
									focusedCreatorId={focusedCreatorId}
									onHover={(id) => debouncedFocus(id, "pie")}
									onLeave={cancelDebouncedFocus}
								/>
								{/* Legend */}
								<div className="mt-3 space-y-1">
									{rows.map((row, i) => {
										const pct = totalTime > 0 ? Math.round((row.timeSeconds / totalTime) * 100) : 0;
										const pendingTimePoolTotal = financials.timePool + unallocatedBoost;
										const displayPool =
											hasPendingLevels && totalTime > 0
												? round2(pendingTimePoolTotal * (row.timeSeconds / totalTime))
												: row.poolAmount;
										return (
											<div
												key={row.creatorId}
												className={`flex items-center gap-2 text-xs cursor-pointer rounded px-1 py-0.5 transition-colors duration-1000 ${
													focusedCreatorId === row.creatorId ? "bg-base-content/5" : ""
												}`}
												onMouseEnter={() => debouncedFocus(row.creatorId, "pie")}
												onMouseLeave={cancelDebouncedFocus}
											>
												<div
													className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
													style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
												/>
												<span className="text-base-content/70 truncate flex-1">
													{row.displayName || row.username}
												</span>
												<span className="text-base-content/40 tabular-nums">{pct}%</span>
												<span
													className={`tabular-nums ${hasPendingLevels ? "" : "text-success"}`}
													style={hasPendingLevels ? { color: PENDING_COLOR } : undefined}
												>
													{fmt(displayPool)}
												</span>
											</div>
										);
									})}
								</div>
							</div>

							{/* ── Center: Creator info card ── */}
							<div className="flex flex-col px-4">
								<p className="text-xs text-base-content/40 uppercase tracking-wider mb-2 text-center">
									Creator Details
								</p>
								{(() => {
									const focusedRow = rows.find((r) => r.creatorId === focusedCreatorId) ?? null;
									const colorIdx = focusedRow ? rows.indexOf(focusedRow) : 0;
									const pendingTimePoolTotal = financials.timePool + unallocatedBoost;
									const focusedPool =
										focusedRow && totalTime > 0
											? hasPendingLevels
												? round2(pendingTimePoolTotal * (focusedRow.timeSeconds / totalTime))
												: focusedRow.poolAmount
											: 0;
									return (
										<CreatorInfoCard
											row={focusedRow}
											colorIndex={colorIdx}
											totalTime={totalTime}
											poolAmount={focusedPool}
											hoverSource={hoverSource}
										/>
									);
								})()}
							</div>

							{/* ── Right: Boost table ── */}
							<div className="flex flex-col pl-4">
								<p className="text-xs text-base-content/40 uppercase tracking-wider mb-2 text-center">
									Boost Allocations
								</p>
								<div className="space-y-2">
									{rows.map((row, i) => {
										const initials = (row.displayName || row.username)
											.split(/\s+/)
											.map((w) => w[0])
											.join("")
											.slice(0, 2)
											.toUpperCase();
										const boostChanged = row.pendingBoost !== row.committedBoost;
										const isFocused = focusedCreatorId === row.creatorId;

										return (
											<div
												key={row.creatorId}
												className={`rounded-lg p-2 transition-colors duration-1000 ${isFocused ? "bg-base-content/5" : ""}`}
												onMouseEnter={() => debouncedFocus(row.creatorId, "boost")}
												onMouseLeave={cancelDebouncedFocus}
											>
												{/* Creator name */}
												<div className="flex items-center gap-1.5 mb-1">
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
															initials
														)}
													</div>
													<span className="text-xs text-base-content/70 truncate">
														{row.displayName || row.username}
													</span>
													<span className="text-xs text-primary font-medium ml-auto tabular-nums">
														${row.pendingBoost}.00
													</span>
													{boostChanged && (
														<span className="text-[9px]" style={{ color: PENDING_COLOR }}>
															(pending)
														</span>
													)}
												</div>
												{/* Boost slider */}
												{canEdit ? (
													<BoostBar
														value={row.pendingBoost}
														committedValue={row.committedBoost}
														boostPool={financials.boostPool}
														gates={row.gates}
														onChange={(v) => handleBoostChange(row.creatorId, v)}
														disabled={
															viewMode === "current" && unallocatedBoost <= 0 && !hasPendingChanges
														}
													/>
												) : (
													<div className="text-sm text-primary">${row.pendingBoost}.00</div>
												)}
											</div>
										);
									})}
								</div>
							</div>
						</div>
					) : (
						<div className="py-6 text-center text-sm text-base-content/40">
							{viewMode === "next" ? (
								<p>Next month's distributions will be calculated from your time with creators.</p>
							) : (
								<>
									<p>No distributions yet this cycle.</p>
									<p className="mt-1">
										Your Time Pool is distributed by watch-time — video, audio, text, and gameplay
										all count equally.
									</p>
								</>
							)}
						</div>
					)}
				</div>

				{/* ── COST BREAKDOWN ── */}
				<div className="divider text-sm text-base-content/50 my-2">Cost Breakdown</div>
				<div className="flex justify-center mb-4">
					<div className="text-sm w-full max-w-lg">
						{/* Spend header (badge basis) */}
						<div className="flex items-center justify-between py-2 border-b border-base-content/10">
							<span className="text-base-content/60">Usage + Boost</span>
							<div className="flex items-baseline gap-1">
								<span
									className="text-xl font-bold"
									style={hasPendingLevels ? { color: PENDING_COLOR } : undefined}
								>
									{fmt(effectiveSpend)}
								</span>
								<span className="text-base-content/40 text-xs">/mo</span>
							</div>
						</div>

						{/* Line items */}
						<div className="py-2 space-y-1.5">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div
										className="w-2.5 h-2.5 rounded-sm"
										style={{ backgroundColor: DOT_COLORS.timePool }}
									/>
									<span className="text-base-content/70">
										Time Pool
										{unallocatedBoost > 0 && (
											<span className="text-base-content/40 text-xs ml-1">
												(incl. {fmt(unallocatedBoost)} unallocated boost)
											</span>
										)}
									</span>
								</div>
								<div className="flex items-center gap-1">
									<strong className="text-success">
										{fmt((totalPool > 0 ? totalPool : financials.timePool) + unallocatedBoost)}
									</strong>
									<InfoTip text="To creators, distributed by the watch-time you spend with their content. A minute of video, audio, reading, or gameplay all count equally. Funded per-GiB of Usage." />
								</div>
							</div>
							{financials.boostPool > 0 && (
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<div
											className="w-2.5 h-2.5 rounded-sm"
											style={{ backgroundColor: DOT_COLORS.boost }}
										/>
										<span className="text-base-content/70">Boost</span>
									</div>
									<div className="flex items-center gap-1">
										<strong className="text-primary">{fmt(allocatedBoost)}</strong>
										<InfoTip text="Whole dollars you direct to specific creators — 100% to creators, no Foundation fee. Determines which gated content you can access." />
									</div>
								</div>
							)}
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div
										className="w-2.5 h-2.5 rounded-sm"
										style={{ backgroundColor: DOT_COLORS.bandwidth }}
									/>
									<span className="text-base-content/70">Bandwidth (at cost)</span>
								</div>
								<div className="flex items-center gap-1">
									<strong>{fmt(financials.bandwidth)}</strong>
									<InfoTip text="The DigitalOcean egress cost of the Usage you buy ($0.01/GiB) — a pass-through, at cost. None of it is platform profit." />
								</div>
							</div>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div
										className="w-2.5 h-2.5 rounded-sm"
										style={{ backgroundColor: DOT_COLORS.foundation }}
									/>
									<span className="text-base-content/70">Anthers Foundation</span>
								</div>
								<div className="flex items-center gap-1">
									<strong>{fmt(financials.foundation)}</strong>
									<InfoTip text="The Anthers Foundation charity fee — 50% of your bandwidth cost ($0.005/GiB). Funds free access, charitable programs, and operations." />
								</div>
							</div>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div
										className="w-2.5 h-2.5 rounded-sm"
										style={{ backgroundColor: DOT_COLORS.salesTax }}
									/>
									<span className="text-base-content/70">Est. sales tax</span>
								</div>
								<strong>{fmt(salesTax)}</strong>
							</div>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div
										className="w-2.5 h-2.5 rounded-sm"
										style={{ backgroundColor: DOT_COLORS.cardFee }}
									/>
									<span className="text-base-content/70">Card fee</span>
								</div>
								<strong>{fmt(cardFee)}</strong>
							</div>
						</div>

						{/* To creators emphasis */}
						<div className="flex items-center justify-between py-1 border-t border-base-content/10">
							<span className="text-base-content/70 font-medium">To creators</span>
							<strong className="text-success">{fmt(financials.toCreators)}</strong>
						</div>
						<p className="text-[10px] text-base-content/40 mb-1">
							Anthers keeps $0 — every dollar is bandwidth (at cost), money to creators, the Anthers
							Foundation fee, or card + tax.
						</p>

						{/* Total */}
						<div className="flex items-center justify-between pt-2 border-t border-base-content/20">
							<span className="font-bold">Total (all-in)</span>
							<div className="flex items-baseline gap-1">
								<span
									className="text-xl font-bold"
									style={hasPendingLevels ? { color: PENDING_COLOR } : undefined}
								>
									{fmt(totalWithFees)}
								</span>
								<span className="text-base-content/40 text-xs">/mo</span>
							</div>
						</div>

						{account.currentPeriodEnd && viewMode === "current" && (
							<p className="text-xs text-base-content/40 mt-1">
								Next charge:{" "}
								{new Date(account.currentPeriodEnd).toLocaleDateString("en-US", {
									month: "long",
									day: "numeric",
									year: "numeric",
								})}
							</p>
						)}
					</div>
				</div>
			</div>
			{/* end main panel */}

			{/* ── Confirmation dialogs ── */}
			<ConfirmDialog
				open={showConfirm}
				title="Save Changes"
				onConfirm={handleSave}
				onCancel={() => setShowConfirm(false)}
				confirmLabel="Confirm & Save"
			>
				{usageChanged && (
					<div className="flex justify-between py-1">
						<span>Usage</span>
						<span>
							{committedUsageGiB} GiB &rarr; <strong>{effectiveUsageGiB} GiB</strong>
						</span>
					</div>
				)}
				{boostTotalChanged && (
					<div className="flex justify-between py-1">
						<span>Total boost</span>
						<span>
							{fmt(committedBoostTotal)} &rarr; <strong>{fmt(effectiveBoostTotal)}</strong>
						</span>
					</div>
				)}
				{Array.from(pendingBoosts.entries()).map(([cid, amount]) => {
					const row = rows.find((r) => r.creatorId === cid);
					const committedVal = committedBoostMap.get(cid) ?? 0;
					if (amount === committedVal) return null;
					return (
						<div key={cid} className="flex justify-between py-1">
							<span>Boost to @{row?.displayName || row?.username}</span>
							<span>
								${committedVal} &rarr; <strong>${amount}</strong>
							</span>
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
				<p>
					This will reset all next-month boosts to match your current month's committed values. Any
					changes you've made here will be lost.
				</p>
			</ConfirmDialog>
		</div>
	);
}
